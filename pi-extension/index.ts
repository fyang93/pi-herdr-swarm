import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { mkdirSync, mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { boardPath, DAY, MESSAGE_LIMIT, formatNote, post, readBoard } from "./board.ts";
import { availableName, herdr, identity, list, requireHerdr, send, start, validateName, type LiveAgent } from "./herdr.ts";
import { loadout, profiles, profileCwd } from "./profiles.ts";
import { alive, canExit, finalSummary, readJSON, writeJSON, resultStamp, type Exit, type Run } from "./lifecycle.ts";
import { frame, agentRow, callView, renderToolResult, noticeView } from "./ui.ts";

const textResult = (text: string, details: unknown = undefined, isError = false) => ({ content: [{ type: "text" as const, text: text.length > 30_000 ? `${text.slice(0, 29_900)}\n… truncated; narrow the board filters or limit.` : text }], details, isError });
export const PENDING_COUNT_KEY = Symbol.for("pi-herdr-swarm/pending-count");
const messageLimit = { minLength: 1, maxLength: MESSAGE_LIMIT, description: "Up to 4000 characters. Longer bodies go in a file; send a summary and file path." };
const ttlSchema = Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 365 * DAY, description: "Lifetime in seconds; default 24 hours." }));
const tagsSchema = Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 20 }));

