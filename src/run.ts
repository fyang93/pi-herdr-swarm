import { SessionManager, parseSessionEntries, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { list, sessionBinding, sessionPath } from "./herdr.ts";
import { MESSAGE_LIMIT, postSync } from "./board.ts";
import type { Snapshot } from "./presets.ts";
import { waitingView } from "./ui.ts";

export interface Run { name: string; pane: string; session: string; boundary: string | null; snapshot: Snapshot; detach: boolean }
export const PENDING_COUNT_KEY = Symbol.for("pi-herdr-swarm/pending-count");
export function readSession(file: string): SessionManager {
  const text = readFileSync(file, "utf8"); const entries = parseSessionEntries(text);
  const header = entries[0];
  if (entries.length !== text.split("\n").filter(l => l.trim()).length || header?.type !== "session" || typeof header.id !== "string" || !header.id || typeof header.cwd !== "string" || !header.cwd || typeof header.version !== "number" || !Number.isInteger(header.version) || header.version < 1 || typeof header.timestamp !== "string" || !Number.isFinite(Date.parse(header.timestamp))) throw new Error(`Invalid session header: ${file}`);
  const seen = new Set<string>();
  for (const entry of entries.slice(1)) {
    if (!entry || entry.type === "session" || typeof entry.id !== "string" || seen.has(entry.id) || (entry.parentId !== null && !seen.has(entry.parentId))) throw new Error(`Invalid session tree: ${file}`);
    seen.add(entry.id);
  }
  return SessionManager.inMemory(header.cwd, undefined, entries);
}
export function lastReply(manager: Pick<SessionManager, "getBranch">, boundary: string | null) {
  const branch = manager.getBranch(); const index = boundary === null ? -1 : branch.findIndex(e => e.id === boundary);
  if (boundary !== null && index < 0) throw new Error(`Session boundary not on active branch: ${boundary}`);
  const entry = branch.slice(index + 1).reverse().find(e => e.type === "message" && e.message.role === "assistant");
  const reply = entry?.type === "message" && entry.message.role === "assistant" ? entry.message : undefined;
  if (reply && (!Array.isArray(reply.content) || !["stop", "length", "toolUse", "error", "aborted"].includes(reply.stopReason))) throw new Error("Invalid assistant reply.");
  return reply;
}
export function wasAborted(message: any): boolean {
  return message?.stopReason === "aborted" || (message?.stopReason === "error" && /operation was aborted|AbortError/i.test(String(message.errorMessage ?? "")));
}
export function finalSummary(message: any, session: string): string {
  const text = !message ? "本次执行没有新回复" : message.stopReason === "error" ? `Agent error: ${message.errorMessage || "unknown provider error"}`
    : message.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim() || "Assistant replied without text.";
  if (text.length <= MESSAGE_LIMIT) return text;
  const suffix = `\n… Full response is in the pi session: ${session}`;
  return text.slice(0, Math.max(0, MESSAGE_LIMIT - suffix.length)) + suffix;
}
export function readResult(run: Pick<Run, "name" | "session" | "boundary">) {
  try {
    const reply = lastReply(readSession(run.session), run.boundary);
    return { text: finalSummary(reply, run.session), status: !reply ? "empty" : wasAborted(reply) ? "aborted" : reply.stopReason === "error" ? "error" : "reply" };
  } catch (error: any) { return { text: `Cannot read session ${run.session}${error.code ? ` [${error.code}]` : ""}: ${String(error)}`, status: "unreadable" }; }
}
// Live branch data is the only authority; no cached acknowledgement or processing records.
export function pendingRuns(manager: Pick<SessionManager, "getBranch">, requireReply = false): Map<string, Run> {
  const runs = new Map<string, Run>(); const resolved = new Map<string, number>(); let reply = -1;
  manager.getBranch().forEach((entry, index) => {
    if (entry.type === "custom" && entry.customType === "swarm_spawn") { const run = entry.data as Run; if (!run.detach) runs.set(entry.id, run); }
    if (entry.type === "custom_message" && entry.customType === "swarm_result") {
      const data = entry.details as { spawnEntryId?: string; name?: string; session?: string } | undefined;
      const run = data?.spawnEntryId && runs.get(data.spawnEntryId);
      if (run && data.name === run.name && data.session === run.session) resolved.set(data.spawnEntryId!, index);
    }
    if (entry.type === "message" && entry.message.role === "assistant" && ["stop", "length"].includes(entry.message.stopReason)) reply = index;
  });
  for (const [id, index] of resolved) if (!requireReply || reply > index) runs.delete(id);
  return runs;
}

export function lifecycle(pi: ExtensionAPI, board: () => string) {
  for (const flag of ["name", "spawner", "session", "boundary"]) pi.registerFlag(`swarm-${flag}`, { type: "string", description: `Internal swarm launch ${flag}.` });
  pi.registerFlag("swarm-detach", { type: "boolean", description: "Internal detached swarm launch.", default: false });
  let ctx: ExtensionContext | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined; let exitTick: ReturnType<typeof setTimeout> | undefined;
  let terminalOff: (() => void) | undefined; let polling = false; let active = false; let finished = false; let cancelled = false;
  let candidate: { outcome: string } | undefined; let outcome: string | undefined;
  const runs = new Map<string, Run & { queued?: boolean; blocked?: boolean; launching?: boolean }>();
  const queued = new Set<string>();
  const flag = (name: string) => pi.getFlag(`swarm-${name}`);
  const pendingCount = () => ctx ? pendingRuns(ctx.sessionManager, true).size : 0;
  const eligible = (context: ExtensionContext) => typeof flag("name") === "string" && typeof flag("spawner") === "string" && typeof flag("session") === "string" && !!flag("session") && !!context.sessionManager.getSessionFile() && sessionPath(String(flag("session"))) === sessionPath(context.sessionManager.getSessionFile()!);
  function widget() {
    if (ctx?.mode !== "tui") return;
    const waiting = pendingRuns(ctx.sessionManager, true);
    ctx.ui.setWidget("swarm", waiting.size ? (_tui, theme) => waitingView([...waiting.values()].map(r => r.name), new Map([...runs.values()].filter(r => r.blocked).map(r => [r.name, "blocked"])), theme) : undefined);
  }
  function cancel() { clearTimeout(exitTick); exitTick = undefined; candidate = undefined; }
  function fail(error: unknown, directory = ctx!.cwd) { candidate = undefined; ctx!.ui.notify(`Swarm completion failed; board: ${directory}; pane kept open: ${String(error)}`, "error"); }
  function schedule() {
    if (!active || finished || cancelled || !candidate || exitTick) return;
    const context = ctx!;
    try { if (!eligible(context)) return; } catch (error) { fail(error); return; }
    exitTick = setTimeout(() => {
      exitTick = undefined;
      let directory = context.cwd;
      try {
        if (!active || ctx !== context || cancelled || !candidate || !eligible(context) || !context.isIdle() || context.hasPendingMessages() || context.ui.getEditorText() || pendingCount()) return;
        const next = candidate; candidate = undefined;
        const reply = lastReply(context.sessionManager, typeof flag("boundary") === "string" && flag("boundary") ? String(flag("boundary")) : null);
        if (next.outcome === "aborted" || wasAborted(reply)) return;
        directory = board();
        postSync(directory, { from: String(flag("name")), to: flag("detach") === true ? "*" : String(flag("spawner")), kind: "result", message: finalSummary(reply, context.sessionManager.getSessionFile()!) });
        finished = true; context.shutdown();
      } catch (error) { fail(error, directory); }
    }, 0);
  }
  const unarchived = () => pendingRuns({ getBranch: () => ctx!.sessionManager.getEntries() });
  const archived = (id: string) => !unarchived().has(id);
  function reconcile() {
    const waiting = pendingRuns(ctx!.sessionManager); const remaining = unarchived();
    for (const id of runs.keys()) if (!waiting.has(id)) runs.delete(id);
    for (const [id, run] of waiting) if (!runs.has(id)) runs.set(id, { ...run, queued: queued.has(id) || !remaining.has(id) });
    widget();
  }
  async function poll() {
    if (!active || !ctx || polling) return;
    polling = true; const current = ctx;
    try {
      reconcile();
      const agents = await list();
      if (!active || ctx !== current) return;
      reconcile(); // Navigation while list was in flight must not resolve an abandoned branch.
      for (const [id, run] of runs) {
        if (run.queued || run.launching) continue;
        try {
          const agent = sessionBinding(agents, run.session);
          if (agent) {
            run.pane = agent.pane_id;
            if (agent.agent_status === "unknown") continue;
            const blocked = agent.agent_status === "blocked";
            if (blocked && !run.blocked) pi.sendMessage({ customType: "swarm_notice", content: `${run.name} is blocked. Inspect herdr pane read ${run.pane}.`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
            run.blocked = blocked;
          } else {
            const result = readResult(run); cancel(); run.queued = true; queued.add(id);
            pi.sendMessage({ customType: "swarm_result", content: `[swarm result] ${run.name}\nSession: ${run.session}\n${result.text}`, display: true,
              details: { name: run.name, session: run.session, spawnEntryId: id, status: result.status } }, { triggerTurn: false });
            pi.sendMessage({ customType: "swarm_notice", content: `${run.name} finished`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
          }
        } catch (error) { if (active && ctx === current) current.ui.notify(`${run.name}: ${String(error)}; session: ${run.session}`, "warning"); }
      }
      if (active && ctx === current) { widget(); schedule(); }
    } catch (error) { if (active && ctx === current) current.ui.notify(`Swarm supervision unknown: ${String(error)}`, "warning"); }
    finally { polling = false; }
  }
  function history() {
    const found = new Map<string, Run & { entryId: string }>();
    for (const e of ctx!.sessionManager.getEntries()) if (e.type === "custom" && e.customType === "swarm_spawn") { const run = e.data as Run; found.set(run.name, { ...run, entryId: e.id }); }
    return found;
  }
  pi.on("session_start", (_event, context) => {
    clearInterval(pollTimer); terminalOff?.(); cancel(); ctx = context; active = true; finished = false; cancelled = false; outcome = undefined; runs.clear(); queued.clear();
    (globalThis as any)[PENDING_COUNT_KEY] = pendingCount;
    if (context.mode === "tui") terminalOff = context.ui.onTerminalInput(data => { if (getKeybindings().matches(data, "app.interrupt")) { cancelled = true; cancel(); } return undefined; });
    reconcile();
    if (process.env.HERDR_ENV === "1") { pollTimer = setInterval(() => { if (runs.size) void poll(); }, 1000); pollTimer.unref(); }
  });
  pi.on("input", cancel); pi.on("message_start", cancel);
  pi.on("agent_start", () => { cancelled = false; outcome = undefined; });
  pi.on("agent_before_settle", event => { outcome = event.outcome; });
  pi.on("agent_settled", () => { candidate = !cancelled && outcome && outcome !== "aborted" ? { outcome } : undefined; widget(); schedule(); });
  pi.on("session_shutdown", event => {
    active = false; clearInterval(pollTimer); terminalOff?.(); terminalOff = undefined; cancel(); ctx?.ui.setWidget("swarm", undefined);
    if ((globalThis as any)[PENDING_COUNT_KEY] === pendingCount) delete (globalThis as any)[PENDING_COUNT_KEY];
    if (finished && event.reason === "quit" && ctx?.mode === "tui") process.once("exit", () => {
      const bin = process.env.HERDR_BIN_PATH || "herdr";
      const closer = spawn(process.execPath, ["--input-type=module", "-e", `import {execFileSync} from 'node:child_process';try{const bin=${JSON.stringify(bin)};const r=JSON.parse(execFileSync(bin,['pane','current','--current'],{encoding:'utf8',timeout:10000}));const id=r.result?.pane?.pane_id;if(typeof id==='string'&&id)execFileSync(bin,['pane','close',id],{timeout:10000});}catch{}`], { detached: true, stdio: "ignore" });
      closer.on("error", () => {}); closer.unref();
    });
  });
  return { history, archived, pending: (session: string) => [...pendingRuns(ctx!.sessionManager).values()].some(r => sessionPath(r.session) === sessionPath(session)), record(run: Run) {
    pi.appendEntry("swarm_spawn", run); const id = ctx!.sessionManager.getLeafId()!;
    if (!run.detach) runs.set(id, { ...run, launching: true }); widget(); return id;
  }, launched(id: string) { const run = runs.get(id); if (run) run.launching = false; } };
}
