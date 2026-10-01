import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { boardPath, DAY, MESSAGE_LIMIT, formatNote, readBoard } from "./board.ts";
import { availableName, identity, list, projectRoot, requireHerdr, send, start, validateName } from "./herdr.ts";
import { loadout, presets, presetCwd } from "./presets.ts";
import { lifecycle } from "./run.ts";
import { callView, spawnResult, sendResult, listResult, boardResult, noticeView } from "./ui.ts";

export { PENDING_COUNT_KEY } from "./run.ts";
const textResult = (text: string, details: unknown = undefined, isError = false) => ({ content: [{ type: "text" as const, text: text.length > 30_000 ? `${text.slice(0, 29_900)}\n… truncated; narrow the board filters or limit.` : text }], details, isError });
const messageLimit = { minLength: 1, maxLength: MESSAGE_LIMIT, description: "Up to 4000 characters. Longer bodies go in a file; send a summary and file path." };
const ttlSchema = Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 365 * DAY, description: "Retention in seconds; default 24 hours, not a task deadline." }));
const tagsSchema = Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 20 }));

export default function swarm(pi: ExtensionAPI) {
  let project: string | undefined;
  const roots = new Map<string, string>();
  function path() {
    if (!project) throw new Error("Swarm project unavailable; check the session startup error.");
    return boardPath(project);
  }
  const name = (context: ExtensionContext) => identity(value => context.ui.notify(`本会话已命名为 ${value}`, "info"));
  const requiredTools: string[] = JSON.parse(process.env.PI_SWARM_TOOLS || "[]");
  const missingTools = () => requiredTools.filter(tool => !pi.getAllTools().some(t => t.name === tool));
  pi.on("session_start", async (_event, context) => {
    project = undefined;
    roots.clear();
    project = await projectRoot(context.cwd);
    const missing = missingTools();
    if (missing.length) throw new Error(`Swarm tools unavailable in child: ${missing.join(", ")}. No fallback; task input will be rejected.`);
  });
  pi.on("input", (_event, context) => {
    const missing = missingTools();
    if (missing.length) {
      context.ui.notify(`Swarm tools unavailable in child: ${missing.join(", ")}. No fallback.`, "error");
      return { action: "handled" };
    }
  });
  const track = lifecycle(pi, path);

  pi.registerTool({
    name: "swarm_spawn", label: "Swarm spawn", executionMode: "sequential",
    description: "Start a named peer with a fresh session. Put its role in task; agent selects an optional preset. Inherit current model, thinking and tools unless overridden. Default: wait for this run's herdr binding to end; results are ordinary messages back to the spawner. detach=true: do not wait, final result is board-only. No third-party reply_to or cascading kills.",
    parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 48_000 }), agent: Type.Optional(Type.String({ minLength: 1 })), name: Type.Optional(Type.String()), model: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()), detach: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _update, context) {
      requireHerdr();
      path();
      const preset = params.agent === undefined ? undefined : presets(context.cwd, context.isProjectTrusted()).find(p => p.name === params.agent && !p.fields["disable-model-invocation"]);
      if (params.agent !== undefined && !preset) throw new Error(`Unknown or disabled preset ${params.agent}. Use swarm_list.`);
      const spawner = await name(context);
      const peer = validateName(params.name || availableName(preset?.name || "swarm", await list()));
      const cwd = presetCwd(preset, context.cwd, params.cwd);
      const parentDir = join(context.sessionManager.getSessionDir(), "swarm-runs");
      mkdirSync(parentDir, { recursive: true });
      const dir = mkdtempSync(join(parentDir, `${peer}-`));
      const settings = loadout(preset, dir, cwd, params.task, {
        model: context.model ? `${context.model.provider}/${context.model.id}` : undefined,
        thinking: pi.getThinkingLevel(), tools: pi.getActiveTools(),
      }, params.model);
      if (context.isProjectTrusted() && cwd === context.cwd) settings.args.push("--approve");
      const task = `You are ${peer}, a peer agent. Created by ${spawner}.\n` +
        `${settings.autoExit ? params.detach ? "Your final summary is persisted on your project's board, without notification.\n" : "Your final summary is persisted on your project's board and submitted to your spawner.\n" : "This preset stays open for further messages.\n"}` + settings.task;
      const launched = await start({ name: peer, cwd, args: settings.args, task, env: {
        PI_SWARM_NAME: peer, PI_SWARM_SPAWNER: params.detach ? "" : spawner,
        PI_SWARM_AUTO_EXIT: settings.autoExit ? "1" : "0", PI_SWARM_TOOLS: JSON.stringify(settings.tools),
        ...(process.env.PI_SWARM_BOARD !== undefined ? { PI_SWARM_BOARD: path() } : {}),
      } });
      const run = { ...launched, session: settings.session };
      if (!params.detach) track(run);
      return textResult(`${peer} started in ${run.pane}. ${params.detach ? "Detached; final result is board-only; not waiting." : "Waiting for this session binding to end."}`, { name: peer, pane: run.pane, detached: !!params.detach });
    },
    renderCall(args, theme, context) {
      return callView(theme.fg("toolTitle", theme.bold("spawn ")) + theme.fg("accent", args.agent || "inherited") + theme.fg("dim", " → ") + theme.fg("accent", args.name || "…") + theme.fg("dim", args.detach ? " · detached" : ""), args.task || "", context.expanded, theme);
    },
    renderResult: spawnResult,
  });
  pi.registerTool({
    name: "swarm_send", label: "Swarm send",
    description: "The only message-writing tool. Omit to: board only, no wakeup. Explicit to: persist first, then native herdr steer (text + Enter). Exact names may cross projects best-effort; '*' anywhere matches whole names only in the same canonical Git project, excluding sender/unnamed agents. No other glob syntax. Each recipient is submitted/rejected/unknown, with error code; submitted means terminal bytes written, not processed or read. Never automatically retry or rebroadcast. Shared storage is not confidential; envelope includes source board path.",
    parameters: Type.Object({ message: Type.String(messageLimit), to: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), tags: tagsSchema, ttl: ttlSchema }),
    async execute(_id, params, _signal, _update, context) {
      requireHerdr();
      const board = path();
      const result = await send(board, { ...params, from: await name(context) }, params.ttl, { root: project!, roots });
      const failed = !!result.discovery || result.deliveries.some(d => d.status !== "submitted");
      const text = result.boardOnly ? "posted · board only" : `${result.deliveries.length} recipients\n` +
        result.deliveries.map(d => `${d.status} → ${d.to}${d.code ? ` [${d.code}]` : ""}${d.error ? `: ${d.error}` : ""}`).join("\n") +
        (result.discovery ? `\nRecipient discovery ${result.discovery.status}${result.discovery.code ? ` [${result.discovery.code}]` : ""}: ${result.discovery.error}` : !result.deliveries.length ? "\nNo matching named agents." : "");
      return textResult(`${text}\nBoard: ${board}\nRetained until ${new Date(result.note.expires).toISOString()}.`, result, failed);
    },
    renderCall(args, theme, context) {
      const title = args.to === undefined ? theme.fg("toolTitle", theme.bold("send")) + theme.fg("dim", " · board only") : theme.fg("toolTitle", theme.bold("send")) + theme.fg("dim", " → ") + theme.fg("accent", args.to);
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
      const available = presets(context.cwd, context.isProjectTrusted()).filter(p => !p.fields["disable-model-invocation"]);
      return textResult(agents.map(a => `${a.name || "(unnamed)"} · ${a.agent_status || "unknown"} · ${a.pane_id}`).join("\n") +
        `\n\nPresets:\n${available.map(p => `${p.name}${p.fields.model ? ` [${p.fields.model}]` : ""} — ${p.description}`).join("\n")}`, { agents, presets: available.map(p => ({ name: p.name, description: p.description, model: p.fields.model ? String(p.fields.model) : undefined })) });
    },
    renderCall(_args, theme, context) { return callView(theme.fg("toolTitle", theme.bold("list")) + theme.fg("dim", " · agents + presets"), "", context.expanded, theme); },
    renderResult: listResult,
  });
  pi.registerTool({
    name: "swarm_board", label: "Swarm board",
    description: "Read shared unexpired project messages, newest first (20 default, 100 max; text capped at 30,000 characters). No writes, notifications or naming. Filter from/to/tag exactly; to matches the original target field, not a personal inbox or expanded group members. TTL is retention, not task cancellation or completion. Cross-project sends remain on the source board, not automatically on this one.",
    parameters: Type.Object({ from: Type.Optional(Type.String()), to: Type.Optional(Type.String()), tag: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
    async execute(_id, params) {
      const board = path();
      const notes = readBoard(board, params);
      return textResult(notes.map(note => formatNote(note, board)).join("\n\n") || "No unexpired messages.", { notes });
    },
    renderCall(args, theme, context) {
      return callView(theme.fg("toolTitle", theme.bold("board read")) + theme.fg("dim", ` · from=${args.from || "*"} · tag=${args.tag || "*"} · limit=${args.limit ?? 20}${args.to ? ` · to=${args.to}` : ""}`), "", context.expanded, theme);
    },
    renderResult: boardResult,
  });
  pi.registerMessageRenderer("swarm_notice", (message, options, theme) => noticeView(String(message.content), options.expanded, theme));
}
