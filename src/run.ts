import { SessionManager, parseSessionEntries, type ExtensionAPI, type ExtensionContext, type TurnEndEvent, type AgentBeforeSettleEvent } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { MESSAGE_LIMIT, list, sessionBinding, sessionPath, type LiveAgent } from "./herdr.ts";
import type { Snapshot } from "./presets.ts";
import { runningView } from "./ui.ts";

export interface Run { name: string; pane: string; session: string; boundary: string | null; snapshot: Snapshot }
export const PENDING_COUNT_KEY = Symbol.for("pi-herdr-swarm/pending-count");
const DELIVERY_KEY = Symbol.for("pi-herdr-swarm/result-delivery");

/** Read-only: SessionManager.open would repair or migrate the file. */
export function readSession(file: string): SessionManager {
  const entries = parseSessionEntries(readFileSync(file, "utf8"));
  const header = entries[0];
  if (header?.type !== "session" || typeof header.cwd !== "string") throw new Error(`Invalid session header: ${file}`);
  return SessionManager.inMemory(header.cwd, undefined, entries);
}

/** The newest assistant reply after `boundary` on the active branch. */
export function lastReply(manager: Pick<SessionManager, "getBranch">, boundary: string | null) {
  const branch = manager.getBranch();
  const start = boundary === null ? 0 : branch.findIndex(entry => entry.id === boundary) + 1;
  if (start === 0 && boundary !== null) throw new Error(`Session boundary not on active branch: ${boundary}`);
  const entry = branch.slice(start).reverse().find(entry => entry.type === "message" && entry.message.role === "assistant");
  return entry?.type === "message" && entry.message.role === "assistant" ? entry.message : undefined;
}

export function wasAborted(message: any): boolean {
  if (message?.stopReason === "aborted") return true;
  return message?.stopReason === "error" && /operation was aborted|AbortError/i.test(String(message.errorMessage ?? ""));
}

export function finalSummary(message: any, session: string): string {
  let text: string;
  if (!message) text = "No new reply in this run.";
  else if (message.stopReason === "error") text = `Agent error: ${message.errorMessage || "unknown provider error"}`;
  else text = message.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim() || "Assistant replied without text.";
  if (text.length <= MESSAGE_LIMIT) return text;
  const suffix = `\n… Full response is in the pi session: ${session}`;
  return text.slice(0, MESSAGE_LIMIT - suffix.length) + suffix;
}

export function readResult(run: Pick<Run, "name" | "session" | "boundary">) {
  try {
    const manager = readSession(run.session);
    if (waitingForReply(manager).length) return { text: "Session ended while waiting for a reply; this is not a final result.", status: "incomplete" };
    const reply = lastReply(manager, run.boundary);
    // toolUse: the session ended mid-turn, e.g. its pane was closed during a tool.
    const status = !reply ? "empty" : wasAborted(reply) ? "aborted" : reply.stopReason === "error" ? "error" : reply.stopReason === "toolUse" ? "incomplete" : "reply";
    return { text: finalSummary(reply, run.session), status };
  } catch (error: any) {
    return { text: `Cannot read session ${run.session}${error.code ? ` [${error.code}]` : ""}: ${String(error)}`, status: "unreadable" };
  }
}

const resultId = (entry: any): string | undefined =>
  entry.type === "custom_message" && entry.customType === "swarm_result" ? entry.details?.spawnEntryId : undefined;
/** Waiting is reconstructed from this branch's ordinary send results and incoming messages. */
export function waitingForReply(manager: Pick<SessionManager, "getBranch">): string[] {
  const branch = manager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "swarm_send") continue;
    const details = entry.message.details as { wait?: boolean; deliveries?: { to: string; status: string }[] } | undefined;
    if (!details?.wait) continue;
    const recipients = details.deliveries?.filter(d => d.status === "submitted").map(d => d.to) ?? [];
    if (!recipients.length) continue;
    // A reply can be steered while submission is in flight, before its tool result is persisted.
    const toolCallId = entry.message.toolCallId;
    const call = branch.findIndex(e => e.type === "message" && e.message.role === "assistant" && e.message.content.some(c => c.type === "toolCall" && c.id === toolCallId));
    const replied = branch.slice(call < 0 ? i + 1 : call + 1).some(e => {
      if (e.type !== "message" || e.message.role !== "user") return false;
      const text = typeof e.message.content === "string" ? e.message.content : e.message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      const from = /^\[swarm message\] ([a-z][a-z0-9_-]{0,31}) → /.exec(text)?.[1];
      return !text.startsWith("[swarm message]") || !!from && recipients.includes(from);
    });
    return replied ? [] : recipients;
  }
  return [];
}