export default function swarm(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let closing = false;
  let active = false;
  let last: any;
  let outcome = "completed";
  let finished = false;
  let inputVersion = 0;
  const runs = new Map<string, Run>();
  let statuses: LiveAgent[] = [];
  const autoExit = process.env.PI_SWARM_AUTO_EXIT === "1";
  const runtimeDir = process.env.PI_SWARM_RUN;
  const spawner = process.env.PI_SWARM_SPAWNER;
  const ownName = process.env.PI_SWARM_NAME;
  const pendingCount = () => runs.size;
  (globalThis as any)[PENDING_COUNT_KEY] = pendingCount;

  function widget() {
    if (ctx?.mode !== "tui") return;
    ctx.ui.setWidget("swarm", runs.size ? (_tui, theme) => frame(`Swarm · ${runs.size} pending`, [...runs.values()].map(run => {
      const agent = statuses.find(a => a.name === run.name);
      return agentRow({ name: run.name, agent_status: agent?.agent_status || "unlisted", pane_id: agent?.pane_id || run.pane }, theme);
    }), theme) : undefined);
  }
  async function notice(text: string) {
    await pi.sendMessage({ customType: "swarm_notice", content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" });
  }
  async function finish(context: ExtensionContext) {
    if (!active || closing || finished || !context.isIdle() || !canExit(autoExit, last, outcome, context.hasPendingMessages(), runs.size)) return;
    closing = true;
    const version = inputVersion;
    try {
      if (!ownName || !spawner || !runtimeDir) throw new Error("Missing swarm launch identity.");
      const result = await send(boardPath(context.cwd), { from: ownName, to: spawner, message: finalSummary(last, context.sessionManager.getSessionFile() || join(runtimeDir, "session.jsonl")), kind: "result", tags: ["result", ...(outcome === "error" ? ["error"] : [])] });
      // Input can arrive while herdr is submitting the result. Do not discard it.
      if (version !== inputVersion || context.hasPendingMessages() || !context.isIdle()) return;
      writeJSON(join(runtimeDir, "exit.json"), { type: outcome === "error" ? "error" : "done", notified: result.deliveries.every(d => d.submitted), resultCreated: result.note.created } satisfies Exit);
      finished = true;
      context.shutdown();
    } catch (error) {
      // A failed board write must not lose the final result by exiting.
      context.ui.notify(`Swarm completion not persisted; session kept open: ${String(error)}`, "error");
    } finally {
      closing = false;
      if (version !== inputVersion && active && context.isIdle()) queueMicrotask(() => void finish(context));
    }
  }
  async function poll() {
    if (!ctx || polling) return;
    polling = true;
    const current = ctx;
    try {
      const agents = await list();
      if (!active || ctx !== current) return;
      statuses = agents;
      for (const run of runs.values()) {
        const exit = readJSON(join(run.dir, "exit.json")) as Exit | undefined;
        const dead = alive(readJSON(join(run.dir, "runtime.json"))?.pid) === false;
        if (!exit && !dead) {
          if (!agents.some(a => a.name === run.name) && !run.warned) {
            run.warned = true;
            await notice(`${run.name} is no longer listed by herdr. This does not prove completion or a crash; still waiting for an exit/result. Pane: ${run.pane}.`);
          }
          continue;
        }
        const result = readBoard(boardPath(current.cwd), { from: run.name, to: ownName || await identity(), since: run.started, tag: "result", limit: 1 })[0];
        const consumed = !!result && (run.consumed ?? 0) >= (exit?.resultCreated ?? result.created);
        // Allow the just-submitted terminal input to arrive; no replay to herdr.
        if (!consumed && (current.hasPendingMessages() || (result && Date.now() - result.created < 2000))) continue;
        runs.delete(run.name);
        pi.appendEntry("swarm_resolved", { name: run.name });
        if (!result) await notice(`${run.name} exited (${exit?.type ?? "process exited without marker"}) without an unexpired result; outcome unknown, not success or proof of a crash. Check its pane ${run.pane}; disappearance alone was not used as proof.`);
        else if (!consumed) await notice(`Recovered from the shared board:\n${formatNote(result)}`);
        // Peers outlive their spawner. Do not close their panes or kill them on parent shutdown.
      }
      widget();
      await finish(current);
    } catch (error) {
      if (current.mode === "tui") current.ui.setStatus("swarm", `swarm: ${String(error)}`);
    } finally { polling = false; }
  }

  pi.on("session_start", (_event, context) => {
    clearInterval(timer);
    ctx = context;
    (globalThis as any)[PENDING_COUNT_KEY] = pendingCount;
    active = true;
    last = undefined;
    outcome = "completed";
    finished = false;
    runs.clear();
    for (const entry of context.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "swarm_spawn") { const run = entry.data as Run; runs.set(run.name, { ...run, consumed: undefined, warned: false }); }
      if (entry.type === "custom" && entry.customType === "swarm_resolved") runs.delete((entry.data as any).name);
      if (entry.type === "custom" && entry.customType === "swarm_received") { const data = entry.data as any; const run = runs.get(data.name); if (run) run.consumed = data.created; }
    }
    if (runtimeDir) writeJSON(join(runtimeDir, "runtime.json"), { pid: process.pid });
    if (process.env.HERDR_ENV === "1") {
      timer = setInterval(() => { if (runs.size) void poll(); }, 1000);
      timer.unref();
    }
    widget();
  });
  pi.on("input", () => { inputVersion++; });
  pi.on("message_start", event => {
    if (event.message.role !== "user") return;
    const content = event.message.content;
    const text = typeof content === "string" ? content : content.filter(c => c.type === "text").map(c => c.text).join("\n");
    const stamp = resultStamp(text);
    const run = stamp && runs.get(stamp.name);
    if (run && stamp) {
      run.consumed = Math.max(stamp.created, run.consumed ?? 0);
      pi.appendEntry("swarm_received", stamp);
    }
  });
  pi.on("agent_end", event => { last = [...event.messages].reverse().find(m => m.role === "assistant"); });
  pi.on("agent_before_settle", event => { outcome = event.outcome; });
  pi.on("agent_settled", async (_event, context) => { await finish(context); });
  pi.on("session_shutdown", async event => {
    active = false;
    if ((globalThis as any)[PENDING_COUNT_KEY] === pendingCount) delete (globalThis as any)[PENDING_COUNT_KEY];
    clearInterval(timer);
    ctx?.ui.setWidget("swarm", undefined);
    ctx?.ui.setStatus("swarm", undefined);
    if (runtimeDir && event.reason === "quit" && !finished) writeJSON(join(runtimeDir, "exit.json"), { type: "quit" } satisfies Exit);
    if (finished && outcome === "completed" && ctx?.mode === "tui") {
      try {
        const pane = (await herdr(["pane", "current", "--current"])).pane.pane_id;
        // Close only our own successful pane, after all pi shutdown hooks have run.
        process.once("exit", () => {
          const child = spawn(process.env.HERDR_BIN_PATH || "herdr", ["pane", "close", pane], { detached: true, stdio: "ignore" });
          child.on("error", () => {});
          child.unref();
        });
      } catch {} // A shutdown API failure leaves the pane inspectable.
    }
  });

  pi.registerTool({
    name: "swarm_spawn", label: "Swarm spawn", executionMode: "sequential",
    description: "Start a named peer using an agent definition. Returns when ready; results are persisted to the board and sent to the spawner. All peers may spawn. Use swarm_list to discover definitions. Auto-exit spawners stay open while their own peers are pending.",
    parameters: Type.Object({ agent: Type.String({ minLength: 1 }), name: Type.Optional(Type.String()), task: Type.String({ minLength: 1, maxLength: 48_000 }), model: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, context) {
      requireHerdr();
      const profile = profiles(context.cwd, context.isProjectTrusted()).find(p => p.name === params.agent);
      if (!profile) throw new Error(`Unknown definition ${params.agent}. Use swarm_list.`);
      const spawnerName = await identity();
      const name = validateName(params.name || availableName(profile.name, await list()));
      const cwd = profileCwd(profile, context.cwd, params.cwd);
      const parentDir = join(context.sessionManager.getSessionDir(), "swarm-runs");
      mkdirSync(parentDir, { recursive: true });
      const dir = mkdtempSync(join(parentDir, `${name}-`));
      const settings = loadout(profile, dir, cwd, params.task, params.model);
      // Preserve this invocation's explicit trust only for the same project directory.
      if (context.isProjectTrusted() && cwd === context.cwd) settings.args.push("--approve");
      const task = `You are ${name}, a peer agent. Spawner: ${spawnerName}. Shared board: ${boardPath(context.cwd)}.\n` +
        `${settings.autoExit ? "Your final assistant message is automatically persisted and sent to your spawner before exit. Escape leaves you open.\n" : "This profile stays open for further messages.\n"}` + settings.task;
      const started = Date.now();
      const launched = await start({ name, cwd, args: settings.args, task, env: {
        PI_SWARM_NAME: name, PI_SWARM_SPAWNER: spawnerName, PI_SWARM_BOARD: boardPath(context.cwd),
        PI_SWARM_RUN: dir, PI_SWARM_AUTO_EXIT: settings.autoExit ? "1" : "0", PI_SWARM_PROJECT: process.env.PI_SWARM_PROJECT || context.cwd,
      } });
      const run = { ...launched, dir, started };
      runs.set(name, { ...run });
      pi.appendEntry("swarm_spawn", run);
      widget();
      return textResult(`${name} started in ${run.pane}. Spawner: ${spawnerName}. Results also remain readable on the board until expiry.`, { name, pane: run.pane });
    },
    renderCall(args, theme, context) {
      return callView(theme.fg("toolTitle", theme.bold("spawn ")) + theme.fg("accent", args.agent || "…") + theme.fg("dim", " → ") + theme.fg("accent", args.name || args.agent || "…"), args.task || "", context.expanded, theme);
    },
    renderResult: renderToolResult,
  });
  pi.registerTool({
    name: "swarm_send", label: "Swarm send",
    description: "Send to an exact name (including cross-project), or a pattern with '*' anywhere for matching named agents in this project subtree. Only '*' is supported, not other glob syntax. Persist first, including private/failed messages; report each submission or failure without retry. Busy pi agents queue input. Group sends wake recipients and consume their tokens. Board content is shared, not confidential.",
    parameters: Type.Object({ to: Type.String({ minLength: 1, maxLength: 128 }), message: Type.String(messageLimit), tags: tagsSchema, ttl: ttlSchema }),
    async execute(_id, params, _signal, _update, context) {
      requireHerdr();
      const result = await send(boardPath(context.cwd), { ...params, from: await identity() }, params.ttl);
      const failures = result.deliveries.filter(d => !d.submitted);
      const text = `Persisted to board (expires ${new Date(result.note.expires).toISOString()}).\n` +
        (result.deliveries.map(d => `${d.submitted ? "✓ submitted" : "✗ not confirmed"} → ${d.to}${d.error ? `: ${d.error}` : ""}`).join("\n") || "No matching named agents to notify.");
      return textResult(text, result, failures.length > 0);
    },
    renderCall(args, theme, context) {
      return callView(theme.fg("toolTitle", theme.bold("send")) + theme.fg("dim", " → ") + theme.fg("accent", args.to || "…"), args.message || "", context.expanded, theme);
    },
    renderResult: renderToolResult,
  });
  pi.registerTool({
    name: "swarm_list", label: "Swarm list",
    description: "List current herdr agents (name, status, pane), plus available agent definitions. Unlisted is not proof of completion or a crash.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, context) {
      requireHerdr();
      const agents = await list();
      const definitions = profiles(context.cwd, context.isProjectTrusted()).filter(p => !p.fields["disable-model-invocation"]);
      return textResult(agents.map(a => `${a.name || "(unnamed)"} · ${a.agent_status || "unknown"} · ${a.pane_id}`).join("\n") +
        `\n\nDefinitions:\n${definitions.map(p => `${p.name}${p.fields.model ? ` [${p.fields.model}]` : ""} — ${p.description}`).join("\n")}\nUnlisted does not prove completion or a crash.`, { agents, definitions: definitions.map(p => ({ name: p.name, description: p.description, model: p.fields.model ? String(p.fields.model) : undefined })) });
    },
    renderCall(_args, theme, context) {
      return callView(theme.fg("toolTitle", theme.bold("list")) + theme.fg("dim", " · agents + definitions"), "", context.expanded, theme);
    },
    renderResult: renderToolResult,
  });
  pi.registerTool({
    name: "swarm_board", label: "Swarm board",
    description: "Read all shared unexpired project messages, newest first (default 20, max 100; text output capped at 30,000 characters). Reading does not notify anyone. Filter by sender, recipient or tag. Provide message to post without notifying anyone. Default TTL 24h. Expired entries are deleted on read/write. Private delivery does not mean private storage.",
    parameters: Type.Object({ message: Type.Optional(Type.String(messageLimit)), tags: tagsSchema, ttl: ttlSchema, from: Type.Optional(Type.String()), to: Type.Optional(Type.String()), tag: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    async execute(_id, params, _signal, _update, context) {
      const path = boardPath(context.cwd);
      if (params.message !== undefined) {
        const note = post(path, { from: await identity(), to: params.to || "*", message: params.message, tags: params.tags }, params.ttl);
        return textResult(formatNote(note), { notes: [note] });
      }
      const notes = readBoard(path, params);
      return textResult(notes.map(formatNote).join("\n\n") || "No unexpired messages.", { notes });
    },
    renderCall(args, theme, context) {
      const title = args.message !== undefined
        ? theme.fg("toolTitle", theme.bold("board post")) + theme.fg("dim", " → ") + theme.fg("accent", args.to || "*") + theme.fg("dim", " · board only, no notification")
        : theme.fg("toolTitle", theme.bold("board read")) + theme.fg("dim", ` · from=${args.from || "*"} · tag=${args.tag || "*"} · limit=${args.limit ?? 20}${args.to ? ` · to=${args.to}` : ""}`);
      return callView(title, args.message || "", context.expanded, theme);
    },
    renderResult: renderToolResult,
  });
  pi.registerMessageRenderer("swarm_notice", (message, options, theme) => noticeView(String(message.content), options.expanded, theme));
}
