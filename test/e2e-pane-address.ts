// Real unnamed pi host spawning real peers, using a temporary no-auto-name extension.
// Scripted model makes tool calls deterministic; herdr/terminals/delivery are real.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readSession, waitingForReply, type Run } from "../src/run.ts";

const server = `swarm-pane-e2e-${process.pid}`;
const exec = promisify(execFile);
async function cli(args: string[], timeout = 15_000): Promise<any> {
  const { stdout } = await exec("herdr", ["--session", server, ...args], { encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024 });
  if (args[0] === "pane" && args[1] === "run") return;
  const reply = JSON.parse(stdout);
  if (reply.error) throw new Error(JSON.stringify(reply.error));
  return reply.result;
}
async function wait<T>(get: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    try { const value = await get(); if (value) return value as NonNullable<T>; } catch {}
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const base = mkdtempSync(join(tmpdir(), "swarm-pane-e2e-"));
// Keep copied sources under the repo so existing node_modules resolve normally.
const variant = mkdtempSync(join(resolve("."), ".swarm-pane-test-"));
cpSync(resolve("src"), join(variant, "src"), { recursive: true });
const transport = join(variant, "src/herdr.ts");
writeFileSync(transport, readFileSync(transport, "utf8")
  .replace("if (own.name) return validateName(own.name);", "if (own.name) return validateName(own.name);\n  if (!preset) return pane;")
  .replace("const from = validateName(input.from);", "const from = validateTarget(input.from);"));
const entry = join(variant, "src/index.ts");
writeFileSync(entry, readFileSync(entry, "utf8").replace("const self = agents.find(a => a.pane_id === pane)?.name;", "const self = agents.find(a => a.pane_id === pane)?.name ?? pane;"));
const agentDir = join(base, "agent");
mkdirSync(join(agentDir, "extensions"), { recursive: true });
copyFileSync(join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "extensions/herdr-agent-state.ts"), join(agentDir, "extensions/herdr-agent-state.ts"));
writeFileSync(join(agentDir, "extensions/demo.ts"), `export {default} from ${JSON.stringify(resolve("test/e2e-peer.ts"))};`);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }));
let hostFile = join(base, "host.jsonl");
const live = async () => (await cli(["agent", "list"])).agents as any[];
const marker = (steps: any[]) => `SWARM_TEST:${JSON.stringify({ steps })}`;
const entries = () => readSession(hostFile).getBranch();
const record = (name: string): Run => (entries().filter(e => e.type === "custom" && e.customType === "swarm_spawn" && (e.data as Run).name === name).at(-1) as any).data;
const received = (file: string, text: string) => readSession(file).getBranch().some(e => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes(text));
let workspace: string | undefined;
let hostPane: string;
async function invoke(tool: string, args: any = {}): Promise<any> {
  const before = entries().length;
  await cli(["agent", "prompt", hostPane, marker([{ tool, args }])]);
  const result = await wait(() => entries().slice(before).find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === tool), `${tool} result`);
  await wait(async () => (await live()).find(a => a.pane_id === hostPane && ["idle", "done"].includes(a.agent_status)), "host ready");
  return (result as any).message;
}
const daemon = spawn("herdr", ["--session", server, "server"], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SWARM_E2E: "1" }, stdio: "ignore" });
try {
  await wait(() => cli(["agent", "list"]), "server startup");
  const created = await cli(["workspace", "create", "--no-focus", "--label", "pane-address-test", "--cwd", base, "--env", `PI_CODING_AGENT_DIR=${agentDir}`, "--env", "PI_SWARM_E2E=1"]);
  workspace = created.workspace.workspace_id;
  hostPane = created.root_pane.pane_id;
  await cli(["pane", "run", hostPane, `pi --session ${hostFile} -e ${entry} --model swarm-e2e/scripted --thinking off`]);
  const host = await wait(async () => (await live()).find(a => a.pane_id === hostPane && a.agent === "pi" && a.agent_status === "idle"), "unnamed host ready");
  assert.equal(host.name, undefined);
  await cli(["agent", "prompt", hostPane, marker([])]);
  await wait(() => received(hostFile, "SWARM_TEST"), "host session created");
  const roster = await invoke("swarm_list");
  assert.equal(roster.details.self, hostPane);
  assert.equal(roster.details.agents.find((a: any) => a.pane_id === hostPane).name, undefined);
  console.log(`PASS: real pi ${hostPane} loads no-auto-name swarm extension and remains unnamed`);

  for (const address of ["name", "pane"] as const) {
    const peer = `peer-${address}`;
    const question = `QUESTION_${address}`;
    const answer = `ANSWER_${address}`;
    const task = marker([{ tool: "swarm_send", args: { to: hostPane, message: question, wait: true } }]);
    const started = await invoke("swarm_spawn", { name: peer, task });
    assert.equal(started.isError, false);
    const run = record(peer);
    await wait(() => received(hostFile, question), "child question delivered to unnamed host");
    await wait(() => waitingForReply(readSession(run.session)).includes(hostPane), "child waiting for pane-addressed host");
    console.log(`PASS: unnamed host swarm_spawn creates ${peer}; child swarm_send reaches host ${hostPane}`);

    const sent = await invoke("swarm_send", { to: address === "name" ? peer : run.pane, message: answer });
    assert.equal(sent.isError, false);
    assert.equal(sent.details.deliveries[0].status, "submitted");
    await wait(() => received(run.session, answer), "host answer delivered to child");
    assert.deepEqual(waitingForReply(readSession(run.session)), [], "pane-ID sender releases child wait");
    await wait(() => entries().some(e => e.type === "custom_message" && e.customType === "swarm_result" && (e.details as any).name === peer), "child final result returned to unnamed host");
    assert.equal((await live()).find(a => a.pane_id === hostPane)?.name, undefined);
    console.log(`PASS: unnamed host swarm_send by ${address}; child wait releases and final swarm_result returns`);
  }
  const self = await invoke("swarm_send", { to: hostPane, message: "must not send to self" });
  assert.equal(self.details.deliveries[0].code, "self");
  console.log(`PASS: self-send blocked; experimental host stayed unnamed for all tools (${server})`);

  // Separate production host: no source rewriting, exercises pane→name reply alias.
  hostPane = (await cli(["tab", "create", "--workspace", workspace!, "--no-focus", "--cwd", base])).root_pane.pane_id;
  hostFile = join(base, "production-host.jsonl");
  await cli(["agent", "start", "production-host", "--kind", "pi", "--pane", hostPane, "--", "--session", hostFile, "-e", resolve("src/index.ts"), "--model", "swarm-e2e/scripted", "--thinking", "off"], 70_000);
  await cli(["agent", "prompt", hostPane, marker([])]);
  await wait(() => received(hostFile, "SWARM_TEST"), "production host session");
  const task = marker([
    { tool: "e2e_wait", args: { file: "production-release" } },
    { tool: "swarm_send", args: { to: "production-host", message: "PRODUCTION_ALIAS_REPLY" } },
  ]);
  assert.equal((await invoke("swarm_spawn", { name: "production-peer", task })).isError, false);
  const run = record("production-peer");
  const waiting = await invoke("swarm_send", { to: run.pane, message: "PRODUCTION_PANE_MESSAGE", wait: true });
  assert.equal(waiting.details.deliveries[0].replyFrom, "production-peer");
  assert.deepEqual(waitingForReply(readSession(hostFile)), [run.pane]);
  writeFileSync(join(base, "production-release"), "released");
  await wait(() => received(run.session, "PRODUCTION_PANE_MESSAGE"), "production pane delivery");
  await wait(() => received(hostFile, "PRODUCTION_ALIAS_REPLY"), "production named reply");
  const childSend = await wait(() => readSession(run.session).getBranch().find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "swarm_send"), "child send to named host");
  assert.equal((childSend as any).message.details.deliveries[0].status, "submitted");
  await wait(() => waitingForReply(readSession(hostFile)).length === 0, "production named reply releases pane wait");
  console.log("PASS: shipped extension sends by pane ID with wait:true; named peer reply releases wait");
} catch (error) {
  try {
    console.error(JSON.stringify(await live()));
    const { stdout } = await exec("herdr", ["--session", server, "pane", "read", hostPane!, "--source", "recent-unwrapped", "--lines", "60"], { encoding: "utf8" });
    console.error(stdout);
  } catch {}
  throw error;
} finally {
  if (workspace) await cli(["workspace", "close", workspace]).catch(() => {});
  await exec("herdr", ["session", "stop", server], { encoding: "utf8" }).catch(() => {});
  if (daemon.exitCode === null && daemon.signalCode === null) await new Promise<void>(done => daemon.once("exit", () => done()));
  rmSync(base, { recursive: true, force: true });
  rmSync(variant, { recursive: true, force: true });
}
