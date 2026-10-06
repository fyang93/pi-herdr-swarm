import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, validateToolArguments } from "@earendil-works/pi-ai";
import { setTimeout as sleep } from "node:timers/promises";
import { checkMessage, validateName, deliver, start, splitDirection, identity, projectRoot, inProject, summary } from "../src/herdr.ts";
import { extensionPath, presets, loadout, requiredTools, snapshot, spawnPolicy, checkSpawn } from "../src/presets.ts";
import swarm, { PENDING_COUNT_KEY } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "swarm-test-"));
const settings: { swarm?: { maxAgents?: unknown } } = {};
const fake = resolve("test/fake-herdr.cjs");
chmodSync(fake, 0o755);
Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", HERDR_BIN_PATH: fake, FAKE_HERDR_DIR: dir });
const exec = promisify(execFile);
await exec("git", ["init", "-q", dir]);
const stateFile = join(dir, "state.json");
const save = (state: any) => writeFileSync(stateFile, JSON.stringify(state));
const readState = () => JSON.parse(readFileSync(stateFile, "utf8"));
function reset(extra: any = {}) {
  save({ agents: ["spawner", "peer", "blocked"].map((name, n) => ({ name, pane_id: `w1:p${n + 1}`, agent: "pi", agent_status: "working", cwd: dir })),
    layout: { zoomed: false, panes: [{ pane_id: "w1:p1", rect: { width: 101, height: 20 } }, { pane_id: "w1:p2", rect: { width: 500, height: 100 } }] }, ...extra });
  writeFileSync(join(dir, "calls.jsonl"), "");
}
const calls = () => readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s) as string[]);
after(() => rmSync(dir, { recursive: true, force: true }));

async function harness(flags: Record<string, unknown> = {}, mode = "print") {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const notices: any[] = [];
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "test", timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage("initialized"));
  let shutdowns = 0;
  const context: any = {
    cwd: dir, mode, model: getModel("openai", "gpt-4.1"), modelRegistry: { getAll: () => [getModel("openai", "gpt-4.1"), getModel("anthropic", "claude-sonnet-4-5")], find: (provider: string, id: string) => getModel(provider as any, id as any) }, isIdle: () => true, hasPendingMessages: () => false, isProjectTrusted: () => true,
    sessionManager: manager,
    ui: { setWidget() {}, setStatus() {}, getEditorText: () => "", onTerminalInput: () => () => {}, notify: (message: string) => notices.push(message) }, shutdown: () => { shutdowns++; },
  };
  const activeTools = ["read", "swarm_spawn", "swarm_send", "swarm_list"];
  const registered = [...activeTools, "codemode"]; // pi activates only registered, non-hidden tools
  swarm({
    on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) || []), fn]),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer() {}, registerFlag() {}, getFlag: (name: string) => flags[name], setModel: async () => true, setThinkingLevel() {},
    getActiveTools: () => activeTools, setActiveTools: (names: string[]) => { activeTools.splice(0, activeTools.length, ...names.filter(name => registered.includes(name))); }, getAllTools: () => registered.map(name => ({ name })), getThinkingLevel: () => "high", getSettings: () => settings,
    appendEntry: (customType: string, data: any) => manager.appendCustomEntry(customType, data),
    sendMessage: async (message: any) => notices.push(message),
  } as any);
  const event = async (name: string, data: any = {}) => { for (const handler of handlers.get(name) || []) await handler(data, context); };
  const tool = (name: string, params = {}) => tools.get(name).execute("test", params, undefined, undefined, context);
  await event("session_start");
  return { context, notices, activeTools, get entries() { return manager.getEntries() as any[]; }, event, tool, tools, shutdowns: () => shutdowns };
}

test("no preset, no tool activation; a preset's required tools are activated once and missing ones reported", async () => {
  reset();
  const plain = await harness();
  try { assert.equal(plain.activeTools.includes("codemode"), false); }
  finally { await plain.event("session_shutdown", { reason: "reload" }); }
  const peer = await harness({ "swarm-tools": "codemode,absent" });
  try {
    assert.equal(peer.activeTools.filter(name => name === "codemode").length, 1);
    await peer.event("session_start");
    assert.equal(peer.activeTools.filter(name => name === "codemode").length, 1);
    assert.ok(peer.notices.some(n => String(n).includes("required tools unavailable: absent")));
  } finally { await peer.event("session_shutdown", { reason: "reload" }); }
  assert.deepEqual(requiredTools(["codemode", "other"]), ["codemode", "other"]);
  assert.deepEqual(requiredTools(undefined), []);
  assert.deepEqual(requiredTools("codemode"), ["codemode"]);
  assert.deepEqual(requiredTools("a, b"), ["a", "b"]);
});

test("message and name validation preserves limits and rejects invalid input", () => {
  assert.equal(checkMessage("x".repeat(4000)).length, 4000);
  for (const message of ["", " ", null, 42]) assert.throws(() => checkMessage(message as any), /nonempty/);
  assert.throws(() => checkMessage("x".repeat(4001)), /4000/);
  assert.equal(validateName("us-news-1"), "us-news-1");
  for (const name of ["a\nadmin", "peer\n", "peer\r\n", "2bad", "a".repeat(33)]) assert.throws(() => validateName(name), /names/);
});

