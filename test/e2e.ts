import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { boardPath, readBoard } from "../src/board.ts";
import { readSession, type Run } from "../src/run.ts";

// Own the entire private server so every pane inherits the same no-network fixture configuration.
const server = `swarm-e2e-${process.pid}`;
assert.equal(process.env.HERDR_ENV, "1", "Run inside herdr.");
const exec = promisify(execFile);
async function cli(args: string[], timeout = 15_000): Promise<any> {
  const { stdout } = await exec("herdr", ["--session", server, ...args], { encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024 });
  const reply = JSON.parse(stdout); if (reply.error) throw new Error(JSON.stringify(reply.error)); return reply.result;
}
async function wait<T>(get: () => T | Promise<T>, label: string, timeout = 90_000): Promise<NonNullable<T>> {
  const until = Date.now() + timeout;
  while (Date.now() < until) { try { const value = await get(); if (value) return value as NonNullable<T>; } catch {} await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const base = mkdtempSync(join(tmpdir(), "swarm-e2e-")); const dir = join(base, "project"); const agentDir = join(base, "agent");
mkdirSync(dir); mkdirSync(join(agentDir, "extensions"), { recursive: true });
copyFileSync(join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "extensions/herdr-agent-state.ts"), join(agentDir, "extensions/herdr-agent-state.ts"));
writeFileSync(join(agentDir, "extensions/demo.ts"), `export {default} from ${JSON.stringify(resolve("test/e2e-peer.ts"))};`);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }));
const file = join(dir, "spawner.jsonl"); const board = boardPath(dir);
const marker = (steps: { tool: string; args: any }[]) => `SWARM_TEST:${JSON.stringify({ steps })}`;
const step = (tool: string, args: any = {}) => ({ tool, args });
const barrier = (name: string) => writeFileSync(join(dir, name), "released");
const entries = () => readSession(file).getBranch();
const records = () => entries().filter(e => e.type === "custom" && e.customType === "swarm_spawn");
const record = (name: string): Run => (records().filter(e => (e as any).data.name === name).at(-1) as any).data;
const results = (name: string) => entries().filter(e => e.type === "custom_message" && e.customType === "swarm_result" && (e.details as any).name === name);
const live = async () => (await cli(["agent", "list"])).agents as any[];
async function ended(name: string) { await wait(async () => !(await live()).some(a => a.name === name), `${name} ended`); }
async function ready(name: string) { await wait(async () => (await live()).find(a => a.name === name && ["idle", "done"].includes(a.agent_status)), `${name} ready`); }
let workspace: string | undefined; let pane: string | undefined;
async function startSpawner() {
  await cli(["agent", "start", "demo-spawner", "--kind", "pi", "--pane", pane!, "--timeout", "60000", "--", "--session", file, "-e", resolve("src/index.ts"), "--model", "swarm-e2e/scripted", "--thinking", "off"], 70_000);
}
async function invoke(tool: string, args: any = {}): Promise<any> {
  let before = 0; try { before = entries().length; } catch {}
  await cli(["agent", "prompt", "demo-spawner", marker([step(tool, args)])]);
  const result = await wait(() => entries().slice(before).find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === tool), `${tool} result`);
  await ready("demo-spawner"); return (result as any).message;
}
async function finish(name: string, count = 1) { await ended(name); await wait(() => results(name).length === count, `${name} archived`); await ready("demo-spawner"); }
let running = false; try { await cli(["agent", "list"]); running = true; } catch {}
assert.equal(running, false, `Private server ${server} already exists; refusing to reuse it.`);
const daemon = spawn("herdr", ["--session", server, "server"], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SWARM_E2E: "1", PI_SWARM_MAX_AGENTS: "3" }, stdio: "ignore" });
try {
  await wait(() => cli(["agent", "list"]), "private server startup");
  assert.equal((await live()).length, 0);
  const created = await cli(["workspace", "create", "--no-focus", "--label", "swarm-demo", "--cwd", dir, "--env", `PI_CODING_AGENT_DIR=${agentDir}`, "--env", "PI_SWARM_E2E=1", "--env", "PI_SWARM_MAX_AGENTS=3"]);
  workspace = created.workspace.workspace_id; pane = created.root_pane.pane_id;
  await startSpawner();
  const taskA = marker([step("e2e_wait", { file: "start" }), step("swarm_send", { to: "demo-b", message: "A_DIRECT" }), step("swarm_send", { to: "*", message: "A_BROADCAST" }), step("e2e_wait", { file: "finish" })]);
  const taskB = marker([step("e2e_wait", { file: "start" }), step("swarm_send", { to: "demo-a", message: "B_DIRECT" }), step("e2e_wait", { file: "finish" })]);
  assert.equal((await invoke("swarm_spawn", { name: "demo-a", task: taskA })).isError, false);
  assert.equal((await invoke("swarm_spawn", { name: "demo-b", task: taskB })).isError, false);
  const a = record("demo-a");

  // Native terminal connection and delivery, not fake-herdr error classification.
  await invoke("swarm_send", { message: "BOARD_ONLY" });
  assert.ok((await readBoard(board)).some(n => n.message === "BOARD_ONLY"));
  const tooLong = await invoke("swarm_send", { message: "x".repeat(4001) }); assert.equal(tooLong.isError, true);
  const capped = await invoke("swarm_spawn", { name: "too-many", task: "no launch" }); assert.equal(capped.isError, true);
  assert.equal((await live()).some(a => a.name === "too-many"), false);
  await cli(["agent", "rename", a.pane, "--clear"]); await sleep(2200); assert.equal(results("demo-a").length, 0);
  assert.equal((await invoke("swarm_spawn", { resume: "demo-a", task: "no duplicate process" })).isError, true);
  await cli(["agent", "rename", a.pane, "demo-a"]);
  barrier("start");
  await wait(async () => { const notes = await readBoard(board); return ["A_DIRECT", "B_DIRECT", "A_BROADCAST"].every(text => notes.some(n => n.message === text)); }, "mutual sends and broadcast");
  barrier("finish"); await finish("demo-a"); await finish("demo-b");
  assert.ok(readSession(record("demo-b").session).getBranch().some(e => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes("A_DIRECT")));
  assert.ok(readSession(a.session).getBranch().some(e => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes("B_DIRECT")));
  console.log("communication: native mutual messages, broadcast and board-only passed");

  await invoke("swarm_spawn", { name: "detached", task: marker([]), detach: true }); await ended("detached");
  await wait(async () => (await readBoard(board)).some(n => n.from === "detached" && n.kind === "result" && n.to === "*"), "detached board result");
  assert.equal(record("detached").detach, true); assert.equal(results("detached").length, 0);
  const boundary = readSession(a.session).getLeafId();
  await invoke("swarm_spawn", { resume: "demo-a", task: marker([]) }); await finish("demo-a", 2);
  assert.equal(record("demo-a").session, a.session); assert.equal(record("demo-a").boundary, boundary);
  await invoke("swarm_spawn", { resume: "demo-a", task: "/e2e-no-reply" }); await finish("demo-a", 3);
  assert.equal((results("demo-a").at(-1) as any).details.status, "empty");
  assert.match(String((results("demo-a").at(-1) as any).content), /No new reply in this run/);
  console.log("startup/history: detach and consecutive same-session resume passed");

  // A manually launched pi on that same session has no internal launch flags.
  const manualPane = (await cli(["tab", "create", "--workspace", workspace!, "--no-focus", "--cwd", dir])).root_pane.pane_id;
  await cli(["agent", "start", "manual", "--kind", "pi", "--pane", manualPane, "--", "--session", a.session, "-e", resolve("src/index.ts"), "--model", "swarm-e2e/scripted"], 70_000);
  await cli(["agent", "prompt", "manual", marker([])]); await ready("manual"); await sleep(1200);
  assert.ok((await live()).some(a => a.name === "manual")); await cli(["agent", "prompt", "manual", "/e2e-no-reply"]); await ended("manual");

  await invoke("swarm_spawn", { name: "question", task: marker([step("e2e_question")]) });
  await wait(async () => (await live()).some(a => a.name === "question" && a.agent_status === "blocked"), "native blocked dialog");
  await wait(() => entries().filter(e => e.type === "custom_message" && e.customType === "swarm_notice" && String(e.content).includes("question is blocked")).length === 1, "blocked notice");
  await sleep(2200); assert.equal(entries().filter(e => e.type === "custom_message" && e.customType === "swarm_notice" && String(e.content).includes("question is blocked")).length, 1);
  await cli(["agent", "send-keys", "question", "esc"]);
  // Escape intentionally leaves the peer open; a fresh task allows its automatic completion.
  await ready("question"); await cli(["agent", "prompt", "question", marker([])]); await finish("question");
  console.log("supervision: lost name, live session and blocked edge passed");

  await invoke("swarm_spawn", { name: "restart-peer", task: marker([step("e2e_wait", { file: "restart-finish" })]) });
  await cli(["agent", "prompt", "demo-spawner", "/e2e-no-reply"]); await ended("demo-spawner"); await startSpawner();
  assert.equal((await invoke("e2e_state")).content[0].text, "1"); barrier("restart-finish"); await finish("restart-peer");
  console.log("history: spawner restart restores waiting without stopping peers");

  await invoke("swarm_spawn", { name: "escape-peer", task: marker([step("e2e_wait", { file: "escape-finish" })]) });
  await cli(["agent", "prompt", "demo-spawner", marker([step("e2e_wait", { file: "spawner-hold" })])]);
  await wait(async () => (await live()).some(a => a.name === "demo-spawner" && a.agent_status === "working"), "busy spawner");
  barrier("escape-finish"); await ended("escape-peer"); await sleep(1300); await cli(["agent", "send-keys", "demo-spawner", "esc"]); await ready("demo-spawner");
  await wait(() => results("escape-peer").length === 1, "result survives Escape");
  await invoke("e2e_state"); assert.equal(results("escape-peer").length, 1);
  console.log("cancellation: busy Escape keeps exactly one result and continuation processes it");

  // A real trust dialog returns not-ready, but the pre-start record is already durable.
  const untrusted = join(base, "untrusted"); mkdirSync(join(untrusted, ".pi"), { recursive: true }); writeFileSync(join(untrusted, ".pi/settings.json"), "{}");
  const startup = await invoke("swarm_spawn", { name: "trust-test", cwd: untrusted, task: "never submitted while blocked" });
  assert.equal(startup.isError, true); assert.match(JSON.stringify(startup.content), /agent_not_ready|Session identity unavailable/); assert.ok(record("trust-test").session);
  const dialog = await exec("herdr", ["--session", server, "pane", "read", record("trust-test").pane, "--source", "recent-unwrapped", "--lines", "30"], { encoding: "utf8" });
  assert.match(dialog.stdout, /Trust project folder/);
  await cli(["pane", "close", record("trust-test").pane]); await finish("trust-test");
  console.log("startup: real trust-blocked launch retains its record and session path");
  console.log(`PASS: isolated herdr demo (${server})`);
} catch (error) {
  try { const agents = await live(); console.error(JSON.stringify(agents)); for (const agent of agents) console.error(JSON.stringify(await cli(["agent", "read", agent.pane_id, "--source", "recent-unwrapped", "--lines", "50"]))); } catch {}
  if (pane) { try { const output = await exec("herdr", ["--session", server, "pane", "read", pane, "--source", "recent-unwrapped", "--lines", "80"], { encoding: "utf8" }); console.error(output.stdout); } catch {} }
  throw error;
} finally {
  if (workspace) await cli(["workspace", "close", workspace]).catch(error => console.error(error));
  await exec("herdr", ["session", "stop", server], { encoding: "utf8" }).catch(error => console.error(error));
  await new Promise<void>(done => { if (daemon.exitCode !== null) done(); else daemon.once("exit", () => done()); });
  rmSync(base, { recursive: true, force: true });
}
