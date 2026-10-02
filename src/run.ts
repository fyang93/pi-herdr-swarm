import { SessionManager, parseSessionEntries, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { list, sessionBinding, sessionPath, type LiveAgent } from "./herdr.ts";
import { MESSAGE_LIMIT } from "./board.ts";
import type { Snapshot } from "./presets.ts";
import { waitingView } from "./ui.ts";

export interface Run { name: string; pane: string; session: string; boundary: string | null; snapshot: Snapshot; detach: boolean }
export const PENDING_COUNT_KEY = Symbol.for("pi-herdr-swarm/pending-count");

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
    const reply = lastReply(readSession(run.session), run.boundary);
    const status = !reply ? "empty" : wasAborted(reply) ? "aborted" : reply.stopReason === "error" ? "error" : "reply";
    return { text: finalSummary(reply, run.session), status };
  } catch (error: any) {
    return { text: `Cannot read session ${run.session}${error.code ? ` [${error.code}]` : ""}: ${String(error)}`, status: "unreadable" };
  }
}

const resultId = (entry: any): string | undefined =>
  entry.type === "custom_message" && entry.customType === "swarm_result" ? entry.details?.spawnEntryId : undefined;

/**
 * Non-detached runs on the active branch whose result is not archived anywhere in the session (a result is
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
    if (entry.type === "custom" && entry.customType === "swarm_spawn" && !(entry.data as Run).detach) runs.set(entry.id, entry.data as Run);
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
  for (const name of ["name", "spawner", "session", "boundary"]) pi.registerFlag(`swarm-${name}`, { type: "string", description: `Internal swarm launch ${name}.` });
  const flag = (name: string) => pi.getFlag(`swarm-${name}`);

  let ctx: ExtensionContext | undefined;
  let active = false;
  let polling = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let stopWatchingKeys: (() => void) | undefined;
  // Exit state: a completion candidate from the last settled turn, and whether the user cancelled this turn.
  let outcome: string | undefined;
  let candidate = false;
  let cancelled = false;
  let exitTick: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  // Process-local supervision state; everything durable is derived from the session.
  const launching = new Set<string>();
  const written = new Set<string>();
  const blocked = new Set<string>();

  const pending = () => pendingRuns(ctx!.sessionManager);
  const pendingCount = () => ctx ? pendingRuns(ctx.sessionManager, true).size : 0;
  const notice = (content: string) => pi.sendMessage({ customType: "swarm_notice", content, display: true }, { triggerTurn: true, deliverAs: "followUp" });

  /** Launched by swarm with these flags, and still on the session it was launched with. */
  function eligible(context: ExtensionContext): boolean {
    const session = flag("session");
    const file = context.sessionManager.getSessionFile();
    if (typeof flag("name") !== "string" || typeof flag("spawner") !== "string" || typeof session !== "string" || !session || !file) return false;
    return sessionPath(session) === sessionPath(file);
  }

  /** Supervision trouble is shown once in the status line (not as repeated notices) and cleared on recovery. */
  function status(problem: string | undefined) {
    if (ctx?.mode === "tui") ctx.ui.setStatus("swarm", problem ? `swarm: still waiting, state unknown (${problem})` : undefined);
  }

  function widget() {
    if (ctx?.mode !== "tui") return;
    const waiting = [...pendingRuns(ctx.sessionManager, true)];
    const statuses = new Map(waiting.filter(([id]) => blocked.has(id)).map(([, run]) => [run.name, "blocked"]));
    ctx.ui.setWidget("swarm", waiting.length ? (_tui, theme) => waitingView(waiting.map(([, run]) => run.name), statuses, theme) : undefined);
  }

  function cancelExit() {
    clearTimeout(exitTick);
    exitTick = undefined;
    candidate = false;
  }

  function scheduleExit() {
    if (!active || finished || cancelled || !candidate || exitTick || !eligible(ctx!)) return;
    const context = ctx!;
    exitTick = setTimeout(() => {
      exitTick = undefined;
      if (!active || ctx !== context || cancelled || !candidate || !eligible(context)) return;
      if (!context.isIdle() || context.hasPendingMessages() || context.ui.getEditorText() || pendingCount()) return;
      candidate = false;
      const boundary = flag("boundary");
      const reply = lastReply(context.sessionManager, typeof boundary === "string" && boundary ? boundary : null);
      if (outcome === "aborted" || wasAborted(reply)) return;
      finished = true; // the result is the session's last reply; the spawner reads it after this exit
      context.shutdown();
    }, 0);
  }

  function archive(id: string, run: Run) {
    const result = readResult(run);
    written.add(id);
    cancelExit();
    pi.sendMessage({ customType: "swarm_result", content: `[swarm result] ${run.name}\nSession: ${run.session}\n${result.text}`, display: true,
      details: { name: run.name, session: run.session, spawnEntryId: id, status: result.status } }, { triggerTurn: false });
    notice(`${run.name} finished`);
  }

  function supervise(id: string, run: Run, agents: LiveAgent[]) {
    const agent = sessionBinding(agents, run.session); // throws while bindings are uncertain: keep waiting
    if (!agent) return archive(id, run);
    if (agent.agent_status !== "blocked") return void blocked.delete(id);
    if (!blocked.has(id)) notice(`${run.name} is blocked in pane ${agent.pane_id}.`);
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
        if (written.has(id) || launching.has(id)) continue;
        try { supervise(id, run, agents); } catch (error) { unknown = `${run.name}: ${String(error)}`; }
      }
      status(unknown);
      widget();
      scheduleExit();
    } catch (error) { if (active && ctx === current) status(`herdr list: ${String(error)}`); }
    finally { polling = false; }
  }

  pi.on("session_start", (_event, context) => {
    clearInterval(pollTimer);
    stopWatchingKeys?.();
    cancelExit();
    ctx = context;
    active = true;
    finished = false;
    cancelled = false;
    outcome = undefined;
    launching.clear();
    written.clear();
    blocked.clear();
    (globalThis as any)[PENDING_COUNT_KEY] = pendingCount;
    if (context.mode === "tui") stopWatchingKeys = context.ui.onTerminalInput(data => {
      if (getKeybindings().matches(data, "app.interrupt")) { cancelled = true; cancelExit(); }
      return undefined; // observe only
    });
    widget();
    if (process.env.HERDR_ENV === "1") {
      pollTimer = setInterval(() => { if (pending().size) void poll(); }, 1000);
      pollTimer.unref();
    }
  });
  pi.on("input", cancelExit);
  pi.on("message_start", cancelExit);
  pi.on("agent_start", () => { cancelled = false; outcome = undefined; });
  pi.on("agent_before_settle", event => { outcome = event.outcome; });
  pi.on("agent_settled", () => {
    candidate = !cancelled && !!outcome && outcome !== "aborted";
    widget();
    scheduleExit();
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
    archived: (id: string) => written.has(id) || ctx!.sessionManager.getEntries().some(entry => resultId(entry) === id),
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
