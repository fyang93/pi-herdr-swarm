import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
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
  if (!agent.name || !cwd) return false;
  const canonical = await realpath(cwd);
  if (!roots.has(canonical)) roots.set(canonical, await projectRoot(canonical));
  return roots.get(canonical) === project;
}
export async function list(): Promise<LiveAgent[]> { return (await herdr(["agent", "list"])).agents; }
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
export function availableName(base: string, agents: LiveAgent[]): string {
  base = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 26) || "swarm";
  let name = base;
  for (let n = 2; agents.some(a => a.name === name); n++) name = `${base}-${n}`;
  return name;
}
export function identity(named?: (name: string) => void): Promise<string> {
  // ponytail: share the local creation queue; split naming out if ready-waits delay sends. herdr owns uniqueness.
  const next = creationQueue.then(async () => {
    requireHerdr();
    const pane = (await herdr(["pane", "current", "--current"])).pane.pane_id;
    for (;;) {
      const own = await get(pane);
      if (!own) throw new Error("herdr does not recognize pi in the caller's pane.");
      if (own.name) return validateName(own.name);
      const name = availableName("swarm", await list());
      try {
        await herdr(["agent", "rename", pane, name]);
      } catch (error) {
        const confirmed = await get(pane);
        if (confirmed?.name) { named?.(confirmed.name); return validateName(confirmed.name); }
        if (error instanceof HerdrError && ["agent_name_taken", "name_taken"].includes(error.code)) continue;
        throw error; // An uncertain rename is never blindly repeated.
      }
      const confirmed = await get(pane);
      if (!confirmed?.name) throw new Error("herdr did not confirm the agent name; inspect the caller pane before retrying.");
      named?.(confirmed.name);
      return validateName(confirmed.name);
    }
  });
  creationQueue = next.catch(() => {});
  return next;
}

export function addressPattern(address: string): RegExp | undefined {
  if (!address.includes("*")) { validateName(address); return undefined; }
  if (!/^[a-z0-9_*-]{1,128}$/.test(address)) throw new Error("Wildcard addresses support only name characters and '*', not '?', brackets or other glob syntax.");
  return new RegExp(`^${address.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*")}$`);
}
export interface Delivery { to: string; status: "submitted" | "rejected" | "unknown"; code?: string; error?: string }
function failure(error: unknown): Omit<Delivery, "to"> {
  const code = error instanceof HerdrError ? error.code : (error as any)?.code;
  const rejected = ["agent_not_found", "not_found", "agent_blocked", "agent_not_ready", "invalid_params", "unsupported_agent"].includes(code);
  return { status: rejected ? "rejected" : "unknown", code: typeof code === "string" ? code : undefined, error: String(error) };
}
/** Commit before discovery and native steer (text + Enter). Never replay an uncertain submission. */
export async function send(path: string, input: Pick<Note, "from" | "message"> & Partial<Pick<Note, "to" | "tags" | "kind">>, ttl?: number, project?: { root: string; roots: Map<string, string> }) {
  const board = resolve(path);
  const boardOnly = input.to === undefined;
  const pattern = boardOnly ? undefined : addressPattern(input.to!);
  const note = post(board, { ...input, to: input.to ?? "*" }, ttl);
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
    return { board, note, deliveries, boardOnly, discovery: failure(error) };
  }
  deliveries.push(...await Promise.all(targets.map(async (to): Promise<Delivery> => {
    try {
      if (!await get(to)) throw new HerdrError("agent_not_found", `Agent ${to} is not addressable.`);
      await prompt(to, formatNote(note, board));
      return { to, status: "submitted" };
    } catch (error) { return { to, ...failure(error) }; }
  })));
  return { board, note, deliveries, boardOnly };
}

export function splitDirection(width: number, height: number): "right" | "down" | undefined {
  // Account for the one-cell divider: both resulting panes must remain >= 50x15.
  const fits = { right: Math.floor((width - 1) / 2) >= 50 && height >= 15, down: width >= 50 && Math.floor((height - 1) / 2) >= 15 };
  return (height * 2 > width ? ["down", "right"] as const : ["right", "down"] as const).find(d => fits[d]);
}
let creationQueue: Promise<unknown> = Promise.resolve();
export function start(launch: { name: string; cwd: string; args: string[]; env: Record<string, string>; task: string }): Promise<{ name: string; pane: string }> {
  // Local layout serialization, not a distributed name claim. herdr enforces uniqueness.
  const next = creationQueue.then(async () => {
    requireHerdr();
    validateName(launch.name);
    if ((await list()).some(a => a.name === launch.name)) throw new Error(`Agent ${launch.name} is already live.`);
    const parent = (await herdr(["pane", "current", "--current"])).pane.pane_id;
    const { layout } = await herdr(["pane", "layout", "--pane", parent]);
    const own = !layout.zoomed && layout.panes.find((p: any) => p.pane_id === parent);
    const direction = own && splitDirection(own.rect.width, own.rect.height);
    const env = Object.entries(launch.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    const pane: string = direction
      ? (await herdr(["pane", "split", parent, "--direction", direction, "--no-focus", "--cwd", launch.cwd, ...env])).pane.pane_id
      : (await herdr(["tab", "create", "--workspace", process.env.HERDR_WORKSPACE_ID!, "--no-focus", "--label", launch.name, "--cwd", launch.cwd, ...env])).root_pane.pane_id;
    try {
      await herdr(["agent", "start", launch.name, "--kind", "pi", "--pane", pane, "--timeout", "60000", "--", ...launch.args], 70_000);
      await prompt(launch.name, launch.task);
      return { name: launch.name, pane };
    } catch (error) {
      // Keep blocked or uncertain deliveries inspectable; do not replay a possible submission.
      if (error instanceof HerdrError && ["agent_start_failed", "agent_name_taken"].includes(error.code)) {
        const output = await herdr(["pane", "read", pane, "--lines", "20"], 10_000, true).catch(() => "");
        await herdr(["pane", "close", pane]).catch(() => {});
        throw new Error(`${error.message}\n${output}`);
      }
      throw new Error(`${String(error)}; pane ${pane} kept for inspection. Task may or may not have been submitted; do not blindly retry.`);
    }
  });
  creationQueue = next.catch(() => {});
  return next;
}