test("deliver pushes without storing, returns three states/codes, and never retries", async () => {
  reset();
  const sent = await deliver({ from: "spawner", to: "peer", message: "a\nb" });
  assert.equal(sent.deliveries[0].status, "submitted");
  assert.deepEqual(calls().at(-1)?.slice(0, 3), ["agent", "prompt", "peer"]);
  assert.equal(calls().at(-1)![3], "[swarm message] spawner → peer\na\nb");
  assert.equal(calls().at(-1)!.length, 4, "native steer only, no urgent or receiver rerouting");
  assert.equal(existsSync(join(dir, ".pi/swarm")), false, "delivery creates no shared storage");
  for (const [code, status] of [["agent_blocked", "rejected"], ["timeout", "unknown"], ["server_error", "unknown"]]) {
    reset({ promptError: code });
    const failed = await deliver({ from: "spawner", to: "peer", message: code });
    assert.equal(failed.deliveries[0].status, status);
    assert.equal(failed.deliveries[0].code, code);
    assert.equal(calls().filter(c => c[1] === "prompt").length, 1);
  }
  for (const extra of [{ malformed: "agent prompt" }, { emptyReply: "agent prompt" }]) {
    reset(extra);
    const ambiguous = await deliver({ from: "spawner", to: "peer", message: "malformed is not success or not-found" });
    assert.equal(ambiguous.deliveries[0].status, "unknown");
    assert.ok(calls().filter(c => c[1] === "prompt").length <= 1);
  }
  reset();
  const absent = await deliver({ from: "spawner", to: "missing", message: "nobody there" });
  assert.equal(absent.deliveries[0].status, "rejected");
  assert.equal(absent.deliveries[0].code, "agent_not_found");
  assert.equal(calls().some(c => c[1] === "get" || c[1] === "start"), false);
  reset({ listError: true });
  const direct = await deliver({ from: "spawner", to: "peer", message: "outage" });
  assert.equal(direct.deliveries[0].status, "submitted");
  assert.equal(calls().some(c => c[1] === "list"), false);
  await assert.rejects(deliver({ from: "spawner", to: "peer", message: "x".repeat(4001) }), /4000/);
});

test("exact recipient arrays report each outcome; names cross projects", async () => {
  reset();
  const sent = await deliver({ from: "spawner", to: ["peer", "blocked", "missing", "spawner", "peer"], message: "announcement" });
  assert.deepEqual(sent.deliveries.map(d => [d.to, d.status]), [["peer", "submitted"], ["blocked", "rejected"], ["missing", "rejected"], ["spawner", "rejected"]]);
  assert.equal(calls().some(c => c[1] === "list" || c[1] === "get"), false);
  assert.equal(calls().filter(c => c[1] === "prompt" && c[2] === "peer").length, 1);
  reset({ agents: [{ name: "other", pane_id: "w1:p4", cwd: "/other-project" }] });
  assert.equal((await deliver({ from: "spawner", to: "other", message: "cross-project" })).deliveries[0].status, "submitted");
  const prompts = calls().filter(c => c[1] === "prompt").length;
  const self = await deliver({ from: "spawner", to: "spawner", message: "note to self" });
  assert.deepEqual([self.deliveries[0].status, self.deliveries[0].code], ["rejected", "self"]);
  assert.equal(calls().filter(c => c[1] === "prompt").length, prompts, "never typed into the sender's own session");
});