/**
 * Runs on the active branch whose result is not archived anywhere in the session (a result is
 * archived once, whichever branch the user is on). With `processed`, a run whose result is on the active
 * branch also stays pending until a completed assistant reply follows it: the host must not exit before
 * reading it. A result left on another branch counts as handled: the user navigated away from it.
 */
export function pendingRuns(manager: Pick<SessionManager, "getBranch" | "getEntries">, processed = false): Map<string, Run> {
  const archived = new Set(manager.getEntries().map(resultId).filter(Boolean));
  const runs = new Map<string, Run>();
  const archivedAt = new Map<string, number>();
  let lastCompleted = -1;
  manager.getBranch().forEach((entry, index) => {
    if (entry.type === "custom" && entry.customType === "swarm_spawn") runs.set(entry.id, entry.data as Run);
    const id = resultId(entry);
    if (id && runs.has(id)) archivedAt.set(id, index);
    if (entry.type === "message" && entry.message.role === "assistant" && ["stop", "length"].includes(entry.message.stopReason)) lastCompleted = index;
  });
  for (const id of runs.keys()) {
    if (!archived.has(id)) continue;
    const index = archivedAt.get(id);
    if (!processed || index === undefined || lastCompleted > index) runs.delete(id);
  }
  return runs;
}

export function lifecycle(pi: ExtensionAPI) {
  pi.registerFlag("swarm-exit", { type: "boolean", description: "Exit and close this pane when the task settles; Escape or an editor draft keeps it open." });
  for (const name of ["name", "spawner", "session", "boundary"]) pi.registerFlag(`swarm-${name}`, { type: "string", description: `Internal swarm launch ${name}.` });
  const flag = (name: string) => pi.getFlag(`swarm-${name}`);

  let ctx: ExtensionContext | undefined;
  let active = false;
  let polling = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let stopWatchingKeys: (() => void) | undefined;
  // Exit state: a completion candidate from the last settled turn.
  let outcome: string | undefined;
  let candidate = false;
  let exitTick: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let exitSession: string | undefined;
  // Process-local supervision state; everything durable is derived from the session.
  const launching = new Set<string>();
  // A message awaits a safe boundary; undefined means it has already been submitted to pi.
  let delivery = { written: new Map<string, ReturnType<typeof resultMessage> | undefined>(), cancelled: false, exitSession: undefined as string | undefined };
  const awaitingReply = () => !!ctx && waitingForReply(ctx.sessionManager).length > 0;
  const blocked = new Set<string>();
  const waitingPeers = new Map<string, string[]>();

  const pending = () => pendingRuns(ctx!.sessionManager);
  const pendingCount = () => ctx ? pendingRuns(ctx.sessionManager, true).size + Number(awaitingReply()) : 0;

  /** Launched by swarm with these flags, and still on the session it was launched with. */
  function eligible(context: ExtensionContext): boolean {
    const session = flag("session");
    const file = context.sessionManager.getSessionFile();
    if (typeof flag("name") !== "string" || typeof flag("spawner") !== "string" || typeof session !== "string" || !session || !file) return false;
    return sessionPath(session) === sessionPath(file);
  }

  function autoExitEligible(context: ExtensionContext): boolean {
    if (eligible(context)) return true;
    return flag("exit") === true && exitSession === (context.sessionManager.getSessionFile() ?? context.sessionManager.getSessionId())
      && !context.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "swarm_takeover");
  }

  /** Supervision trouble is shown once in the status line (not as repeated notices) and cleared on recovery. */
  function status(problem: string | undefined) {
    if (ctx?.mode === "tui") ctx.ui.setStatus("swarm", problem ? `swarm: still waiting, state unknown (${problem})` : undefined);
  }

  function widget() {
    if (ctx?.mode !== "tui") return;
    // Only peers still running: collected results await a safe boundary, even if not yet answered.
    const waiting = [...pending()].filter(([id]) => !delivery.written.has(id));
    const agents = waiting.map(([id, run]) => ({ name: run.name, agent: run.snapshot.preset, pane: run.pane, status: waitingPeers.get(id)?.length ? `waiting for reply: ${waitingPeers.get(id)!.join(", ")}` : blocked.has(id) ? "blocked" : "running" }));
    const recipients = waitingForReply(ctx.sessionManager);
    if (recipients.length) agents.unshift({ name: String(flag("name") || "self"), agent: undefined, pane: "", status: `waiting for reply: ${recipients.join(", ")}` });
    ctx.ui.setWidget("swarm", agents.length ? (_tui, theme) => runningView(agents, theme) : undefined);
  }

  function cancelExit() {
    clearTimeout(exitTick);
    exitTick = undefined;
    candidate = false;
  }

  function scheduleExit() {
    if (!active || finished || delivery.cancelled || !candidate || exitTick || !autoExitEligible(ctx!)) return;
    const context = ctx!;
    exitTick = setTimeout(() => {
      exitTick = undefined;
      if (!active || ctx !== context || delivery.cancelled || !candidate || !autoExitEligible(context)) return;
      if (!context.isIdle() || context.hasPendingMessages() || context.ui.getEditorText() || pendingCount()) return;
      candidate = false;
      const boundary = flag("boundary");
      if (typeof boundary === "string" && boundary && !context.sessionManager.getBranch().some(entry => entry.id === boundary)) return;
      const reply = lastReply(context.sessionManager, typeof boundary === "string" && boundary ? boundary : null);
      if (outcome === "aborted" || wasAborted(reply)) return;
      finished = true; // the result is the session's last reply; the spawner reads it after this exit
      context.shutdown();
    }, 0);
  }

  function resultMessage(id: string, run: Run) {
    const result = readResult(run);
    return { customType: "swarm_result", content: `[swarm result] ${run.name}${result.status === "reply" ? "" : ` · ${result.status}`}\nSession: ${run.session}\n${result.text}`, display: true,
      details: { name: run.name, session: run.session, spawnEntryId: id, status: result.status } };
  }

  function archive(id: string, run: Run) {
    delivery.written.set(id, resultMessage(id, run));
    cancelExit();
  }

  function readyResults() {
    return [...pending()].flatMap(([id]) => {
      const message = delivery.written.get(id);
      return message ? [{ type: "custom_message" as const, ...message }] : [];
    });
  }

  function flushResults(triggerTurn: boolean) {
    const entries = readyResults();
    const current = ctx!;
    for (const [index, { type: _type, ...message }] of entries.entries()) {
      if (!active || ctx !== current || !current.isIdle()) break;
      delivery.written.set(message.details.spawnEntryId, undefined);
      pi.sendMessage(message, { triggerTurn: triggerTurn && !awaitingReply() && index === entries.length - 1 });
    }
  }

  function resultBoundary(event: TurnEndEvent | AgentBeforeSettleEvent) {
    const proposed = new Set(event.entries.map(resultId));
    const entries = readyResults().filter(entry => !proposed.has(entry.details.spawnEntryId));
    if (!entries.length) return;
    // Keep payloads until pi persists them: later handlers can replace these drafts.
    return { entries: [...event.entries, ...entries], ...(event.outcome === "completed" && !delivery.cancelled && !awaitingReply() ? { continue: true } : {}) };
  }

  function supervise(id: string, run: Run, agents: LiveAgent[]) {
    const agent = sessionBinding(agents, run.session); // throws while bindings are uncertain: keep waiting
    if (!agent) return archive(id, run);
    waitingPeers.set(id, waitingForReply(readSession(run.session)));
    if (agent.agent_status !== "blocked") return void blocked.delete(id);
    if (!blocked.has(id)) pi.sendMessage({ customType: "swarm_notice", content: `${run.name} is blocked in pane ${agent.pane_id}.`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
    blocked.add(id);
  }

  async function poll() {
    if (!active || !ctx || polling) return;
    polling = true;
    const current = ctx;
    try {
      const agents = await list();
      if (!active || ctx !== current) return;
      // Read the session after listing: navigation while list was in flight must not archive an abandoned run.
      let unknown: string | undefined;
      for (const [id, run] of pending()) {
        if (delivery.written.has(id) || launching.has(id)) continue;
        try { supervise(id, run, agents); } catch (error) { unknown = `${run.name}: ${String(error)}`; }
      }
      status(unknown);
    } catch (error) { if (active && ctx === current) status(pending().size ? `herdr list: ${String(error)}` : undefined); }
    finally {
      if (active && ctx === current) {
        if (current.isIdle()) flushResults(!delivery.cancelled);
        if (!pending().size) status(undefined);
        widget();
        scheduleExit();
      }
      polling = false;
    }
  }

  pi.on("session_start", (event, context) => {
    clearInterval(pollTimer);
    stopWatchingKeys?.();
    cancelExit();
    ctx = context;
    active = true;
    finished = false;
    outcome = undefined;
    launching.clear();
    // Reload does not discard pi's deferred sends; retain their ownership and cancellation, not an extra receipt.
    const session = context.sessionManager.getSessionFile() ?? context.sessionManager.getSessionId();
    const previous = (globalThis as any)[DELIVERY_KEY] as { session: string; state: typeof delivery } | undefined;
    exitSession ??= previous?.session === session ? previous.state.exitSession ?? session : session;
    delivery = previous?.session === session ? previous.state : { written: new Map(), cancelled: false, exitSession };
    (globalThis as any)[DELIVERY_KEY] = { session, state: delivery };
    if (flag("exit") === true && !eligible(context) && ["new", "resume", "fork"].includes(event.reason)) pi.appendEntry("swarm_takeover", {});
    blocked.clear();
    waitingPeers.clear();
    (globalThis as any)[PENDING_COUNT_KEY] = pendingCount;
    if (context.mode === "tui") stopWatchingKeys = context.ui.onTerminalInput(data => {
      if (getKeybindings().matches(data, "app.interrupt")) { delivery.cancelled = true; cancelExit(); }
      return undefined; // observe only
    });
    widget();
    if (process.env.HERDR_ENV === "1") {
      pollTimer = setInterval(() => { if (pending().size) void poll(); }, 1000);
      pollTimer.unref();
    }
  });
  pi.on("input", () => { delivery.cancelled = false; cancelExit(); });
  pi.on("tool_call", () => awaitingReply() ? { block: true, terminate: true, reason: "Waiting for a reply; stop here." } : undefined);
  pi.on("message_start", (event, context) => {
    cancelExit();
    // A deferred result wake can outlive Escape and /tree; identify our message, not the active branch.
    if (delivery.cancelled && event.message.role === "custom" && event.message.customType === "swarm_result") {
      const id = (event.message.details as { spawnEntryId?: string } | undefined)?.spawnEntryId;
      if (id && delivery.written.has(id)) context.abort();
    }
  });
  pi.on("agent_start", () => { outcome = undefined; });
  pi.on("turn_end", (event, context) => {
    // Mixed tool batches may contain non-terminating results: still stop after wait:true.
    if (awaitingReply() && !context.hasPendingMessages()) context.abort();
    return resultBoundary(event);
  });
  pi.on("agent_before_settle", event => { outcome = event.outcome; return resultBoundary(event); });
  pi.on("agent_settled", () => {
    // A result may arrive while another before-settle handler awaits; pi defers this turn until settlement finishes.
    flushResults(outcome === "completed" && !delivery.cancelled);
    candidate = !delivery.cancelled && !!outcome && outcome !== "aborted";
    widget();
    scheduleExit();
  });
  // /tree can leave the branch that holds the spawns: redraw from the new branch at once.
  pi.on("session_tree", () => {
    cancelExit();
    status(undefined);
    widget();
    if (pending().size) void poll();
  });
  pi.on("session_shutdown", event => {
    active = false;
    clearInterval(pollTimer);
    stopWatchingKeys?.();
    stopWatchingKeys = undefined;
    cancelExit();
    ctx?.ui.setWidget("swarm", undefined);
    status(undefined);
    if ((globalThis as any)[PENDING_COUNT_KEY] === pendingCount) delete (globalThis as any)[PENDING_COUNT_KEY];
    if (event.reason !== "reload" && (globalThis as any)[DELIVERY_KEY]?.state === delivery) delete (globalThis as any)[DELIVERY_KEY];
    if (finished && event.reason === "quit" && ctx?.mode === "tui") closeOwnPaneOnExit();
  });

  return {
    /** Every spawn this session made, by name (latest record wins): history for names and resume. */
    history() {
      const found = new Map<string, Run & { entryId: string }>();
      for (const entry of ctx!.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === "swarm_spawn") found.set((entry.data as Run).name, { ...(entry.data as Run), entryId: entry.id });
      }
      return found;
    },
    /** Who receives this session's last reply as a result, when swarm launched it on this session. */
    deliversTo: (context: ExtensionContext) => eligible(context) ? { name: String(flag("name")), spawner: String(flag("spawner")) } : undefined,
    archived: (id: string) => ctx!.sessionManager.getEntries().some(entry => resultId(entry) === id),
    pending: (session: string) => [...pending().values()].some(run => sessionPath(run.session) === sessionPath(session)),
    /** Persist the spawn record before the child is started; it is not supervised until `launched`. */
    record(run: Run): string {
      pi.appendEntry("swarm_spawn", run);
      const id = ctx!.sessionManager.getLeafId()!;
      launching.add(id);
      widget();
      return id;
    },
    launched(id: string) { launching.delete(id); },
  };
}

/** Close the pane this process occupies now (it may have moved), after pi has fully exited. */
function closeOwnPaneOnExit() {
  const bin = process.env.HERDR_BIN_PATH || "herdr";
  let pane: string | undefined;
  try { pane = JSON.parse(execFileSync(bin, ["pane", "current", "--current"], { encoding: "utf8", timeout: 5000 })).result?.pane?.pane_id; }
  catch { return; } // cannot confirm the pane: leave it open
  if (typeof pane !== "string" || !pane) return;
  process.once("exit", () => {
    const closer = spawn(bin, ["pane", "close", pane], { detached: true, stdio: "ignore" });
    closer.on("error", () => {});
    closer.unref();
  });
}
