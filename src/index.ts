import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { setImmediate as nextTick } from "node:timers/promises";
import { MESSAGE_LIMIT, availableName, currentPane, deliver, checkPiIntegration, sessionBinding, identity, list, projectRoot, reportTitle, requireHerdr, start, summary, validateName, messageText } from "./herdr.ts";
import { loadout, presets, requiredTools, snapshot, spawnPolicy, checkSpawn } from "./presets.ts";
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
  function projectScope() {
    if (!project) throw new Error("Swarm project unavailable; check the session startup error.");
    return project;
  }
  let registration = Promise.resolve();
  let activeContext: ExtensionContext | undefined;
  let startupAbort: AbortController | undefined;
  const named = (context: ExtensionContext) => (value: string) => context.ui.notify(`This session is now named ${value}`, "info");
  const name = async (context: ExtensionContext) => { await registration; return identity(named(context)); };
  // `pi --swarm-agent <preset>` starts any session as that preset, e.g. when a host launches it outside swarm_spawn.
  pi.registerFlag("swarm-agent", { type: "string", description: "Start this session as a swarm preset: its model, thinking and role." });
  pi.registerFlag("swarm-tools", { type: "string", description: "Internal: tools a swarm preset requires, activated at session start." });
  pi.registerFlag("swarm-can-spawn", { type: "string", description: "Internal: saved preset spawn permission (JSON boolean)." });
  pi.registerFlag("swarm-title", { type: "string", description: "Internal: spawned peer's role and task summary." });
  let titleReported = false;
  async function clearTitle() {
    if (!titleReported) return;
    await reportTitle();
    titleReported = false;
  }
  let role: string | undefined;
  let canSpawn = true;
  /** Activate a preset's required tools; one that does not become active (unregistered, hidden) is reported, not fatal. */
  function requireTools(names: string[], context: ExtensionContext) {
    const add = names.filter(name => !pi.getActiveTools().includes(name));
    if (add.length) pi.setActiveTools([...pi.getActiveTools(), ...add]);
    const missing = names.filter(name => !pi.getActiveTools().includes(name));
    if (missing.length) context.ui.notify(`swarm: required tools unavailable: ${missing.join(", ")}`, "warning");
  }
  pi.on("session_start", async (_event, context) => {
    activeContext = undefined;
    startupAbort?.abort();
    await registration;
    await clearTitle();
    activeContext = context;
    startupAbort = new AbortController();
    const signal = startupAbort.signal;
    requireTools(requiredTools(pi.getFlag("swarm-tools")), context);
    project = undefined;
    void checkPiIntegration(message => context.ui.notify(message, "warning"));
    project = await projectRoot(context.cwd);
    role = undefined;
    canSpawn = true;
    const agent = pi.getFlag("swarm-agent");
    const policy = pi.getFlag("swarm-can-spawn");
    if (policy !== undefined || (typeof agent === "string" && agent)) canSpawn = false; // fail closed on invalid role configuration
    const preset = typeof agent === "string" && agent ? presets(context.cwd, context.isProjectTrusted()).find(p => p.name === agent) : undefined;
    try {
      if (policy !== undefined) canSpawn = spawnPolicy(JSON.parse(String(policy)));
      if (typeof agent === "string" && agent) {
        if (!preset) throw new Error(`no preset named ${agent}`);
        const config = await snapshot(preset, context, pi.getThinkingLevel(), {});
        canSpawn = config.canSpawn ?? true;
        const [provider, ...id] = config.model.split("/");
        const model = context.modelRegistry.find(provider, id.join("/"));
        if (!model || !await pi.setModel(model)) throw new Error(`model ${config.model} unavailable`);
        pi.setThinkingLevel(config.thinking as Parameters<typeof pi.setThinkingLevel>[0]);
        role = config.prompt;
        requireTools(config.tools ?? [], context);
      }
    } catch (error) { canSpawn = false; try { context.ui.notify(`swarm: ${error instanceof Error ? error.message : error}`, "error"); } catch { /* session already replaced */ } }
    if (process.env.HERDR_ENV !== "1") return;
    // Do not block later session_start handlers: herdr's integration may register pi after us.
    registration = nextTick().then(async () => {
      if (activeContext !== context) return;
      try {
        await identity(named(context), typeof agent === "string" ? agent : undefined, signal);
        if (activeContext !== context) return;
        const launchedTitle = runState.deliversTo(context) && pi.getFlag("swarm-title");
        const title = typeof launchedTitle === "string" ? launchedTitle : preset && `${preset.name}${preset.description ? ` · ${preset.description.replace(/\s+/g, " ").trim()}` : ""}`;
        if (title) {
          titleReported = true; // clear even if the report's outcome is uncertain
          await reportTitle(title);
        }
      } catch (error) { if (activeContext === context) context.ui.notify(`swarm: ${String(error)}`, "warning"); }
    });
    if (context.mode !== "tui") await registration;
  });
  const runState = lifecycle(pi);
  pi.on("session_shutdown", async () => {
    activeContext = undefined;
    startupAbort?.abort();
    await registration;
    await clearTitle();
  });
  pi.on("before_agent_start", (event, context) => {
    const run = runState.deliversTo(context);
    // The peer cannot see how its run ends otherwise; without this it answers a late message with only an addendum.
    const delivery = run && `You are ${run.name}, spawned by ${run.spawner}. When you stop with nothing pending, your session ends and your last reply is delivered to ${run.spawner} as your result. Make that reply complete on its own: after answering a later message, restate the whole result, not only what changed.`;
    const discovery = process.env.HERDR_ENV === "1" && "Use swarm_list to discover your name and other online agents' roles/tasks, status and panes. Names are session handles: swarm_spawn creates new peers; swarm_send talks to existing names, continuing your archived ended peers when spawning is allowed. Your spawned names stay bound to their saved sessions; another session occupying the same global name is rejected. Roles/tasks are herdr pane titles, not a separate registry.";
    const added = [role, delivery, discovery].filter(Boolean).join("\n\n");
    return added ? { systemPrompt: `${event.systemPrompt}\n\n${added}` } : undefined;
  });

  type History = ReturnType<typeof runState.history>;
  /** Restore an ended run of ours: same session and saved configuration; the next reply follows `boundary`. */
  async function prepareResume(peer: string, history: History, known: string) {
    const previous = history.get(peer);
    const saved = previous?.snapshot;
    if (!previous?.session || !saved?.model || !saved.thinking || !saved.cwd) {
      throw new Error(`Cannot resume ${peer}: snapshot/session/cwd missing. ${known}`);
    }
    validateName(peer);
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
    if (history.has(peer)) throw new Error(`${peer} was already spawned; use swarm_send to talk to it. ${known}`);
    const config = await snapshot(preset, context, pi.getThinkingLevel(), params);
    const runsDir = join(context.sessionManager.getSessionDir(), "swarm-runs");
    mkdirSync(runsDir, { recursive: true });
    const session = join(await realpath(mkdtempSync(join(runsDir, `${peer}-`))), "session.jsonl");
    return { peer, config, session, boundary: null as string | null };
  }

  async function launch(prepared: Awaited<ReturnType<typeof prepareSpawn>>, task: string, spawner: string, history: History, resume = false) {
    const { peer, config, session, boundary } = prepared;
    const args = loadout(config, session);
    args.push("--swarm-name", peer, "--swarm-spawner", spawner, "--swarm-session", session, "--swarm-title", `${config.preset || "peer"} · ${summary(task)}`);
    if (boundary) args.push("--swarm-boundary", boundary);
    let entry: string | undefined;
    try {
      return await start({
        name: peer, cwd: config.cwd, args, task, session, resume, maxAgents: maxAgents(), near: [...history.values()].map(run => run.session),
        beforeStart: pane => { entry = runState.record({ name: peer, pane, session, boundary, snapshot: config }); },
      });
    } finally { if (entry) runState.launched(entry); }
  }

  pi.registerTool({
    name: "swarm_spawn", label: "Swarm spawn", executionMode: "sequential",
    description: "Start a fresh pi peer in a new pane with `task` as its first message, and return immediately. It stays running while its task runs, then exits and returns its final reply. agent selects a preset from swarm_list. Use swarm_send to communicate during the task. Close its pane to stop it. This tool only creates new peers; use swarm_send for existing names.",
    parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 48_000 }), agent: Type.Optional(Type.String({ minLength: 1, description: "Preset name from swarm_list." })), name: Type.Optional(Type.String()), model: Type.Optional(Type.String({ minLength: 1 })), cwd: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, context) {
      requireHerdr();
      projectScope();
      if (!context.sessionManager.getSessionFile()) throw new Error("swarm_spawn requires a persistent pi session.");
      const spawner = await name(context);
      const history = runState.history();
      const known = `Known names: ${[...history.keys()].join(", ") || "(none)"}`;
      checkSpawn(canSpawn);
      const prepared = await prepareSpawn(params, history, known, context);
      const launched = await launch(prepared, params.task, spawner, history);
      return textResult(`${prepared.peer} started in ${launched.pane}. When it ends, its final reply arrives in this session as a single swarm_result message, so you can end this turn now.`, { name: prepared.peer, pane: launched.pane });
    },
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold("spawn ")) + theme.fg("accent", args.agent || "inherited") + theme.fg("dim", " → ") + theme.fg("accent", args.name || "…");
      return callView(title, args.task || "", context.expanded, theme);
    },
    renderResult: spawnResult,
  });
  pi.registerTool({
    name: "swarm_send", label: "Swarm send", executionMode: "sequential",
    description: "Send a message to named peers. Call this tool directly, not as a shell command. `to` is an exact name or an array of exact names; each recipient's submission result is reported separately. No wildcards or broadcasts. For your spawn history, an online name must still bind to that run's session; reject names occupied by another session or with unknown bindings. If herdr reports agent_not_found for your archived ended peer in spawn history, continue its session with this message and report resumed, subject to can-spawn and concurrency limits. Live, pending or unknown run state cannot be resumed; other rejection reasons are unchanged and uncertain submissions are never retried. Set wait:true to stop this turn and keep this session open until a submitted or resumed recipient replies via swarm_send or swarm_result. With multiple recipients, the first reply resumes you. Call directly, not inside scripts, when using wait:true.",
    parameters: Type.Object({ message: Type.String(messageLimit), to: Type.Union([Type.String({ minLength: 1, maxLength: 32, pattern: "^[a-z][a-z0-9_-]{0,31}$" }), Type.Array(Type.String({ minLength: 1, maxLength: 32, pattern: "^[a-z][a-z0-9_-]{0,31}$" }), { minItems: 1 })]), wait: Type.Optional(Type.Boolean({ description: "Stop and wait for a recipient's reply; do not auto-exit." })) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, context) {
      requireHerdr();
      if (params.wait && _id.includes("/")) throw new Error("wait:true must be called directly, not from another tool.");
      const from = await name(context);
      const history = runState.history();
      const result = await deliver({ from, to: params.to, message: params.message, wait: params.wait, sessions: new Map([...history].map(([name, run]) => [name, run.session])) });
      for (const delivery of result.deliveries) {
        if (delivery.status === "rejected" && delivery.code === "agent_not_found" && history.has(delivery.to)) {
          const previous = history.get(delivery.to)!;
          try {
            checkSpawn(canSpawn);
            const prepared = await prepareResume(delivery.to, history, `Known names: ${[...history.keys()].join(", ")}`);
            await launch(prepared, messageText(from, delivery.to, params.message, params.wait), from, history, true);
            delivery.status = "resumed";
            delete delivery.code;
            delete delivery.error;
          } catch (error) {
            // A recorded launch may have submitted its task: retain uncertainty, never replay it.
            delivery.status = runState.history().get(delivery.to)?.entryId !== previous.entryId ? "unknown" : "rejected";
            delivery.error = String(error);
          }
        }
      }
      const failed = result.deliveries.some(d => d.status !== "submitted" && d.status !== "resumed");
      const lines = result.deliveries.map(d => `${d.status} → ${d.to}${d.code ? ` [${d.code}]` : ""}${d.error ? `: ${d.error}` : ""}`);
      const wait = !!params.wait && result.deliveries.some(d => d.status === "submitted" || d.status === "resumed");
      return { ...textResult(`${result.deliveries.length} recipients\n${lines.join("\n")}${wait ? "\nStop and wait for a recipient's reply via swarm_send or swarm_result." : ""}`, { ...result, wait }, failed), ...(wait ? { terminate: true } : {}) };
    },
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold("send")) + theme.fg("dim", " → ") + theme.fg("accent", Array.isArray(args.to) ? args.to.join(", ") : args.to || "…") + (args.wait ? theme.fg("dim", " · waiting for reply") : "");
      return callView(title, args.message || "", context.expanded, theme);
    },
    renderResult: sendResult,
  });
  pi.registerTool({
    name: "swarm_list", label: "Swarm list",
    description: "Show your name, online agents with roles/tasks (pane titles), status, panes, and available presets.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, context) {
      requireHerdr();
      await registration;
      const agents = await list();
      const available = presets(context.cwd, context.isProjectTrusted());
      const agentLines = agents.map(a => `${a.name || "(unnamed)"}${a.title ? ` · ${a.title}` : ""} · ${a.agent_status || "unknown"} · ${a.pane_id}`);
      const presetLines = available.map(p => `${p.name}${p.fields.model ? ` [${p.fields.model}]` : ""} — ${p.description}`);
      const pane = (await currentPane()).pane_id;
      const self = agents.find(a => a.pane_id === pane)?.name;
      return textResult([self && `Self: ${self}`, agentLines.join("\n") || "No online agents.", ...(presetLines.length ? ["Presets:", ...presetLines] : [])].filter(Boolean).join("\n\n"), { agents, presets: available.map(p => ({ name: p.name, description: p.description, model: p.fields.model ? String(p.fields.model) : undefined })), self });
    },
    renderCall(_args, theme, context) { return callView(theme.fg("toolTitle", theme.bold("list")) + theme.fg("dim", " · agents + presets"), "", context.expanded, theme); },
    renderResult: listResult,
  });
  pi.registerMessageRenderer("swarm_result", (message, options, theme) => resultMessageView(String(message.content), message.details as any, options.expanded, theme));
  pi.registerMessageRenderer("swarm_notice", (message, options, theme) => noticeView(String(message.content), options.expanded, theme));
}
