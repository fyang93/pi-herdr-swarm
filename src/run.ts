import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { MESSAGE_LIMIT } from "./board.ts";
import { get, herdr, send } from "./herdr.ts";
import { waitingView } from "./ui.ts";

export interface Run { name: string; pane: string; session: string }
export const PENDING_COUNT_KEY = Symbol.for("pi-herdr-swarm/pending-count");
export function wasAborted(message: any): boolean {
  return message?.stopReason === "aborted" || (message?.stopReason === "error" && /operation was aborted|AbortError/i.test(String(message.errorMessage ?? "")));
}
export function finalSummary(message: any, session: string): string {
  const text = message?.stopReason === "error" ? `Agent error: ${message.errorMessage || "unknown provider error"}`
    : message?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim() || "Agent finished without a text summary.";
  if (text.length <= MESSAGE_LIMIT) return text;
  const suffix = `\n… Full final response is in the existing pi session: ${session}`;
  return text.slice(0, Math.max(0, MESSAGE_LIMIT - suffix.length)) + suffix;
}

export function lifecycle(pi: ExtensionAPI, board: () => string) {
  let ctx: ExtensionContext | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let finishTick: { timer?: ReturnType<typeof setTimeout> } | undefined;
  let active = false;
  let last: { message: any; version: number; outcome: string } | undefined;
  let outcome = "completed";
  let finished = false;
  let inputVersion = 0;
  const runs = new Map<string, Run>();
  const statuses = new Map<string, string>();
  const autoExit = process.env.PI_SWARM_AUTO_EXIT === "1";
  const spawner = process.env.PI_SWARM_SPAWNER || undefined;
  const ownName = process.env.PI_SWARM_NAME;
  const pendingCount = () => runs.size;

  function widget() {
    if (ctx?.mode === "tui") ctx.ui.setWidget("swarm", runs.size ? (_tui, theme) => waitingView([...runs.keys()], statuses, theme) : undefined);
  }
  function schedule() {
    if (!active || !autoExit || finished || !last || finishTick) return;
    const slot: { timer?: ReturnType<typeof setTimeout> } = {};
    finishTick = slot; // Occupied during both scheduling and the entire awaited send.
    slot.timer = setTimeout(() => void finish(slot), 0);
  }
  async function finish(slot: NonNullable<typeof finishTick>) {
    const context = ctx;
    const candidate = last;
    try {
      if (!active || finishTick !== slot || !context || !candidate || finished) return;
      if (candidate.version !== inputVersion) { if (last === candidate) last = undefined; return; }
      if (!context.isIdle() || context.hasPendingMessages() || runs.size) return;
      last = undefined; // Attempt once. Polling must never retry an uncertain submission.
      if (!candidate.message || candidate.outcome === "aborted" || wasAborted(candidate.message)) return;
      if (!ownName) throw new Error("Missing swarm launch identity.");
      const result = await send(board(), {
        from: ownName, to: spawner, kind: "result", tags: ["result", ...(candidate.outcome === "error" ? ["error"] : [])],
        message: finalSummary(candidate.message, context.sessionManager.getSessionFile() || "(in-memory session)"),
      });
      if (!active || finishTick !== slot || ctx !== context) return;
      const submitted = result.boardOnly || (result.deliveries.length === 1 && result.deliveries[0].status === "submitted");
      if (!submitted) {
        context.ui.notify(`Swarm result persisted, delivery unconfirmed; pane kept open. ${result.deliveries.map(d => d.error || d.to).join("; ")}`, "warning");
        return;
      }
      if (candidate.version !== inputVersion || !context.isIdle() || context.hasPendingMessages() || runs.size || last) return;
      finished = true;
      context.shutdown();
    } catch (error) {
      if (active && finishTick === slot) context?.ui.notify(`Swarm completion failed; pane kept open: ${String(error)}`, "error");
    } finally {
      if (finishTick === slot) {
        finishTick = undefined;
        // A newer settled candidate may have arrived while the send was in flight.
        if (last !== candidate) schedule();
      }
    }
  }
  async function notice(text: string) {
    await pi.sendMessage({ customType: "swarm_notice", content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" });
  }
  async function poll() {
    if (!active || !ctx || polling) return;
    polling = true;
    const current = ctx;
    try {
      for (const run of runs.values()) {
        try {
          const agent = await get(run.name);
          if (!active || ctx !== current || runs.get(run.name) !== run) return;
          if (agent?.agent_status === "unknown") continue;
          const session = agent?.agent_session;
          if (agent && (session?.kind !== "path" || !session.value)) continue;
          if (!agent || resolve(session!.value) !== resolve(run.session)) {
            runs.delete(run.name);
            statuses.delete(run.name);
            pi.appendEntry("swarm_resolved", { name: run.name, session: run.session });
            await notice(`${run.name} has ended or is no longer addressable; results (if any) are on the board. Last pane: ${run.pane} (herdr pane read ${run.pane}); session: ${run.session}. Loss of binding is not success.`);
          } else {
            run.pane = agent.pane_id;
            const previous = statuses.get(run.name);
            statuses.set(run.name, agent.agent_status || "unknown");
            if (agent.agent_status === "blocked" && previous !== "blocked") await notice(`${run.name} is blocked. Inspect herdr pane read ${run.pane}; code will not answer the dialog.`);
          }
        } catch {
          // Connection failures/timeouts/server errors are not evidence of an ended run.
        }
        if (!active || ctx !== current) return;
      }
      widget();
      schedule();
    } finally { polling = false; }
  }

  pi.on("session_start", (_event, context) => {
    clearInterval(pollTimer);
    clearTimeout(finishTick?.timer);
    finishTick = undefined;
    ctx = context;
    active = true;
    last = undefined;
    outcome = "completed";
    finished = false;
    inputVersion++;
    runs.clear(); statuses.clear();
    (globalThis as any)[PENDING_COUNT_KEY] = pendingCount;
    for (const entry of context.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "swarm_spawn") {
        const run = entry.data as Run;
        if (run.session) runs.set(run.name, { ...run });
      }
      if (entry.type === "custom" && entry.customType === "swarm_resolved") {
        const data = entry.data as Run;
        if (runs.get(data.name)?.session === data.session) runs.delete(data.name);
      }
    }
    if (process.env.HERDR_ENV === "1") {
      pollTimer = setInterval(() => { if (runs.size) void poll(); }, 1000);
      pollTimer.unref();
    }
    widget();
  });
  pi.on("input", () => { inputVersion++; });
  pi.on("agent_before_settle", event => { outcome = event.outcome; });
  pi.on("agent_settled", (_event, context) => {
    const entry = [...context.sessionManager.getBranch()].reverse().find(e => e.type === "message" && e.message.role === "assistant");
    last = { message: entry?.type === "message" ? entry.message : undefined, version: inputVersion, outcome };
    schedule();
  });
  pi.on("session_shutdown", async (_event, context) => {
    active = false;
    clearInterval(pollTimer);
    clearTimeout(finishTick?.timer);
    finishTick = undefined;
    if ((globalThis as any)[PENDING_COUNT_KEY] === pendingCount) delete (globalThis as any)[PENDING_COUNT_KEY];
    context.ui.setWidget("swarm", undefined);
    if (finished && outcome === "completed" && context.mode === "tui") {
      try {
        const pane = (await herdr(["pane", "current", "--current"])).pane.pane_id;
        // Close only our successful pane, after all pi shutdown hooks have run.
        process.once("exit", () => {
          const child = spawn(process.env.HERDR_BIN_PATH || "herdr", ["pane", "close", pane], { detached: true, stdio: "ignore" });
          child.on("error", () => {}); child.unref();
        });
      } catch {} // Leave an uncertain shutdown inspectable.
    }
  });
  return (run: Run) => {
    runs.set(run.name, run);
    statuses.delete(run.name);
    pi.appendEntry("swarm_spawn", run);
    widget();
  };
}
