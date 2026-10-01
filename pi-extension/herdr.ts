import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative, resolve, isAbsolute } from "node:path";
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
    if (!stdout.trim()) return undefined;
    const reply = JSON.parse(stdout);
    if (reply.error) throw new HerdrError(reply.error.code, reply.error.message);
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
export interface LiveAgent { name?: string; pane_id: string; agent_status?: string; agent: string; cwd?: string; foreground_cwd?: string }
export function inProject(agent: LiveAgent, project: string): boolean {
  const cwd = agent.cwd || agent.foreground_cwd;
  if (!agent.name || !cwd) return false;
  const path = relative(resolve(project), resolve(cwd));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
export async function list(): Promise<LiveAgent[]> { return (await herdr(["agent", "list"])).agents; }
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
export async function identity(): Promise<string> {
  requireHerdr();
  if (process.env.PI_SWARM_NAME) return validateName(process.env.PI_SWARM_NAME);
  const pane = (await herdr(["pane", "current", "--current"])).pane.pane_id;
  const agents = await list();
  const own = agents.find(a => a.pane_id === pane);
  if (!own) throw new Error("herdr does not recognize pi in the caller's pane.");
  if (own.name) return own.name;
  const name = availableName("swarm", agents);
  await herdr(["agent", "rename", pane, name]);
  return name;
}

export function addressPattern(address: string): RegExp | undefined {
  if (!address.includes("*")) { validateName(address); return undefined; }
  if (!/^[a-z0-9_*-]{1,128}$/.test(address)) throw new Error("Wildcard addresses support only name characters and '*', not '?', brackets or other glob syntax.");
  return new RegExp(`^${address.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*")}$`);
}
export interface Delivery { to: string; submitted: boolean; error?: string }
/** Persist even a failed private message BEFORE discovering or prompting recipients. No retries. */
export async function send(path: string, input: Pick<Note, "from" | "to" | "message"> & Partial<Pick<Note, "tags" | "kind">>, ttl?: number): Promise<{ note: Note; deliveries: Delivery[] }> {
  const pattern = addressPattern(input.to);
  const note = post(path, input, ttl);
  let targets: string[];
  try {
    targets = pattern ? (await list()).filter(a => a.name !== input.from && inProject(a, process.env.PI_SWARM_PROJECT || process.cwd()) && pattern.test(a.name!)).map(a => a.name!) : [input.to];
  } catch (error) {
    return { note, deliveries: [{ to: input.to, submitted: false, error: String(error) }] };
  }
  const deliveries = await Promise.all(targets.map(async to => {
    try {
      await herdr(["agent", "prompt", to, formatNote(note)]);
      return { to, submitted: true };
    } catch (error) { return { to, submitted: false, error: String(error) }; }
  }));
  return { note, deliveries };
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
      await herdr(["agent", "prompt", launch.name, launch.task]);
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
