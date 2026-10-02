import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { boardPath, boardSenders, MESSAGE_LIMIT, formatNote, readBoard } from "./board.ts";
import { availableName, sessionBinding, identity, list, projectRoot, requireHerdr, send, start, validateName } from "./herdr.ts";
import { loadout, presets, snapshot } from "./presets.ts";
import { lifecycle, readSession } from "./run.ts";
import { callView, spawnResult, sendResult, listResult, boardResult, noticeView, resultMessageView } from "./ui.ts";

export { PENDING_COUNT_KEY } from "./run.ts";
function textResult(text: string, details: unknown = undefined, isError = false) {
  if (text.length > 30_000) text = `${text.slice(0, 29_900)}\n… truncated; narrow the board filters or limit.`;
  return { content: [{ type: "text" as const, text }], details, isError };
}
const messageLimit = { minLength: 1, maxLength: MESSAGE_LIMIT, description: "Up to 4000 characters. Longer bodies go in a file; send a summary and file path." };

export default function swarm(pi: ExtensionAPI) {
  const maxValue = process.env.PI_SWARM_MAX_AGENTS ?? "16";
  const maxAgents = Number(maxValue);
  if (!/^[1-9]\d*$/.test(maxValue) || !Number.isSafeInteger(maxAgents)) throw new Error("PI_SWARM_MAX_AGENTS must be a positive integer.");
  let project: string | undefined;
  const roots = new Map<string, string>();
  function path() {
    if (!project) throw new Error("Swarm project unavailable; check the session startup error.");
    return boardPath(project);
  }
  const name = (context: ExtensionContext) => identity(value => context.ui.notify(`本会话已命名为 ${value}`, "info"));
  pi.on("session_start", async (_event, context) => {
    project = undefined;
    roots.clear();
    project = await projectRoot(context.cwd);
  });
  const runState = lifecycle(pi, path);

  type History = ReturnType<typeof runState.history>;
  /** Restore an ended run of ours: same session and saved configuration; the next reply follows `boundary`. */
  async function prepareResume(params: { resume?: string; agent?: string; model?: string; cwd?: string; name?: string }, history: History, known: string) {
    if ([params.agent, params.model, params.cwd, params.name].some(v => v !== undefined)) throw new Error("resume accepts only task and optional detach.");
    const previous = history.get(params.resume!);
    const saved = previous?.snapshot;
    if (!previous?.session || !saved?.model || !saved.thinking || !saved.cwd) {
      throw new Error(`Cannot resume ${params.resume}: snapshot/session/cwd missing. ${known}`);
    }
    const peer = validateName(params.resume!);
    try {
      const agents = await list();
      if (runState.pending(previous.session) || agents.some(a => a.name === peer) || sessionBinding(agents, previous.session)) {
        throw new Error("run is live, pending or its online state is unknown");
      }
      if (!previous.detach && !runState.archived(previous.entryId)) throw new Error("previous result is not archived");
      const session = await realpath(previous.session);
      return { peer, config: { ...saved, cwd: await realpath(saved.cwd) }, session, boundary: readSession(session).getLeafId() };
    } catch (error) {
      throw new Error(`Cannot resume ${peer}: ${String(error)}; session: ${previous.session}; cwd: ${saved.cwd}. ${known}`);
    }
  }
  /** A fresh peer with its own session file under this session's directory. */
  async function prepareSpawn(params: { agent?: string; name?: string; model?: string; cwd?: string }, history: History, known: string, context: ExtensionContext) {
    const preset = params.agent === undefined ? undefined : presets(context.cwd, context.isProjectTrusted()).find(p => p.name === params.agent);
    if (params.agent !== undefined && !preset) throw new Error(`Unknown preset ${params.agent}. Use swarm_list.`);
    const taken = [...history.keys(), ...await boardSenders(path())];
    const peer = validateName(params.name ?? availableName(preset?.name || "peer", await list(), taken));
    if (history.has(peer)) throw new Error(`${peer} was already spawned; use resume explicitly. ${known}`);
    const config = await snapshot(preset, context, pi.getThinkingLevel(), params);
    const runsDir = join(context.sessionManager.getSessionDir(), "swarm-runs");
    mkdirSync(runsDir, { recursive: true });
    const session = join(await realpath(mkdtempSync(join(runsDir, `${peer}-`))), "session.jsonl");
    return { peer, config, session, boundary: null as string | null };
  }

  pi.registerTool({
    name: "swarm_spawn", label: "Swarm spawn", executionMode: "sequential",
    description: "Start a fresh pi peer with optional configuration preset; role belongs in task. Inherit model/thinking, not history or tool restrictions. Auto names avoid online names, your historical names and names on the retained board. resume restores your ended peer's session and saved configuration; only task/detach may accompany resume. All spawned peers auto-exit unless interrupted; default waits and reads the final reply from their session. detach skips waiting and leaves only a board result. Send never resumes peers.",
    parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 48_000 }), resume: Type.Optional(Type.String({ minLength: 1 })), agent: Type.Optional(Type.String({ minLength: 1 })), name: Type.Optional(Type.String()), model: Type.Optional(Type.String({ minLength: 1 })), cwd: Type.Optional(Type.String({ minLength: 1 })), detach: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, context) {
      requireHerdr();
      path();
      if (!context.sessionManager.getSessionFile()) throw new Error("swarm_spawn requires a persistent pi session.");
      const spawner = await name(context);
      const history = runState.history();
      const known = `Known names: ${[...history.keys()].join(", ") || "(none)"}`;
      const { peer, config, session, boundary } = params.resume !== undefined
        ? await prepareResume(params, history, known)
        : await prepareSpawn(params, history, known, context);
      const settings = loadout(config, session, params.task);
      if (params.resume === undefined) {
        const delivery = params.detach ? "会写进留言板" : `会作为结果交给 ${spawner}`;
        settings.task = `你是 ${peer}，由 ${spawner} 派出。你的最后一条回复${delivery}，之后你会自动退出。\n\n${settings.task}`;
      }
      settings.args.push("--swarm-name", peer, "--swarm-spawner", spawner, "--swarm-session", session);
      if (boundary) settings.args.push("--swarm-boundary", boundary);
      if (params.detach) settings.args.push("--swarm-detach");
      let entry: string | undefined;
      let launched;
      try {
        launched = await start({
          name: peer, cwd: config.cwd, args: settings.args, task: settings.task, session, resume: params.resume !== undefined, maxAgents, env: {},
          beforeStart: pane => { entry = runState.record({ name: peer, pane, session, boundary, snapshot: config, detach: !!params.detach }); },
        });
      } finally { if (entry) runState.launched(entry); }
      return textResult(`${peer} ${params.resume ? "resumed" : "started"} in ${launched.pane}. ${params.detach ? "Detached: its final reply goes to the board only; nothing comes back here." : "When it ends, its final reply arrives in this session as a swarm_result message, followed by a wake-up notice."}`, { name: peer, pane: launched.pane, detached: !!params.detach, resumed: params.resume !== undefined });
    },
    renderCall(args, theme, context) {
      const title = args.resume ? theme.fg("toolTitle", theme.bold("resume ")) + theme.fg("accent", args.resume) : theme.fg("toolTitle", theme.bold("spawn ")) + theme.fg("accent", args.agent || "inherited") + theme.fg("dim", " → ") + theme.fg("accent", args.name || "…");
      return callView(title + theme.fg("dim", args.detach ? " · detached" : ""), args.task || "", context.expanded, theme);
    },
    renderResult: spawnResult,
  });
  pi.registerTool({
    name: "swarm_send", label: "Swarm send",
    description: "The only message-writing tool. Omit to: board only, no wakeup. Explicit to: persist first, then native herdr steer (text + Enter). Exact names may cross projects best-effort; '*' anywhere matches whole names only in the same canonical Git project, excluding sender/unnamed agents. No other glob syntax. Each recipient is submitted/rejected/unknown, with error code; submitted means terminal bytes written, not processed or read. Never automatically retry or rebroadcast. Shared storage is not confidential.",
    parameters: Type.Object({ message: Type.String(messageLimit), to: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, context) {
      requireHerdr();
      const board = path();
      const result = await send(board, { ...params, from: await name(context) }, { root: project!, roots }, warning => context.ui.notify(warning, "warning"));
      const failed = !!result.discovery || result.deliveries.some(d => d.status !== "submitted");
      const text = result.boardOnly ? "posted · board only" : `${result.deliveries.length} recipients\n` +
        result.deliveries.map(d => `${d.status} → ${d.to}${d.code ? ` [${d.code}]` : ""}${d.error ? `: ${d.error}` : ""}`).join("\n") +
        (result.discovery ? `\nRecipient discovery ${result.discovery.status}${result.discovery.code ? ` [${result.discovery.code}]` : ""}: ${result.discovery.error}` : !result.deliveries.length ? "\nNo matching named agents." : "");
      return textResult(`${text}\nBoard: ${board}\nRetained until ${new Date(result.note.expires).toISOString()}.`, result, failed);
    },
    renderCall(args, theme, context) {
      const title = args.to === undefined ? theme.fg("toolTitle", theme.bold("posted")) + theme.fg("dim", " · board only") : theme.fg("toolTitle", theme.bold("send")) + theme.fg("dim", " → ") + theme.fg("accent", args.to);
      return callView(title, args.message || "", context.expanded, theme);
    },
    renderResult: sendResult,
  });
  pi.registerTool({
    name: "swarm_list", label: "Swarm list",
    description: "Read current herdr agents (name, status, pane) and optional presets. Does not name this session. Unlisted/unknown is not proof of success or a crash.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, context) {
      requireHerdr();
      const agents = await list();
      const available = presets(context.cwd, context.isProjectTrusted());
      return textResult(agents.map(a => `${a.name || "(unnamed)"} · ${a.agent_status || "unknown"} · ${a.pane_id}`).join("\n") +
        `\n\nPresets:\n${available.map(p => `${p.name}${p.fields.model ? ` [${p.fields.model}]` : ""} — ${p.description}`).join("\n")}`, { agents, presets: available.map(p => ({ name: p.name, description: p.description, model: p.fields.model ? String(p.fields.model) : undefined })) });
    },
    renderCall(_args, theme, context) { return callView(theme.fg("toolTitle", theme.bold("list")) + theme.fg("dim", " · agents + presets"), "", context.expanded, theme); },
    renderResult: listResult,
  });
  pi.registerTool({
    name: "swarm_board", label: "Swarm board",
    description: "Read shared unexpired project messages, newest first (20 default, 100 max; text capped at 30,000 characters). No writes, notifications or naming. Filter from/to exactly; to matches the original target field, not a personal inbox or expanded group members. TTL is retention, not task cancellation or completion. Cross-project sends remain on the source board, not automatically on this one.",
    parameters: Type.Object({ from: Type.Optional(Type.String()), to: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
    async execute(_id, params) {
      const board = path();
      const skipped: string[] = [];
      const notes = await readBoard(board, params, warning => { if (skipped.length < 100) skipped.push(warning); });
      return textResult([notes.map(note => formatNote(note)).join("\n\n") || "No unexpired messages.", ...skipped].join("\n\n"), { notes, skipped });
    },
    renderCall(args, theme, context) {
      return callView(theme.fg("toolTitle", theme.bold("board read")) + theme.fg("dim", ` · from=${args.from || "*"} · to=${args.to || "*"} · limit=${args.limit ?? 20}`), "", context.expanded, theme);
    },
    renderResult: boardResult,
  });
  pi.registerMessageRenderer("swarm_result", (message, options, theme) => resultMessageView(String(message.content), message.details as any, options.expanded, theme));
  pi.registerMessageRenderer("swarm_notice", (message, options, theme) => noticeView(String(message.content), options.expanded, theme));
}
