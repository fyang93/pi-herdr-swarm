import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readSession, type Run } from "../src/run.ts";
import { summary } from "../src/herdr.ts";

// Own the entire private server so every pane inherits the same no-network fixture configuration.
const server = `swarm-e2e-${process.pid}`;
assert.equal(process.env.HERDR_ENV, "1", "Run inside herdr.");
const exec = promisify(execFile);
async function cli(args: string[], timeout = 15_000): Promise<any> {
  const { stdout } = await exec("herdr", ["--session", server, ...args], { encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024 });
  if (args[0] === "pane" && args[1] === "run") return; // native pane run has no JSON reply
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
mkdirSync(join(agentDir, "agents"), { recursive: true });
writeFileSync(join(agentDir, "agents/script-runner.md"), "---\ndescription: Run isolated scripted tasks\nmodel: swarm-e2e/scripted\nthinking: off\ncan-spawn: true\n---\nRun the scripted task.");
writeFileSync(join(agentDir, "extensions/demo.ts"), `export {default} from ${JSON.stringify(resolve("test/e2e-peer.ts"))};`);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", swarm: { maxAgents: 3 } }));
const file = join(dir, "spawner.jsonl");
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
let workspace: string | undefined; let pane: string | undefined; let identityPane: string | undefined;
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
const daemon = spawn("herdr", ["--session", server, "server"], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SWARM_E2E: "1" }, stdio: "ignore" });
try {
  await wait(() => cli(["agent", "list"]), "private server startup");
  assert.equal((await live()).length, 0);
  const created = await cli(["workspace", "create", "--no-focus", "--label", "swarm-demo", "--cwd", dir, "--env", `PI_CODING_AGENT_DIR=${agentDir}`, "--env", "PI_SWARM_E2E=1"]);
  workspace = created.workspace.workspace_id; pane = created.root_pane.pane_id;
  await startSpawner();
  const taskA = marker([step("e2e_wait", { file: "start" }), step("swarm_send", { to: "demo-b", message: "A_DIRECT" }), step("swarm_send", { to: ["demo-b", "demo-spawner"], message: "A_GROUP" }), step("e2e_wait", { file: "finish" })]);
  const taskB = marker([step("e2e_wait", { file: "start" }), step("swarm_send", { to: "demo-a", message: "B_DIRECT" }), step("e2e_wait", { file: "finish" })]);
  assert.equal((await invoke("swarm_spawn", { name: "demo-a", task: taskA })).isError, false);
  assert.equal((await invoke("swarm_spawn", { name: "demo-b", task: taskB })).isError, false);
  const a = record("demo-a");
  const roster = await invoke("swarm_list");
  assert.equal(roster.details.self, "demo-spawner");
  assert.equal(roster.details.agents.find((a: any) => a.name === "demo-spawner").title, undefined, "plain pi publishes no title");
  assert.equal(roster.details.agents.find((a: any) => a.name === "demo-a").title, Array.from(`peer · ${summary(taskA)}`).slice(0, 80).join(""));
  assert.match(roster.content[0].text, /demo-a · peer · SWARM_TEST:/);
  await wait(async () => {
    const { stdout } = await exec("herdr", ["--session", server, "pane", "read", pane!, "--source", "recent-unwrapped", "--lines", "80"], { encoding: "utf8" });
    return /\d+:\d{2}\s+demo-a.*working · e2e_wait/.test(stdout);
  }, "live widget clock and current tool");
  console.log("identity/widget: native pane titles, roster and live tool/elapsed display passed");

  // Native terminal connection and delivery, not fake-herdr error classification.
  assert.equal((await invoke("swarm_send", { message: "MISSING_TO" })).isError, true);
  const tooLong = await invoke("swarm_send", { to: "demo-a", message: "x".repeat(4001) }); assert.equal(tooLong.isError, true);
  const capped = await invoke("swarm_spawn", { name: "too-many", task: "no launch" }); assert.equal(capped.isError, true);
  assert.equal((await live()).some(a => a.name === "too-many"), false);
  await cli(["agent", "rename", a.pane, "--clear"]); await sleep(2200); assert.equal(results("demo-a").length, 0);
  assert.equal((await invoke("swarm_spawn", { resume: "demo-a", task: "no duplicate process" })).isError, true);
  await cli(["agent", "rename", a.pane, "demo-a"]);
  barrier("start");
  const received = (session: string, text: string) => readSession(session).getBranch().some(e => e.type === "message" && e.message.role === "user" && (typeof e.message.content === "string" ? e.message.content : e.message.content.filter(c => c.type === "text").map(c => c.text).join("\n")).includes(text));
  await sleep(3000); // let both peers send while blocked in their wait tool; steers land after it returns
  barrier("finish"); await finish("demo-a"); await finish("demo-b");
  assert.ok(received(record("demo-b").session, "A_DIRECT") && received(record("demo-b").session, "A_GROUP") && received(a.session, "B_DIRECT"), "mutual sends and exact recipient array");
  assert.ok(received(file, "A_GROUP"), "explicit recipients include the spawner");
  console.log("communication: native mutual messages and exact recipient arrays passed");

  await invoke("swarm_spawn", { name: "wait-peer", task: marker([step("swarm_send", { to: "demo-spawner", message: "WAIT_QUESTION", wait: true })]) });
  await wait(() => received(file, "WAIT_QUESTION"), "ordinary waiting message");
  await ready("wait-peer"); await sleep(1200);
  assert.equal(results("wait-peer").length, 0);
  assert.equal(readSession(record("wait-peer").session).getBranch().some(e => e.type === "message" && e.message.role === "assistant" && e.message.content.some(c => c.type === "toolCall" && c.name === "swarm_send")), true, "waiting turn ended at swarm_send, not a final assistant reply");
  await invoke("swarm_send", { to: "wait-peer", message: "WAIT_ANSWER" });
  await finish("wait-peer");
  console.log("waiting: ordinary native send parks a peer; ordinary reply resumes and returns its result");

  const scriptPane = (await cli(["tab", "create", "--workspace", workspace!, "--no-focus", "--cwd", dir])).root_pane.pane_id;
  await cli(["agent", "start", "script-runner", "--kind", "pi", "--pane", scriptPane, "--", "--session", join(dir, "script.jsonl"), "-e", resolve("src/index.ts"), "--swarm-agent", "script-runner", "--swarm-exit"], 70_000);
  assert.equal((await live()).find(a => a.name === "script-runner").title, "script-runner · Run isolated scripted tasks");
  await cli(["agent", "prompt", "script-runner", marker([step("swarm_send", { to: "demo-spawner", message: "SCRIPT_WAIT", wait: true })])]);
  await wait(() => received(file, "SCRIPT_WAIT"), "script waiting message");
  await ready("script-runner"); await sleep(1200);
  assert.ok((await live()).some(a => a.name === "script-runner"), "script role stays online while waiting");
  await cli(["agent", "prompt", "script-runner", marker([])]);
  await ended("script-runner");
  await wait(async () => { try { await cli(["pane", "get", scriptPane]); return false; } catch { return true; } }, "script pane closed after exit");
  console.log("script roles: settled --swarm-exit session handles a plain herdr follow-up, then exits and closes its pane");

  // Direct pi startup, not herdr agent start: names must exist before any swarm tool is called.
  const unnamedPane = (await cli(["tab", "create", "--workspace", workspace!, "--no-focus", "--cwd", dir])).root_pane.pane_id;
  identityPane = unnamedPane;
  await cli(["pane", "run", unnamedPane, `pi --session ${join(dir, "unnamed.jsonl")} -e ${resolve("src/index.ts")} --swarm-agent script-runner`]);
  const unnamed = await wait(async () => (await live()).find(a => a.pane_id === unnamedPane && a.name === "script-runner-1" && a.title === "script-runner · Run isolated scripted tasks"), "preset startup name/title without tools");
  await ready(unnamed.name);
  await cli(["agent", "prompt", unnamed.name, "/e2e-no-reply"]); await ended(unnamed.name);
  await cli(["pane", "run", unnamedPane, `pi --session ${join(dir, "plain.jsonl")} -e ${resolve("src/index.ts")} --model swarm-e2e/scripted`]);
  const plain = await wait(async () => (await live()).find(a => a.pane_id === unnamedPane && a.name), "manual startup name without tools");
  assert.equal(plain.title, undefined, "ending the preset clears its native title on the same pane");
  await ready(plain.name);
  await cli(["agent", "prompt", plain.name, "/e2e-no-reply"]); await ended(plain.name);
  await cli(["pane", "close", unnamedPane]);
  console.log("startup/cleanup: unnamed preset self-reports before tools; subsequent plain pi has no stale title");

  await invoke("swarm_spawn", { name: "monitor", task: marker([step("e2e_wait", { file: "monitor-change" }), step("swarm_send", { to: "demo-spawner", message: "MONITOR_CHANGE" }), step("e2e_wait", { file: "monitor-stop" })]) });
  assert.ok((await live()).some(a => a.name === "monitor"), "a running monitor stays online");
  assert.equal(results("monitor").length, 0);
  barrier("monitor-change"); await wait(() => received(file, "MONITOR_CHANGE"), "monitor update while still running");
  assert.ok((await live()).some(a => a.name === "monitor")); assert.equal(results("monitor").length, 0);
  barrier("monitor-stop"); await finish("monitor");
  console.log("monitoring: updates arrive during the task; stop returns one result and closes the peer");
  const boundary = readSession(a.session).getLeafId();
  await invoke("swarm_spawn", { resume: "demo-a", task: marker([]) }); await finish("demo-a", 2);
  assert.equal(record("demo-a").session, a.session); assert.equal(record("demo-a").boundary, boundary);
  await invoke("swarm_spawn", { resume: "demo-a", task: "/e2e-no-reply" }); await finish("demo-a", 3);
  assert.equal((results("demo-a").at(-1) as any).details.status, "empty");
  assert.match(String((results("demo-a").at(-1) as any).content), /No new reply in this run/);
  console.log("startup/history: consecutive same-session resume passed");

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
  if (identityPane) { try { const output = await exec("herdr", ["--session", server, "pane", "read", identityPane, "--source", "recent-unwrapped", "--lines", "80"], { encoding: "utf8" }); console.error(output.stdout); } catch {} }
  if (pane) { try { const output = await exec("herdr", ["--session", server, "pane", "read", pane, "--source", "recent-unwrapped", "--lines", "80"], { encoding: "utf8" }); console.error(output.stdout); } catch {} }
  throw error;
} finally {
  if (workspace) await cli(["workspace", "close", workspace]).catch(error => console.error(error));
  await exec("herdr", ["session", "stop", server], { encoding: "utf8" }).catch(error => console.error(error));
  await new Promise<void>(done => { if (daemon.exitCode !== null) done(); else daemon.once("exit", () => done()); });
  rmSync(base, { recursive: true, force: true });
}