test("canonical Git roots separate nested repositories, worktrees, submodules and non-Git directories", async () => {
  const repo = join(dir, "repo"); const sub = join(repo, "sub"); mkdirSync(sub, { recursive: true });
  await exec("git", ["init", "-q", repo]);
  assert.equal(await projectRoot(sub), repo);
  const linked = join(dir, "linked"); symlinkSync(sub, linked);
  assert.equal(await projectRoot(linked), repo);
  const nested = join(repo, "nested"); mkdirSync(nested); await exec("git", ["init", "-q", nested]);
  assert.equal(await inProject({ name: "nested", pane_id: "p", agent: "pi", cwd: nested }, repo, new Map()), false);
  await exec("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"]);
  const worktree = join(dir, "worktree"); await exec("git", ["-C", repo, "worktree", "add", "-q", worktree, "-b", "other"]);
  assert.equal(await projectRoot(worktree), worktree);
  assert.equal(await inProject({ name: "worktree", pane_id: "p", agent: "pi", cwd: worktree }, repo, new Map()), false);
  const module = join(repo, "module");
  await exec("git", ["-C", repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", worktree, "module"]);
  assert.equal(await projectRoot(module), module);
  const nonGit = mkdtempSync(join(tmpdir(), "swarm-nongit-"));
  try { assert.equal(await projectRoot(nonGit), nonGit); } finally { rmSync(nonGit, { recursive: true }); }
  const original = process.env.PATH;
  try { process.env.PATH = "/no-git-here"; await assert.rejects(projectRoot(repo), /Cannot resolve project root/); } finally { process.env.PATH = original; }
  const roots = new Map<string, string>();
  assert.equal(await inProject({ name: "peer", pane_id: "p", agent: "pi", cwd: linked }, repo, roots), true);
  assert.equal(roots.size, 1); assert.ok(roots.has(sub));
});

test("wildcards and malformed recipient arrays fail before any delivery", async () => {
  reset();
  for (const to of ["*", "*news*", "news?", "[news]*", "news.*", [], ["peer", "*"], ["peer", null], ["peer", 2], "peer\n", null]) {
    await assert.rejects(deliver({ from: "spawner", to: to as any, message: "no side effects" }), /names|recipient/);
  }
  assert.deepEqual(calls(), []);
});

test("identity preserves existing names, otherwise uses pane id; no name search or ambiguous retry", async () => {
  reset(); assert.equal(await identity(), "spawner"); assert.equal(calls().some(c => c[1] === "rename"), false);
  reset({ agents: [{ pane_id: "w1:p1", agent: "pi" }] });
  const named: string[] = []; assert.equal(await identity(name => named.push(name)), "swarm-w1-p1"); assert.deepEqual(named, ["swarm-w1-p1"]);
  assert.equal(calls().filter(c => c[1] === "get").length, 1); assert.equal(calls().some(c => c[1] === "list"), false);
  for (const code of ["agent_name_taken", "timeout", "server_error"]) {
    reset({ agents: [{ pane_id: "w1:p1", agent: "pi" }], renameErrors: [code] }); await assert.rejects(identity(), new RegExp(code));
    assert.equal(calls().filter(c => c[1] === "rename").length, 1); assert.equal(calls().filter(c => c[1] === "get").length, 1);
  }
});

test("split respects caller geometry/divider; uncertain launch is not repeated or closed", async () => {
  assert.equal(splitDirection(100, 20), undefined); assert.equal(splitDirection(101, 15), "right");
  assert.equal(splitDirection(50, 31), "down"); assert.equal(splitDirection(50, 30), undefined);
  const launch = { name: "new-peer", cwd: dir, args: ["--thinking", "low"], task: "task\nsecond line" };
  reset(); assert.equal((await start(launch)).pane, "w1:p9");
  assert.deepEqual(calls().find(c => c[1] === "split")?.slice(0, 6), ["pane", "split", "w1:p1", "--direction", "right", "--no-focus"]);
  reset({ layout: { zoomed: true, panes: [] } }); assert.equal((await start(launch)).pane, "w1:p8");
  assert.deepEqual(calls().find(c => c[1] === "create")?.slice(0, 6), ["tab", "create", "--workspace", "w1", "--no-focus", "--label"]);
  const full = { zoomed: false, panes: [{ pane_id: "w1:p1", rect: { width: 92, height: 24 } }] };
  reset({ agents: [{ name: "old-peer", pane_id: "w1:p5", agent: "pi", cwd: dir, agent_session: { kind: "path", value: "/s/old-peer.jsonl" } }, { name: "reused", pane_id: "w1:p6", agent: "pi", cwd: dir, agent_session: { kind: "path", value: "/s/other.jsonl" } }], layouts: { "w1:p1": full, "w1:p5": { zoomed: false, panes: [{ pane_id: "w1:p5", rect: { width: 184, height: 49 } }] } } });
  await start({ ...launch, near: ["/s/old-peer.jsonl"] }); // own pane full: the peer's roomy tab is split instead of opening another
  assert.deepEqual(calls().find(c => c[1] === "split")?.slice(0, 5), ["pane", "split", "w1:p5", "--direction", "right"]);
  reset({ layouts: { "w1:p1": full } }); await start({ ...launch, near: ["/s/gone-peer.jsonl"] });
  assert.ok(calls().some(c => c[1] === "create") && !calls().some(c => c[1] === "split"));
  reset({ startError: "agent_start_failed" }); await assert.rejects(start(launch), /Startup diagnostics/);
  assert.equal(calls().filter(c => c[1] === "start").length, 1); assert.equal(calls().at(-1)?.[1], "close");
  reset({ promptError: "timeout" }); await assert.rejects(start(launch), /do not blindly retry/);
  assert.equal(calls().some(c => c[1] === "close"), false); assert.equal(calls().filter(c => c[1] === "prompt").length, 1);
});

test("monitor is an example, not bundled; once installed it spawns with its role, verbatim task and required tools", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const global = join(dir, "monitor-global");
  mkdirSync(join(global, "agents"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = global;
  reset();
  const h = await harness();
  try {
    assert.equal(presets(dir, false).some(p => p.name === "monitor"), false, "examples are not loaded");
    copyFileSync("examples/agents/monitor.md", join(global, "agents/monitor.md"));
    const monitor = presets(dir, false).find(p => p.name === "monitor")!;
    assert.equal(monitor.fields.model, undefined, "inherits the host model");
    const listed = await h.tool("swarm_list");
    assert.ok(listed.details.presets.some((p: any) => p.name === "monitor"));
    const task = "Keep an eye on health.json and tell me if the service status changes.";
    await h.tool("swarm_spawn", { agent: "monitor", task });
    const record = h.entries.find(e => e.customType === "swarm_spawn").data;
    assert.equal(record.snapshot.prompt, monitor.body);
    const args = calls().find(c => c[1] === "start")!;
    assert.equal(readFileSync(args[args.indexOf("--append-system-prompt") + 1], "utf8"), monitor.body);
    assert.deepEqual(record.snapshot.tools, ["codemode"]);
    assert.equal(args[args.indexOf("--swarm-tools") + 1], "codemode");
    assert.equal(args[args.indexOf("--swarm-title") + 1], "monitor · Keep an eye on health.json and tell me if the service status changes.");
    assert.equal(calls().find(c => c[1] === "prompt")!.at(-1), task);
  } finally {
    await h.event("session_shutdown", { reason: "reload" });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("optional presets snapshot only configuration, respect trust and override order", async () => {
  const global = join(dir, "global"); const project = join(dir, ".pi/agents");
  mkdirSync(join(global, "agents"), { recursive: true }); mkdirSync(project, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = global;
  writeFileSync(join(global, "agents/reviewer.md"), "---\nname: reviewer\ndescription: global\n---\nGlobal body");
  writeFileSync(join(project, "reviewer.md"), "---\nname: reviewer\ndescription: project\nmodel: anthropic/claude-sonnet-4-5\nthinking: low\n---\nProject body");
  assert.equal(presets(dir, false).find(p => p.name === "reviewer")?.description, "global");
  const preset = presets(dir, true).find(p => p.name === "reviewer")!;
  const context: any = { cwd: dir, model: getModel("openai", "gpt-4.1"), modelRegistry: { getAll: () => [getModel("openai", "gpt-4.1"), getModel("anthropic", "claude-sonnet-4-5")] } };
  const inherited = await snapshot(undefined, context, "high", {});
  assert.equal(inherited.model, "openai/gpt-4.1"); assert.equal(inherited.thinking, "off");
  assert.equal(loadout(inherited, join(dir, "session.jsonl")).includes("--append-system-prompt"), false, "no preset body, no prompt file");
  const selected = await snapshot(preset, context, "high", { model: "openai/gpt-4.1" });
  assert.equal(selected.model, "openai/gpt-4.1"); assert.equal(selected.thinking, "off");
  const args = loadout(selected, join(dir, "session.jsonl"));
  assert.equal(args.includes("--tools"), false); assert.equal(args.includes("--no-tools"), false);
  // Always this copy; pi loads an identical installed path once (verified against pi's resource loader).
  assert.deepEqual(args.slice(args.indexOf("-e"), args.indexOf("-e") + 2), ["-e", extensionPath]);
  assert.equal(readFileSync(join(dir, "system.md"), "utf8"), "Project body");
  assert.deepEqual(args.slice(-2), ["--append-system-prompt", join(dir, "system.md")]);
  for (const fields of [{ "session-mode": "fork" }, { cli: "claude" }]) await assert.rejects(snapshot({ ...preset, fields }, context, "high", {}));
  delete process.env.PI_CODING_AGENT_DIR;
});

test("boolean spawn policy defaults true and survives snapshot/loadout", async () => {
  assert.equal(spawnPolicy(undefined), true);
  assert.equal(spawnPolicy(true), true);
  assert.equal(spawnPolicy(false), false);
  checkSpawn(undefined); checkSpawn(true);
  assert.throws(() => checkSpawn(false), /denied/i);
  const context: any = { cwd: dir, model: getModel("openai", "gpt-4.1"), modelRegistry: { getAll: () => [getModel("openai", "gpt-4.1")] } };
  const preset = { name: "executor", description: "", body: "Role", fields: { "can-spawn": false } };
  const saved = JSON.parse(JSON.stringify(await snapshot(preset, context, "off", {})));
  assert.equal(saved.preset, "executor"); assert.equal(saved.canSpawn, false);
  const args = loadout(saved, join(dir, "session.jsonl"));
  assert.equal(args[args.indexOf("--swarm-can-spawn") + 1], "false");
  assert.equal(args.includes("--swarm-agent"), false);
  const unrestricted = await snapshot(undefined, context, "off", {});
  assert.equal(unrestricted.canSpawn, true);
  assert.equal(loadout(unrestricted, join(dir, "session.jsonl")).includes("--swarm-can-spawn"), false);
  for (const value of [null, "true", "false", "executor", "", {}, [], ["executor"], 0, 1]) {
    assert.throws(() => spawnPolicy(value), /can-spawn/);
    assert.throws(() => checkSpawn(value), /can-spawn/);
    assert.throws(() => loadout({ ...saved, canSpawn: value as any }, join(dir, "session.jsonl")), /can-spawn/);
    await assert.rejects(snapshot({ ...preset, fields: { "can-spawn": value } }, context, "off", {}), /can-spawn/);
  }
});

test("child policy gates fresh spawns and malformed startup flags fail closed", async () => {
  const agents = join(dir, ".pi/agents"); mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "policy-executor.md"), "---\nname: policy-executor\ncan-spawn: false\n---\nExecutor role");
  writeFileSync(join(agents, "policy-leader.md"), "---\nname: policy-leader\ncan-spawn: true\n---\nLeader role");
  writeFileSync(join(agents, "policy-bad.md"), "---\nname: policy-bad\ncan-spawn: [policy-executor]\n---\nBad role");
  try {
    for (const flags of [{ "swarm-can-spawn": "false" }, { "swarm-can-spawn": "[]" }, { "swarm-can-spawn": "null" }, { "swarm-can-spawn": "garbage" }, { "swarm-can-spawn": "{}" }, { "swarm-can-spawn": '[1]' }, { "swarm-agent": "policy-executor" }, { "swarm-agent": "policy-bad" }, { "swarm-agent": "missing-role" }]) {
      reset(); const h = await harness(flags);
      try {
        await assert.rejects(h.tool("swarm_spawn", { task: "forbidden" }), /denied|can-spawn/i);
        await assert.rejects(h.tool("swarm_spawn", { agent: "policy-executor", name: "named", task: "forbidden" }), /denied|can-spawn/i);
        await assert.rejects(h.tool("swarm_spawn", { resume: "anything", task: "forbidden" }), /denied|can-spawn/i);
        assert.equal(calls().some(c => c[1] === "start" || c[1] === "split" || c[1] === "create"), false);
      } finally { await h.event("session_shutdown", { reason: "reload" }); }
    }
    reset(); const unrestricted = await harness({ "swarm-can-spawn": "true" });
    try { await unrestricted.tool("swarm_spawn", { task: "no preset required" }); }
    finally { await unrestricted.event("session_shutdown", { reason: "reload" }); }
    reset(); const flags = { "swarm-agent": "policy-leader" }; const h = await harness(flags);
    try {
      await h.tool("swarm_spawn", { name: "unpreset", task: "any peer" });
      await h.tool("swarm_spawn", { agent: "policy-leader", task: "same role peer" });
      await h.tool("swarm_spawn", { agent: "policy-executor", name: "allowed", task: "work" });
      const run = h.entries.find(e => e.customType === "swarm_spawn" && e.data.name === "allowed");
      assert.equal(run.data.snapshot.preset, "policy-executor");
      assert.equal(run.data.snapshot.canSpawn, false);
      const args = calls().filter(c => c[1] === "start").at(-1)!;
      assert.equal(args[args.indexOf("--swarm-can-spawn") + 1], "false");
      h.context.sessionManager.resetLeaf(); h.context.sessionManager.appendMessage(fauxAssistantMessage("new branch"));
      reset({ agents: [{ name: "spawner", agent: "pi", pane_id: "w1:p1", cwd: dir, agent_session: { kind: "path", value: "/parent-session.jsonl" } }] });
      h.context.sessionManager.appendCustomMessageEntry("swarm_result", "done", true, { spawnEntryId: run.id });
      const child = SessionManager.open(run.data.session);
      child.appendMessage({ role: "user", content: "work", timestamp: Date.now() }); child.appendMessage(fauxAssistantMessage("done"));
      // False blocks resume as well; true restores it regardless of the child's preset.
      flags["swarm-agent"] = "policy-executor"; await h.event("session_start");
      await assert.rejects(h.tool("swarm_spawn", { resume: "allowed", task: "forbidden resume" }), /denied|can-spawn/i);
      assert.equal(calls().some(c => c[1] === "start"), false);
      flags["swarm-agent"] = "policy-leader"; await h.event("session_start");
      await h.tool("swarm_spawn", { resume: "allowed", task: "more" });
      assert.equal(calls().find(c => c[1] === "start")!.includes("--swarm-can-spawn"), true);
    } finally { await h.event("session_shutdown", { reason: "reload" }); }
  } finally { for (const file of ["policy-executor.md", "policy-leader.md", "policy-bad.md"]) rmSync(join(agents, file)); }
});

test("TUI startup lets later native integration register pi, names before tools, and cancels on shutdown", async () => {
  reset({ agents: [] }); const h = await harness({}, "tui");
  try {
    await sleep(150); // integration may run after our session_start handler
    save({ ...readState(), agents: [{ agent: "pi", pane_id: "w1:p1", cwd: dir }] });
    for (let n = 0; n < 100 && !readState().agents[0].name; n++) await sleep(20);
    assert.equal(readState().agents[0].name, "swarm-w1-p1", "no tool call was needed");
    assert.equal(calls().filter(c => c[1] === "rename").length, 1);
    assert.equal(calls().some(c => c[1] === "report-metadata"), false);
    await h.event("session_shutdown", { reason: "new" });
    reset({ agents: [] });
    await h.event("session_start", { reason: "new" });
    await sleep(100);
    await h.event("session_shutdown", { reason: "quit" });
    save({ ...readState(), agents: [{ agent: "pi", pane_id: "w1:p1", cwd: dir }] });
    await sleep(150);
    assert.equal(calls().some(c => c[1] === "rename" || c[1] === "report-metadata"), false, "a cancelled startup cannot name a subsequent occupant");
  } finally { await h.event("session_shutdown", { reason: "quit" }); }
});

test("native titles: preset startup names once, lists role/description, and clears on replacement/reload/quit", async () => {
  const agents = join(dir, ".pi/agents"); mkdirSync(agents, { recursive: true });
  const file = join(agents, "metadata-reviewer.md");
  writeFileSync(file, "---\nname: metadata-reviewer\ndescription: Review code. Check safety.\n---\nReview carefully.");
  const unnamed = [{ pane_id: "w1:p1", agent: "pi", cwd: dir }, { name: "metadata-reviewer-1", pane_id: "w1:p2", agent: "pi", cwd: dir }];
  reset({ agents: unnamed });
  const h = await harness({ "swarm-agent": "metadata-reviewer" });
  try {
    assert.equal(readState().agents[0].name, "metadata-reviewer-2");
    assert.equal(readState().agents[0].title, "metadata-reviewer · Review code. Check safety.");
    const listed = await h.tool("swarm_list");
    assert.match(listed.content[0].text, /metadata-reviewer-2 · metadata-reviewer · Review code\. Check safety\. · unknown · w1:p1/);
    assert.equal(listed.details.agents[0].title, "metadata-reviewer · Review code. Check safety.");
    for (const reason of ["new", "resume", "fork", "reload", "quit"]) {
      await h.event("session_shutdown", { reason });
      assert.equal(readState().agents[0].title, undefined);
      await h.event("session_start", { reason });
    }
    assert.equal(calls().filter(c => c[1] === "rename").length, 1, "existing names are never changed");
    assert.ok(calls().filter(c => c[1] === "report-metadata").every(c => c.includes("pi-herdr-swarm")));
    assert.equal(existsSync(join(dir, ".pi/swarm")), false);
  } finally { await h.event("session_shutdown", { reason: "quit" }); rmSync(file); }
});

test("spawned title belongs only to its launch session; resumes carry the new task, no preset uses peer", async () => {
  reset(); const flags: Record<string, unknown> = {};
  const h = await harness(flags);
  try {
    await h.tool("swarm_spawn", { name: "title-peer", task: "First task. More detail.\nMore text" });
    const args = calls().find(c => c[1] === "start")!;
    assert.equal(args[args.indexOf("--swarm-title") + 1], "peer · First task.");
    Object.assign(flags, { "swarm-name": "spawner", "swarm-spawner": "parent", "swarm-session": h.context.sessionManager.getSessionFile(), "swarm-title": "peer · First task." });
    await h.event("session_start");
    assert.equal(readState().agents[0].title, "peer · First task.");
    await h.event("session_shutdown", { reason: "reload" });
    assert.equal(readState().agents[0].title, undefined);
    await h.event("session_start", { reason: "reload" });
    assert.equal(readState().agents[0].title, "peer · First task.");
    h.context.sessionManager.newSession();
    await h.event("session_start", { reason: "new" });
    assert.equal(readState().agents[0].title, undefined, "launch flags cannot label an unrelated replacement session");
    assert.equal(calls().filter(c => c[1] === "rename").length, 0);
  } finally { await h.event("session_shutdown", { reason: "quit" }); }
  assert.equal(summary("\n 检查安全。然后修复。"), "检查安全。");
  assert.equal(summary("Read code! Then test."), "Read code!");
  assert.equal(summary("Read code\nThen test"), "Read code");
  assert.equal(summary("x".repeat(1000)).length, 120);
});

test("title report failure is visible but does not disable tools; startup outside herdr writes nothing", async () => {
  const agents = join(dir, ".pi/agents"); mkdirSync(agents, { recursive: true });
  const file = join(agents, "title-error.md"); writeFileSync(file, "---\nname: title-error\n---\nRole");
  reset({ metadataError: "server_error" }); const h = await harness({ "swarm-agent": "title-error" });
  try {
    assert.ok(h.notices.some(n => String(n).includes("metadata failed")));
    assert.equal((await h.tool("swarm_send", { to: "peer", message: "still works" })).isError, false);
    save({ ...readState(), metadataError: undefined });
  } finally { await h.event("session_shutdown", { reason: "quit" }); rmSync(file); }
  reset(); const env = process.env.HERDR_ENV; delete process.env.HERDR_ENV;
  try {
    const plain = await harness();
    try { assert.deepEqual(calls(), []); } finally { await plain.event("session_shutdown", { reason: "quit" }); }
  } finally { process.env.HERDR_ENV = env; }
});

test("startup names the caller before any tool; list and send keep that name",  async () => {
  reset({ agents: [{ pane_id: "w1:p1", agent: "pi", cwd: dir }, { name: "peer", pane_id: "w1:p2", agent: "pi", cwd: dir }] });
  const h = await harness({ "swarm-spawner": "parent" });
  try {
    assert.deepEqual([...h.tools.keys()], ["swarm_spawn", "swarm_send", "swarm_list"]);
    const listed = await h.tool("swarm_list");
    assert.equal(listed.details.presets.length > 0, listed.content[0].text.includes("Presets:"));
    assert.equal(listed.details.self, "swarm-w1-p1", "startup already assigned a name");
    assert.equal(calls().filter(c => c[1] === "rename").length, 1);
    assert.equal(calls().some(c => c[1] === "report-metadata"), false, "manual pi writes no title");
    for (const to of ["peer", ["peer"]]) {
      const sent = await h.tool("swarm_send", { to, message: "announcement" });
      assert.equal(sent.isError, false);
      assert.deepEqual(sent.details.deliveries, [{ to: "peer", status: "submitted" }]);
      assert.match(calls().filter(c => c[1] === "prompt").at(-1)![3], /\[swarm message\] swarm-w1-p1/);
    }
    assert.equal(calls().filter(c => c[1] === "rename").length, 1);
    assert.ok(h.notices.some(n => typeof n === "string" && n.includes("This session is now named swarm-w1-p1")));
    // Self is the live name of the caller's current pane, not a launch flag.
    const named = await h.tool("swarm_list");
    assert.match(named.content[0].text, /^Self: swarm-w1-p1\n/);
    assert.equal(named.details.self, "swarm-w1-p1");
  } finally { await h.event("session_shutdown", { reason: "reload" }); }
});

test("send hints resume only for agent_not_found recipients in this sender's spawn history", async () => {
  reset(); const h = await harness();
  const hint = 'Peer finished has ended; use swarm_spawn({resume: "finished", task}) to continue its session.';
  try {
    const description = h.tools.get("swarm_send").description;
    assert.match(description, /agent_not_found.*spawn history/);
    assert.ok(description.includes('swarm_spawn({resume: "<name>", task})'));
    assert.match(description, /Never resumes or retries automatically; other rejection reasons are unchanged/);
    await h.tool("swarm_spawn", { name: "finished", task: "work" });
    assert.deepEqual((await h.tool("swarm_send", { to: "finished", message: "still live" })).details.deliveries, [{ to: "finished", status: "submitted" }]);
    // History, like resume, spans branches and survives session startup; no result archive is needed for a hint.
    h.context.sessionManager.resetLeaf(); h.context.sessionManager.appendMessage(fauxAssistantMessage("different branch"));
    await h.event("session_start", { reason: "reload" });
    reset();
    const sent = await h.tool("swarm_send", { to: ["finished", "peer", "blocked", "missing", "spawner", "finished"], message: "follow-up", wait: true });
    assert.equal(sent.isError, true);
    assert.equal(sent.details.wait, true);
    assert.equal(sent.terminate, true);
    assert.deepEqual(sent.details.deliveries, [
      { to: "finished", status: "rejected", code: "agent_not_found", error: `Error: herdr agent_not_found: not online ${hint}` },
      { to: "peer", status: "submitted" },
      { to: "blocked", status: "rejected", code: "agent_blocked", error: "Error: herdr agent_blocked: prompt failed" },
      { to: "missing", status: "rejected", code: "agent_not_found", error: "Error: herdr agent_not_found: not online" },
      { to: "spawner", status: "rejected", code: "self", error: "cannot message yourself" },
    ]);
    assert.ok(sent.content[0].text.includes(hint));
    assert.deepEqual(calls().filter(c => c[1] === "prompt").map(c => c[2]).sort(), ["blocked", "finished", "missing", "peer"]);
    assert.equal(calls().some(c => ["list", "start", "split", "create"].includes(c[1]) || (c[1] === "get" && c[2] !== "w1:p1")), false, "no recipient discovery, resume or retry");
    for (const code of ["not_found", "agent_blocked", "agent_not_ready", "invalid_params", "unsupported_agent", "timeout", "server_error"]) {
      reset({ promptError: code });
      const failed = await h.tool("swarm_send", { to: "finished", message: "no hint for other failures", wait: true });
      assert.deepEqual(failed.details.deliveries, [{ to: "finished", status: ["timeout", "server_error"].includes(code) ? "unknown" : "rejected", code, error: `Error: herdr ${code}: prompt failed` }]);
      assert.equal(failed.details.wait, false);
      assert.equal(failed.terminate, undefined);
      assert.equal(calls().filter(c => c[1] === "prompt").length, 1);
      assert.equal(calls().some(c => ["start", "split", "create"].includes(c[1])), false);
    }
    reset();
    const ended = await h.tool("swarm_send", { to: "finished", message: "ended", wait: true });
    assert.ok(ended.details.deliveries[0].error.includes(hint));
    assert.equal(ended.details.wait, false);
    assert.equal(ended.terminate, undefined);
  } finally { await h.event("session_shutdown", { reason: "reload" }); }
});

test("send schema requires a recipient and bounded message; sending requires herdr", async () => {
  reset(); const h = await harness();
  const validate = (args: any) => validateToolArguments(h.tools.get("swarm_send"), { type: "toolCall", id: "test", name: "swarm_send", arguments: args });
  try {
    assert.throws(() => validate({ message: "no recipient" }), /to/);
    assert.deepEqual(validate({ to: "peer", message: "question", wait: true }), { to: "peer", message: "question", wait: true });
    assert.throws(() => validate({ to: "peer", message: "question", wait: "yes" }), /Validation failed/);
    for (const args of [{ to: "", message: "x" }, { to: [], message: "x" }, { to: "*", message: "x" }, { to: ["peer", "*"], message: "x" }, { to: "peer", message: "" }, { to: "peer", message: "x".repeat(4001) }, { to: "peer", message: "x", from: "impostor" }]) assert.throws(() => validate(args), /Validation failed/);
    for (const message of ["", " ", "x".repeat(4001)]) await assert.rejects(h.tool("swarm_send", { to: "peer", message }), /nonempty|4000/);
    const maximum = await h.tool("swarm_send", validate({ to: "peer", message: "x".repeat(4000) }));
    assert.equal(maximum.isError, false);
    const env = process.env.HERDR_ENV;
    try {
      delete process.env.HERDR_ENV;
      for (const tool of ["swarm_send", "swarm_spawn", "swarm_list"]) await assert.rejects(h.tool(tool, { to: "peer", message: "x", task: "x" }), /inside a herdr pane/);
    } finally { process.env.HERDR_ENV = env; }
  } finally { await h.event("session_shutdown", { reason: "reload" }); }
});

test("spawn inherits model and sends tasks verbatim; every run is supervised and resume requires an archived result", async () => {
  reset(); const h = await harness();
  try {
    const description = h.tools.get("swarm_spawn").description;
    assert.match(h.tools.get("swarm_send").description, /Call this tool directly, not as a shell command/);
    assert.match(description, /stays running while its task runs, then exits/);
    assert.throws(() => validateToolArguments(h.tools.get("swarm_spawn"), { type: "toolCall", id: "test", name: "swarm_spawn", arguments: { task: "x", detach: true } }), /Validation failed/);
    assert.match(description, /agent selects a preset from swarm_list/);
    assert.doesNotMatch(description, /Omit agent only/);
    assert.match(description, /Use swarm_send to communicate/);
    assert.doesNotMatch(description, /meaningful changes|monitoring a state/);
    await assert.rejects(h.tool("swarm_spawn", { agent: "unknown", task: "x" }), /Unknown preset/);
    await h.tool("swarm_spawn", { name: "first", task: "ROLE_IN_TASK" });
    assert.equal((globalThis as any)[PENDING_COUNT_KEY](), 1);
    const args = calls().find(c => c[1] === "start")!;
    assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-4.1");
    assert.equal(args.includes("--tools"), false);
    assert.equal(args.includes("--approve"), false);
    const other = join(dir, "nested"); mkdirSync(other, { recursive: true });
    await h.tool("swarm_spawn", { name: "second", task: "TASK", cwd: other });
    assert.equal((globalThis as any)[PENDING_COUNT_KEY](), 2);
    assert.equal(calls().filter(c => c[1] === "start").at(-1)!.includes("--approve"), false);
    assert.equal(calls().filter(c => c[1] === "split").at(-1)!.includes("--env"), false);
    assert.equal(calls().find(c => c[1] === "prompt")!.at(-1)!, "ROLE_IN_TASK");
    assert.equal(calls().filter(c => c[1] === "prompt").at(-1)!.at(-1)!, "TASK");
    assert.equal(args[args.indexOf("--swarm-name") + 1], "first");
    assert.equal(h.entries.filter(e => e.customType === "swarm_spawn").length, 2);
    await assert.rejects(h.tool("swarm_spawn", { name: "first", task: "again" }), /use resume explicitly/);
    await assert.rejects(h.tool("swarm_spawn", { resume: "second", name: "bad", task: "again" }), /resume accepts only/);
    reset({ agents: [{ name: "spawner", agent: "pi", pane_id: "w1:p1", cwd: dir, agent_session: { kind: "path", value: "/other-session.jsonl" } }] });
    await assert.rejects(h.tool("swarm_spawn", { resume: "first", task: "again" }), /pending/);
    h.context.sessionManager.resetLeaf(); h.context.sessionManager.appendMessage(fauxAssistantMessage("different branch"));
    await assert.rejects(h.tool("swarm_spawn", { resume: "first", task: "again" }), /not archived/);
    const second = h.entries.find(e => e.customType === "swarm_spawn" && e.data.name === "second");
    const previous = SessionManager.open(second.data.session);
    previous.appendMessage({ role: "user", content: "TASK", timestamp: Date.now() }); previous.appendMessage(fauxAssistantMessage("done"));
    await assert.rejects(h.tool("swarm_spawn", { resume: "second", task: "Follow-up task" }), /not archived/);
    h.context.sessionManager.appendCustomMessageEntry("swarm_result", "done", true, { spawnEntryId: second.id });
    await h.tool("swarm_spawn", { resume: "second", task: "Follow-up task" });
    assert.equal(calls().filter(c => c[1] === "prompt").at(-1)!.at(-1)!, "Follow-up task");
    const resumed = calls().filter(c => c[1] === "start").at(-1)!;
    assert.equal(resumed[resumed.indexOf("--swarm-title") + 1], "peer · Follow-up task");
  } finally { await h.event("session_shutdown", { reason: "reload" }); }
});


test("a missing herdr pi integration is reported, never installed", async () => {
  reset({ integration: "pi: not installed" }); const h = await harness();
  try {
    await sleep(300);
    assert.equal(calls().some(c => c[0] === "integration" && c[1] === "install"), false);
    assert.ok(h.notices.some(n => typeof n === "string" && n.includes("herdr integration install pi")));
  } finally { await h.event("session_shutdown", { reason: "reload" }); }
  reset(); const current = await harness();
  try { await sleep(300); assert.equal(current.notices.some(n => typeof n === "string" && n.includes("integration")), false); }
  finally { await current.event("session_shutdown", { reason: "reload" }); }
});

test("the agent cap comes from pi settings swarm.maxAgents", async () => {
  reset(); const h = await harness();
  try {
    settings.swarm = { maxAgents: 1 };
    await assert.rejects(h.tool("swarm_spawn", { task: "capped" }), /admission refused: \d+\/1 online/);
    settings.swarm = { maxAgents: 0 };
    await assert.rejects(h.tool("swarm_spawn", { task: "invalid" }), /swarm.maxAgents must be a positive integer/);
  } finally { delete settings.swarm; await h.event("session_shutdown", { reason: "reload" }); }
});

test("auto names skip live agents and this session's spawn history", async () => {
  const agents = [{ name: "spawner", pane_id: "w1:p1", agent: "pi", cwd: dir }, { name: "peer-1", pane_id: "w1:p2", agent: "pi", cwd: dir }];
  reset({ agents }); const h = await harness();
  try {
    await h.tool("swarm_spawn", { task: "AUTO" });
    let args = calls().filter(c => c[1] === "start").at(-1)!;
    assert.equal(args[args.indexOf("--swarm-name") + 1], "peer-2");
    reset({ agents });
    await h.tool("swarm_spawn", { task: "NEXT" });
    args = calls().filter(c => c[1] === "start").at(-1)!;
    assert.equal(args[args.indexOf("--swarm-name") + 1], "peer-3");
  } finally { await h.event("session_shutdown", { reason: "reload" }); }
});

test("startup admission includes unnamed agents and refuses uncertain counts before starting; blocked startup keeps a durable record", async () => {
  const launch = { name: "limited", cwd: dir, args: [], task: "task", maxAgents: 1 };
  reset({ agents: [{ agent: "pi", pane_id: "w1:p2", cwd: dir }] });
  await assert.rejects(start(launch), /admission refused/); assert.equal(calls().some(c => c[1] === "start" || c[1] === "split"), false);
  reset({ agents: [{ agent: "pi", pane_id: "w1:p2" }] });
  await assert.rejects(start(launch), /cwd unknown/); assert.equal(calls().some(c => c[1] === "start"), false);
  reset({ startError: "agent_not_ready" }); const h = await harness();
  save({ ...readState(), checkRecord: h.context.sessionManager.getSessionFile() });
  try {
    await assert.rejects(h.tool("swarm_spawn", { name: "waiting-trust", task: "task" }), /agent_not_ready.*pane.*session/);
    assert.equal(h.entries.filter(e => e.customType === "swarm_spawn").length, 1);
    assert.match(readFileSync(h.context.sessionManager.getSessionFile(), "utf8"), /waiting-trust/);
    assert.equal((globalThis as any)[PENDING_COUNT_KEY](), 1); assert.equal(calls().some(c => c[1] === "prompt" || c[1] === "close"), false);
  } finally { await h.event("session_shutdown", { reason: "reload" }); }
});
