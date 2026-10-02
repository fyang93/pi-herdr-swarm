import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { boardPath, boardSenders, MESSAGE_LIMIT, formatNote, post, readBoard } from "./board.ts";
import { availableName, deliver, sessionBinding, identity, list, projectRoot, requireHerdr, start, validateName } from "./herdr.ts";
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
  /** pi settings (global, overridden by project): { "swarm": { "maxAgents": 16 } }. Read at each spawn. */
  function maxAgents(): number {
    const value = (pi.getSettings() as { swarm?: { maxAgents?: unknown } }).swarm?.maxAgents ?? 16;
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("settings swarm.maxAgents must be a positive integer.");
    return value as number;
  }
  let project: string | undefined;
  const roots = new Map<string, string>();
  function path() {
    if (!project) throw new Error("Swarm project unavailable; check the session startup error.");
    return boardPath(project);
  }
  const name = (context: ExtensionContext) => identity(value => context.ui.notify(`This session is now named ${value}`, "info"));
  pi.on("session_start", async (_event, context) => {
    project = undefined;
    roots.clear();
    project = await projectRoot(context.cwd);
  });
  const runState = lifecycle(pi);

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
    description: "Start a fresh pi peer in a new pane with `task` as its first message (the role goes in the task), and return immediately. Its final reply comes back to you when it ends. With detach, nothing comes back. resume continues one of your ended runs with its context and configuration; only task and detach may accompany it.",
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
      const args = loadout(config, session);
      args.push("--swarm-name", peer, "--swarm-spawner", spawner, "--swarm-session", session);
      if (boundary) args.push("--swarm-boundary", boundary);
      let entry: string | undefined;
      let launched;
      try {
        launched = await start({
          name: peer, cwd: config.cwd, args, task: params.task, session, resume: params.resume !== undefined, maxAgents: maxAgents(),
          beforeStart: pane => { entry = runState.record({ name: peer, pane, session, boundary, snapshot: config, detach: !!params.detach }); },
        });
      } finally { if (entry) runState.launched(entry); }
      return textResult(`${peer} ${params.resume ? "resumed" : "started"} in ${launched.pane}. ${params.detach ? "Detached: nobody waits; its final reply stays in its session." : "When it ends, its final reply arrives in this session as a swarm_result message and a wake-up notice starts a new turn, so you can end this turn now."}`, { name: peer, pane: launched.pane, detached: !!params.detach, resumed: params.resume !== undefined });
    },
    renderCall(args, theme, context) {
      const title = args.resume ? theme.fg("toolTitle", theme.bold("resume ")) + theme.fg("accent", args.resume) : theme.fg("toolTitle", theme.bold("spawn ")) + theme.fg("accent", args.agent || "inherited") + theme.fg("dim", " → ") + theme.fg("accent", args.name || "…");
      return callView(title + theme.fg("dim", args.detach ? " · detached" : ""), args.task || "", context.expanded, theme);
    },
    renderResult: spawnResult,
  });
  pi.registerTool({
    name: "swarm_send", label: "Swarm send",
    description: "Without to: post a notice on the project board, readable by every agent for 24 hours; nobody is woken. With to: push the message (native herdr steer, text + Enter) to an exact name in any project, or to every named agent in this project matching a pattern with '*' anywhere (not the sender); nothing is stored. Each recipient is submitted/rejected/unknown with an error code; submitted means written to the terminal, not read. Never retries.",
    parameters: Type.Object({ message: Type.String(messageLimit), to: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, context) {
      requireHerdr();
      const from = await name(context);
      if (params.to === undefined) {
        const board = path();
        const note = await post(board, { from, message: params.message }, warning => context.ui.notify(warning, "warning"));
        return textResult(`posted · board only\nBoard: ${board}\nRetained until ${new Date(note.expires).toISOString()}.`, { board, note, deliveries: [], boardOnly: true });
      }
      const result = await deliver({ from, to: params.to, message: params.message }, { root: project!, roots });
      const failed = !!result.discovery || result.deliveries.some(d => d.status !== "submitted");
      const lines = result.deliveries.map(d => `${d.status} → ${d.to}${d.code ? ` [${d.code}]` : ""}${d.error ? `: ${d.error}` : ""}`);
      if (result.discovery) lines.push(`Recipient discovery ${result.discovery.status}${result.discovery.code ? ` [${result.discovery.code}]` : ""}: ${result.discovery.error}`);
      else if (!result.deliveries.length) lines.push("No matching named agents.");
      return textResult(`${result.deliveries.length} recipients\n${lines.join("\n")}`, { ...result, boardOnly: false }, failed);
    },
    renderCall(args, theme, context) {
      const title = args.to === undefined
        ? theme.fg("toolTitle", theme.bold("post")) + theme.fg("dim", " · board")
        : theme.fg("toolTitle", theme.bold("send")) + theme.fg("dim", " → ") + theme.fg("accent", args.to);
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
    description: "Read the project board: notices agents posted, newest first, kept 24 hours (20 default, 100 max). from is an exact name or a '*' pattern. Reading notifies nobody.",
    parameters: Type.Object({ from: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
    async execute(_id, params) {
      const board = path();
      const skipped: string[] = [];
      const notes = await readBoard(board, params, warning => { if (skipped.length < 100) skipped.push(warning); });
      return textResult([notes.map(note => formatNote(note)).join("\n\n") || "No notices.", ...skipped].join("\n\n"), { notes, skipped });
    },
    renderCall(args, theme, context) {
      return callView(theme.fg("toolTitle", theme.bold("board")) + theme.fg("dim", ` · from=${args.from || "*"} · limit=${args.limit ?? 20}`), "", context.expanded, theme);
    },
    renderResult: boardResult,
  });
  pi.registerMessageRenderer("swarm_result", (message, options, theme) => resultMessageView(String(message.content), message.details as any, options.expanded, theme));
  pi.registerMessageRenderer("swarm_notice", (message, options, theme) => noticeView(String(message.content), options.expanded, theme));
}
