import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { post, formatNote, type Note } from "./board.ts";

const exec = promisify(execFile);
export class HerdrError extends Error {
  code: string;
  constructor(code: string, message: string) { super(`herdr ${code}: ${message}`); this.code = code; }
}
export async function herdr(args: string[], timeout = 10_000, raw = false): Promise<any> {
  try {
    const { stdout } = await exec(process.env.HERDR_BIN_PATH || "herdr", args, { encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 });
    if (raw) return stdout;
    if (!stdout.trim()) throw new Error("Empty herdr reply; outcome unknown.");
    const reply = JSON.parse(stdout);
    if (reply?.error) throw new HerdrError(reply.error.code, reply.error.message);
    if (!reply || typeof reply !== "object" || !("result" in reply)) throw new Error("Malformed herdr reply; outcome unknown.");
    return reply.result;
  } catch (error: any) {
    for (const output of [error.stdout, error.stderr]) {
      if (typeof output !== "string" || !output.trim().startsWith("{")) continue;
      let reply: any;
      try { reply = JSON.parse(output); } catch { continue; }
      if (reply.error) throw new HerdrError(reply.error.code, reply.error.message);
    }
    throw error;
  }
}
export interface LiveAgent { name?: string; pane_id: string; agent_status?: string; agent: string; cwd?: string; foreground_cwd?: string; agent_session?: { kind: string; value: string } }
export async function projectRoot(cwd: string): Promise<string> {
  const canonical = await realpath(cwd);
  try {
    const { stdout } = await exec("git", ["-C", canonical, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C" } });
    if (!stdout.trim()) throw new Error("git returned an empty project root");
    return await realpath(stdout.trim());
  } catch (error: any) {
    if (error.code === 128 && /^fatal: not a git repository(?: \(|:)/.test(error.stderr || "")) return canonical;
    throw new Error(`Cannot resolve project root for ${canonical}: ${String(error)}`);
  }
}
export async function inProject(agent: LiveAgent, project: string, roots: Map<string, string>): Promise<boolean> {
  const cwd = agent.cwd || agent.foreground_cwd;
  if (!cwd) throw new Error(`Project cwd unknown for pane ${agent.pane_id}.`);
  const canonical = await realpath(cwd);
  if (!roots.has(canonical)) roots.set(canonical, await projectRoot(canonical));
  return roots.get(canonical) === project;
}
export async function list(): Promise<LiveAgent[]> {
  const agents = (await herdr(["agent", "list"]))?.agents;
  if (!Array.isArray(agents) || agents.some(a => !a || typeof a.pane_id !== "string")) throw new Error("Malformed herdr agent list reply; state unknown.");
  return agents;
}
export function sessionPath(path: string): string {
  try { return realpathSync(path); } catch (error: any) { if (error.code === "ENOENT") return resolve(path); throw error; }
}
const hasSessionPath = (a: LiveAgent) => a.agent_session?.kind === "path" && typeof a.agent_session.value === "string" && !!a.agent_session.value;
/**
 * The live agent bound to `session`, by session path rather than name (running agents can lose names).
 * Throws while any pi is starting or reports no session: the binding cannot be ruled out yet.
 */
export function sessionBinding(agents: LiveAgent[], session: string): LiveAgent | undefined {
  const uncertain = agents.some(a => a.agent_status === "starting" || ((a.agent === "pi" || a.agent === "starting") && !hasSessionPath(a)));
  if (uncertain) throw new Error("herdr session bindings unknown; still waiting.");
  return agents.find(a => hasSessionPath(a) && sessionPath(a.agent_session!.value) === sessionPath(session));
}
export async function get(name: string): Promise<LiveAgent | undefined> {
  try {
    const agent = (await herdr(["agent", "get", name]))?.agent;
    if (!agent || typeof agent.pane_id !== "string" || !agent.pane_id) throw new Error("Malformed herdr agent get reply; binding unknown.");
    return agent as LiveAgent;
  }
  catch (error) {
    if (error instanceof HerdrError && ["agent_not_found", "not_found"].includes(error.code)) return undefined;
    throw error;
  }
}
async function prompt(to: string, text: string): Promise<void> {
  const result = await herdr(["agent", "prompt", to, text]);
  if (result?.type !== "agent_prompted") throw new Error("Malformed herdr prompt reply; submission unknown.");
}
export function requireHerdr(): void {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) throw new Error("Start pi inside a herdr pane.");
}
export function validateName(name: string): string {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error("Agent names must match [a-z][a-z0-9_-]{0,31}.");
  return name;
}
export function availableName(base: string, agents: LiveAgent[], history: Iterable<string> = []): string {
  base = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 26) || "swarm";
  const used = new Set([...agents.map(a => a.name), ...history]);
  for (let n = 1; ; n++) { const name = `${base}-${n}`; if (!used.has(name)) return name; }
}
/** This session's herdr name; an unnamed caller is named after its pane (unique while online), never renamed. */
export async function identity(named?: (name: string) => void): Promise<string> {
  requireHerdr();
  const pane = (await herdr(["pane", "current", "--current"])).pane.pane_id;
  const own = await get(pane);
  if (!own) throw new Error("herdr does not recognize pi in the caller's pane.");
  if (own.name) return validateName(own.name);
  const name = validateName(`swarm-${pane.replace(":", "-").toLowerCase()}`);
  const confirmed = (await herdr(["agent", "rename", pane, name])).agent;
  if (confirmed?.pane_id !== pane || !confirmed.name) throw new Error("herdr did not confirm the agent name; inspect the caller pane.");
  named?.(validateName(confirmed.name));
  return confirmed.name;
}

export function addressPattern(address: string): RegExp | undefined {
  if (!address.includes("*")) { validateName(address); return undefined; }
  if (!/^[a-z0-9_*-]{1,128}$/.test(address)) throw new Error("Wildcard addresses support only name characters and '*', not '?', brackets or other glob syntax.");
  return new RegExp(`^${address.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*")}$`);
}
export interface Delivery { to: string; status: "submitted" | "rejected" | "unknown"; code?: string; error?: string }
export function deliveryOutcome(error?: unknown): Omit<Delivery, "to"> {
  if (error === undefined) return { status: "submitted" };
  const code = error instanceof HerdrError ? error.code : (error as any)?.code;
  const rejected = ["agent_not_found", "not_found", "agent_blocked", "agent_not_ready", "invalid_params", "unsupported_agent"].includes(code);
  return { status: rejected ? "rejected" : "unknown", code: typeof code === "string" ? code : undefined, error: String(error) };
}
/** Commit before discovery and native steer (text + Enter). Never replay an uncertain submission. */
export async function send(path: string, input: Pick<Note, "from" | "message"> & Partial<Pick<Note, "to" | "kind">>, project?: { root: string; roots: Map<string, string> }, report?: (warning: string) => void) {
  const board = resolve(path);
  const boardOnly = input.to === undefined;
  const pattern = boardOnly ? undefined : addressPattern(input.to!);
  const note = await post(board, { ...input, to: input.to ?? "*" }, report);
  const deliveries: Delivery[] = [];
  if (boardOnly) return { board, note, deliveries, boardOnly };
  let targets: string[];
  try {
    if (pattern) {
      const scope = project ?? { root: await projectRoot(process.cwd()), roots: new Map<string, string>() };
      const agents = (await list()).filter(a => a.name && a.name !== input.from && pattern.test(a.name));
      targets = [];
      for (const agent of agents) if (await inProject(agent, scope.root, scope.roots)) targets.push(agent.name!);
    } else targets = [input.to!];
  } catch (error) {
    return { board, note, deliveries, boardOnly, discovery: deliveryOutcome(error) };
  }
  deliveries.push(...await Promise.all(targets.map(async (to): Promise<Delivery> => {
    try {
      await prompt(to, formatNote(note));
      return { to, ...deliveryOutcome() };
    } catch (error) { return { to, ...deliveryOutcome(error) }; }
  })));
  return { board, note, deliveries, boardOnly };
}

export function splitDirection(width: number, height: number): "right" | "down" | undefined {
  // Account for the one-cell divider: both resulting panes must remain >= 50x15.
  const fits = { right: Math.floor((width - 1) / 2) >= 50 && height >= 15, down: width >= 50 && Math.floor((height - 1) / 2) >= 15 };
  return (height * 2 > width ? ["down", "right"] as const : ["right", "down"] as const).find(d => fits[d]);
}
let creationQueue: Promise<unknown> = Promise.resolve();
export interface Launch {
  name: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
  task: string;
  session?: string;
  resume?: boolean;
  maxAgents?: number;
  /** Called with the new pane before the agent starts, so the spawn record exists even if start blocks. */
  beforeStart?: (pane: string) => void;
}
export function start(launch: Launch): Promise<{ name: string; pane: string }> {
  // Local layout serialization, not a distributed name claim. herdr enforces uniqueness.
  const next = creationQueue.then(async () => {
    requireHerdr();
    validateName(launch.name);
    const agents = await list();
    if (agents.some(a => a.name === launch.name)) throw new Error(`Agent ${launch.name} is already live.`);
    if (launch.resume && launch.session && sessionBinding(agents, launch.session)) throw new Error(`Session is already live: ${launch.session}`);
    const max = launch.maxAgents ?? 16;
    if (!Number.isSafeInteger(max) || max <= 0) throw new Error("PI_SWARM_MAX_AGENTS must be a positive integer.");
    const target = await projectRoot(launch.cwd);
    let count = 0;
    const roots = new Map<string, string>();
    for (const agent of agents) if (await inProject(agent, target, roots)) count++;
    if (count >= max) throw new Error(`Agent admission refused: ${count}/${max} online in ${target}.`);
    const callerPane = (await herdr(["pane", "current", "--current"])).pane.pane_id;
    const { layout } = await herdr(["pane", "layout", "--pane", callerPane]);
    const own = !layout.zoomed && layout.panes.find((p: any) => p.pane_id === callerPane);
    const direction = own && splitDirection(own.rect.width, own.rect.height);
    const env = Object.entries(launch.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    const pane: string = direction
      ? (await herdr(["pane", "split", callerPane, "--direction", direction, "--no-focus", "--cwd", launch.cwd, ...env])).pane.pane_id
      : (await herdr(["tab", "create", "--workspace", process.env.HERDR_WORKSPACE_ID!, "--no-focus", "--label", launch.name, "--cwd", launch.cwd, ...env])).root_pane.pane_id;
    try {
      launch.beforeStart?.(pane);
      await herdr(["agent", "start", launch.name, "--kind", "pi", "--pane", pane, "--timeout", "60000", "--", ...launch.args], 70_000);
      if (launch.session) {
        const agent = await get(launch.name);
        if (agent?.agent_session?.kind !== "path" || sessionPath(agent.agent_session.value) !== sessionPath(launch.session)) throw new Error(`Session identity unavailable or mismatched for ${launch.name}; expected ${launch.session}`);
      }
      await prompt(launch.name, launch.task);
      return { name: launch.name, pane };
    } catch (error) {
      // Keep blocked or uncertain deliveries inspectable; do not replay a possible submission.
      if (error instanceof HerdrError && ["agent_start_failed", "agent_name_taken"].includes(error.code)) {
        const output = await herdr(["pane", "read", pane, "--lines", "20"], 10_000, true).catch(() => "");
        await herdr(["pane", "close", pane]).catch(() => {});
        throw new Error(`${error.message}; pane ${pane}; session ${launch.session || "unspecified"}\n${output}`);
      }
      throw new Error(`${String(error)}; pane ${pane} kept for inspection; session ${launch.session || "unspecified"}. Task may or may not have been submitted; do not blindly retry.`);
    }
  });
  creationQueue = next.catch(() => {});
  return next;
}
