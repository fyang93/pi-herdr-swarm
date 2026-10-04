import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { MESSAGE_LIMIT, availableName, deliver, ensurePiIntegration, sessionBinding, identity, list, projectRoot, requireHerdr, start, validateName } from "./herdr.ts";
import { loadout, presets, snapshot } from "./presets.ts";
import { lifecycle, readSession } from "./run.ts";
import { callView, spawnResult, sendResult, listResult, noticeView, resultMessageView } from "./ui.ts";

export { PENDING_COUNT_KEY } from "./run.ts";
function textResult(text: string, details: unknown = undefined, isError = false) {
  if (text.length > 30_000) text = `${text.slice(0, 29_900)}\n… truncated.`;
  return { content: [{ type: "text" as const, text }], details, isError };
}
const messageLimit = { minLength: 1, maxLength: MESSAGE_LIMIT, description: "Up to 4000 characters." };

export default function swarm(pi: ExtensionAPI) {
  /** pi settings (global, overridden by project): { "swarm": { "maxAgents": 16 } }. Read at each spawn. */
  function maxAgents(): number {
    const value = (pi.getSettings() as { swarm?: { maxAgents?: unknown } }).swarm?.maxAgents ?? 16;
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("settings swarm.maxAgents must be a positive integer.");
    return value as number;
  }
  let project: string | undefined;
  const roots = new Map<string, string>();
  function projectScope() {
    if (!project) throw new Error("Swarm project unavailable; check the session startup error.");
    return { root: project, roots };
  }
  const name = (context: ExtensionContext) => identity(value => context.ui.notify(`This session is now named ${value}`, "info"));
  // `pi --swarm-agent <preset>` starts any session as that preset, e.g. when a host launches it outside swarm_spawn.
  pi.registerFlag("swarm-agent", { type: "string", description: "Start this session as a swarm preset: its model, thinking and role." });
  let role: string | undefined;
  pi.on("session_start", async (_event, context) => {
    const settings = pi.getSettings() as { swarm?: { autoEnableCodemode?: unknown }; defaultTools?: string[] };
    if (settings.swarm?.autoEnableCodemode !== false && !settings.defaultTools?.includes("-codemode") && pi.getAllTools().some(tool => tool.name === "codemode") && !pi.getActiveTools().includes("codemode")) {
      pi.setActiveTools([...pi.getActiveTools(), "codemode"]);
    }
    project = undefined;
    roots.clear();
    void ensurePiIntegration(message => context.ui.notify(message, "warning"));
    project = await projectRoot(context.cwd);
    const agent = pi.getFlag("swarm-agent");
    if (typeof agent !== "string" || !agent) return;
    try {
      const preset = presets(context.cwd, context.isProjectTrusted()).find(p => p.name === agent);
      if (!preset) throw new Error(`no preset named ${agent}`);
      const config = await snapshot(preset, context, pi.getThinkingLevel(), {});
      const [provider, ...id] = config.model.split("/");
      const model = context.modelRegistry.find(provider, id.join("/"));
      if (!model || !await pi.setModel(model)) throw new Error(`model ${config.model} unavailable`);
      pi.setThinkingLevel(config.thinking as Parameters<typeof pi.setThinkingLevel>[0]);
      role = config.prompt;
    } catch (error) { try { context.ui.notify(`swarm: ${error instanceof Error ? error.message : error}`, "error"); } catch { /* session already replaced */ } }
  });
  pi.on("before_agent_start", event => role ? { systemPrompt: `${event.systemPrompt}\n\n${role}` } : undefined);
  const runState = lifecycle(pi);

  type History = ReturnType<typeof runState.history>;
  /** Restore an ended run of ours: same session and saved configuration; the next reply follows `boundary`. */
  async function prepareResume(params: { resume?: string; agent?: string; model?: string; cwd?: string; name?: string }, history: History, known: string) {
    if ([params.agent, params.model, params.cwd, params.name].some(v => v !== undefined)) throw new Error("resume accepts only task.");
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
      if (!runState.archived(previous.entryId)) throw new Error("previous result is not archived");
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
    const peer = validateName(params.name ?? availableName(preset?.name || "peer", await list(), history.keys()));
    if (history.has(peer)) throw new Error(`${peer} was already spawned; use resume explicitly. ${known}`);
    const config = await snapshot(preset, context, pi.getThinkingLevel(), params);
    const runsDir = join(context.sessionManager.getSessionDir(), "swarm-runs");
    mkdirSync(runsDir, { recursive: true });
    const session = join(await realpath(mkdtempSync(join(runsDir, `${peer}-`))), "session.jsonl");
    return { peer, config, session, boundary: null as string | null };
  }

  pi.registerTool({
    name: "swarm_spawn", label: "Swarm spawn", executionMode: "sequential",
    description: "Start a fresh pi peer in a new pane with `task` as its first message, and return immediately. It stays running while its task runs, then exits and returns its final reply. Use swarm_send to communicate during the task. Close its pane to stop it. resume continues one of your ended runs with its context and configuration; only task may accompany it.",
    parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 48_000 }), resume: Type.Optional(Type.String({ minLength: 1, description: "Name of a peer this session spawned earlier (not a session path)." })), agent: Type.Optional(Type.String({ minLength: 1 })), name: Type.Optional(Type.String()), model: Type.Optional(Type.String({ minLength: 1 })), cwd: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, context) {
      requireHerdr();
      projectScope();
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
          name: peer, cwd: config.cwd, args, task: params.task, session, resume: params.resume !== undefined, maxAgents: maxAgents(), near: [...history.keys()],
          beforeStart: pane => { entry = runState.record({ name: peer, pane, session, boundary, snapshot: config }); },
        });
      } finally { if (entry) runState.launched(entry); }
      return textResult(`${peer} ${params.resume ? "resumed" : "started"} in ${launched.pane}. When it ends, its final reply arrives in this session as a single swarm_result message, so you can end this turn now.`, { name: peer, pane: launched.pane, resumed: params.resume !== undefined });
    },
    renderCall(args, theme, context) {
      const title = args.resume ? theme.fg("toolTitle", theme.bold("resume ")) + theme.fg("accent", args.resume) : theme.fg("toolTitle", theme.bold("spawn ")) + theme.fg("accent", args.agent || "inherited") + theme.fg("dim", " → ") + theme.fg("accent", args.name || "…");
      return callView(title, args.task || "", context.expanded, theme);
    },
    renderResult: spawnResult,
  });
  pi.registerTool({
    name: "swarm_send", label: "Swarm send",
    description: "Send a message to another agent for updates, questions, decisions, or follow-up work. Call this tool directly, not as a shell command. `to` accepts an exact name or a name pattern using `*` as a wildcard; wildcard matches stay within this project and exclude the sender. Use '*' to announce to all other named agents in this project.",
    parameters: Type.Object({ message: Type.String(messageLimit), to: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, context) {
      requireHerdr();
      const from = await name(context);
      const result = await deliver({ from, to: params.to, message: params.message }, projectScope());
      const failed = !!result.discovery || result.deliveries.some(d => d.status !== "submitted");
      const lines = result.deliveries.map(d => `${d.status} → ${d.to}${d.code ? ` [${d.code}]` : ""}${d.error ? `: ${d.error}` : ""}`);
      if (result.discovery) lines.push(`Recipient discovery ${result.discovery.status}${result.discovery.code ? ` [${result.discovery.code}]` : ""}: ${result.discovery.error}`);
      else if (!result.deliveries.length) lines.push("No matching named agents.");
      return textResult(`${result.deliveries.length} recipients\n${lines.join("\n")}`, result, failed);
    },
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold("send")) + theme.fg("dim", " → ") + theme.fg("accent", args.to || "…");
      return callView(title, args.message || "", context.expanded, theme);
    },
    renderResult: sendResult,
  });
  pi.registerTool({
    name: "swarm_list", label: "Swarm list",
    description: "Online agents (name, status, pane) and available presets.",
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
  pi.registerMessageRenderer("swarm_result", (message, options, theme) => resultMessageView(String(message.content), message.details as any, options.expanded, theme));
  pi.registerMessageRenderer("swarm_notice", (message, options, theme) => noticeView(String(message.content), options.expanded, theme));
}
