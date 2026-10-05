import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, validateToolArguments } from "@earendil-works/pi-ai";
import { setTimeout as sleep } from "node:timers/promises";
import { checkMessage, validateName, namePattern, deliver, start, splitDirection, identity, projectRoot, inProject } from "../src/herdr.ts";
import { presets, loadout, snapshot } from "../src/presets.ts";
import swarm, { PENDING_COUNT_KEY } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "swarm-test-"));
const settings: { swarm?: { maxAgents?: unknown; autoEnableCodemode?: unknown }; defaultTools?: string[] } = {};
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
const scope = { root: dir, roots: new Map<string, string>() };
after(() => rmSync(dir, { recursive: true, force: true }));

async function harness(flags: Record<string, unknown> = {}) {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const notices: any[] = [];
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "test", timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage("initialized"));
  let shutdowns = 0;
  const context: any = {
    cwd: dir, mode: "print", model: getModel("openai", "gpt-4.1"), modelRegistry: { getAll: () => [getModel("openai", "gpt-4.1"), getModel("anthropic", "claude-sonnet-4-5")] }, isIdle: () => true, hasPendingMessages: () => false, isProjectTrusted: () => true,
    sessionManager: manager,
    ui: { setWidget() {}, notify: (message: string) => notices.push(message) }, shutdown: () => { shutdowns++; },
  };
  const activeTools = ["read", "swarm_spawn", "swarm_send", "swarm_list"];
  swarm({
    on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) || []), fn]),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer() {}, registerFlag() {}, getFlag: (name: string) => flags[name],
    getActiveTools: () => activeTools, setActiveTools: (names: string[]) => { activeTools.splice(0, activeTools.length, ...names); }, getAllTools: () => [...activeTools, "codemode"].map(name => ({ name })), getThinkingLevel: () => "high", getSettings: () => settings,
    appendEntry: (customType: string, data: any) => manager.appendCustomEntry(customType, data),
    sendMessage: async (message: any) => notices.push(message),
  } as any);
  const event = async (name: string, data: any = {}) => { for (const handler of handlers.get(name) || []) await handler(data, context); };
  const tool = (name: string, params = {}) => tools.get(name).execute("test", params, undefined, undefined, context);
  await event("session_start");
  return { context, notices, activeTools, get entries() { return manager.getEntries() as any[]; }, event, tool, tools, shutdowns: () => shutdowns };
}

test("swarm enables codemode once by default and opt-out preserves already enabled tools", async () => {
  reset(); settings.swarm = {};
  const enabled = await harness();
  try {
    assert.ok(enabled.activeTools.includes("codemode"));
    await enabled.event("session_start");
    settings.swarm = { autoEnableCodemode: false };
    await enabled.event("session_start");
    assert.equal(enabled.activeTools.filter(name => name === "codemode").length, 1);
  } finally { await enabled.event("session_shutdown", { reason: "reload" }); }
  const optedOut = await harness();
  try { assert.equal(optedOut.activeTools.includes("codemode"), false); }
  finally { settings.swarm = {}; await optedOut.event("session_shutdown", { reason: "reload" }); }
  settings.defaultTools = ["-codemode"];
  const disabled = await harness();
  try { assert.equal(disabled.activeTools.includes("codemode"), false); }
  finally { delete settings.defaultTools; await disabled.event("session_shutdown", { reason: "reload" }); }
});

test("message and name validation preserves limits and rejects invalid input", () => {
  assert.equal(checkMessage("x".repeat(4000)).length, 4000);
  for (const message of ["", " ", null, 42]) assert.throws(() => checkMessage(message as any), /nonempty/);
  assert.throws(() => checkMessage("x".repeat(4001)), /4000/);
  assert.equal(validateName("us-news-1"), "us-news-1");
  for (const name of ["a\nadmin", "2bad", "a".repeat(33)]) assert.throws(() => validateName(name), /names/);
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
  const discovery = await deliver({ from: "spawner", to: "*", message: "outage" }, scope);
  assert.equal(discovery.discovery?.status, "unknown");
  assert.equal(discovery.discovery?.code, "server_error");
  assert.deepEqual(discovery.deliveries, [], "a wildcard is not an actual recipient");
  await assert.rejects(deliver({ from: "spawner", to: "peer", message: "x".repeat(4001) }), /4000/);
});

test("'*' broadcasts within the project; exact names cross projects", async () => {
  reset();
  const broadcast = await deliver({ from: "spawner", to: "*", message: "announcement" }, scope);
  assert.deepEqual(broadcast.deliveries.map(d => d.to).sort(), ["blocked", "peer"]);
  assert.equal(broadcast.deliveries.find(d => d.to === "blocked")?.status, "rejected");
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

test("arbitrary star patterns are anchored, exclude sender and unnamed agents, and use project equality", async () => {
  assert.equal(namePattern("*news*")("us-news-1"), true);
  assert.equal(namePattern("us-*-1")("us-news-1"), true);
  assert.equal(namePattern("news*")("us-news-1"), false);
  assert.equal(namePattern("***news**")("a-news-b"), true);
  for (const pattern of ["news?", "[news]*", "news.*"]) assert.throws(() => namePattern(pattern));
  const roles = join(dir, "roles"); mkdirSync(roles, { recursive: true });
  const nested = join(dir, "nested"); mkdirSync(nested, { recursive: true }); await exec("git", ["init", "-q", nested]);
  reset({ agents: [{ name: "spawner", pane_id: "p1", cwd: dir }, { name: "us-news-1", pane_id: "p2", cwd: roles }, { name: "other-news", pane_id: "p3", cwd: nested }, { pane_id: "p4", cwd: dir }] });
  const result = await deliver({ from: "spawner", to: "*news*", message: "scoped" }, scope);
  assert.deepEqual(result.deliveries.map(d => d.to), ["us-news-1"]);
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
  reset({ agents: [{ name: "old-peer", pane_id: "w1:p5", agent: "pi", cwd: dir }], layouts: { "w1:p1": full, "w1:p5": { zoomed: false, panes: [{ pane_id: "w1:p5", rect: { width: 184, height: 49 } }] } } });
  await start({ ...launch, near: ["old-peer"] }); // own pane full: the peer's roomy tab is split instead of opening another
  assert.deepEqual(calls().find(c => c[1] === "split")?.slice(0, 5), ["pane", "split", "w1:p5", "--direction", "right"]);
  reset({ layouts: { "w1:p1": full } }); await start({ ...launch, near: ["gone-peer"] });
  assert.ok(calls().some(c => c[1] === "create") && !calls().some(c => c[1] === "split"));
  reset({ startError: "agent_start_failed" }); await assert.rejects(start(launch), /Startup diagnostics/);
  assert.equal(calls().filter(c => c[1] === "start").length, 1); assert.equal(calls().at(-1)?.[1], "close");
  reset({ promptError: "timeout" }); await assert.rejects(start(launch), /do not blindly retry/);
  assert.equal(calls().some(c => c[1] === "close"), false); assert.equal(calls().filter(c => c[1] === "prompt").length, 1);
});

test("bundled monitor is discoverable, spawns with its role and verbatim task, and allows trusted overrides", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const global = join(dir, "monitor-global");
  const project = join(dir, ".pi/agents");
  mkdirSync(join(global, "agents"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = global;
  reset();
  const h = await harness();
  try {
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
    assert.equal(calls().find(c => c[1] === "prompt")!.at(-1), task);
    writeFileSync(join(global, "agents/monitor.md"), "---\ndescription: user monitor\n---\nUser role");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "monitor.md"), "---\ndescription: project monitor\n---\nProject role");
    assert.equal(presets(dir, false).find(p => p.name === "monitor")?.body, "User role");
    assert.equal(presets(dir, true).find(p => p.name === "monitor")?.body, "Project role");
    assert.equal(presets(dir, true).filter(p => p.name === "monitor").length, 1);
  } finally {
    await h.event("session_shutdown", { reason: "reload" });
    rmSync(join(project, "monitor.md"), { force: true });
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
  assert.ok(args.includes("-e"));
  assert.equal(loadout({ ...selected, extensionLoaded: true }, join(dir, "session.jsonl")).includes("-e"), false);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi/settings.json"), JSON.stringify({ packages: ["git:github.com/fyang93/pi-herdr-swarm"] }));
  writeFileSync(join(global, "trust.json"), JSON.stringify({ [dir]: false }));
  context.isProjectTrusted = () => true; // spawner is trusted; peer cwd is not
  const untrustedPeer = await snapshot(undefined, context, "high", {});
  assert.equal(untrustedPeer.extensionLoaded, false);
  assert.ok(loadout(untrustedPeer, join(dir, "peer.jsonl")).includes("-e"));
  // pi reads only <cwd>/.pi/settings.json, not the Git root's, and trust is inherited from the nearest ancestor.
  writeFileSync(join(global, "trust.json"), JSON.stringify({ [dir]: true }));
  assert.equal((await snapshot(undefined, context, "high", {})).extensionLoaded, true);
  const nestedCwd = join(dir, "nested-settings"); mkdirSync(nestedCwd, { recursive: true });
  const nestedPeer = await snapshot(undefined, { ...context, cwd: nestedCwd }, "high", {});
  assert.equal(nestedPeer.extensionLoaded, false);
  assert.ok(loadout(nestedPeer, join(dir, "peer.jsonl")).includes("-e"));
  rmSync(join(dir, ".pi/settings.json"));
  assert.equal(readFileSync(join(dir, "system.md"), "utf8"), "Project body");
  assert.deepEqual(args.slice(-2), ["--append-system-prompt", join(dir, "system.md")]);
  for (const fields of [{ "session-mode": "fork" }, { cli: "claude" }]) await assert.rejects(snapshot({ ...preset, fields }, context, "high", {}));
  delete process.env.PI_CODING_AGENT_DIR;
});

test("list does not name the caller; send names it once with a notification", async () => {
  reset({ agents: [{ pane_id: "w1:p1", agent: "pi", cwd: dir }, { name: "peer", pane_id: "w1:p2", agent: "pi", cwd: dir }] });
  const h = await harness({ "swarm-name": "spawner", "swarm-spawner": "parent" });
  try {
    assert.deepEqual([...h.tools.keys()], ["swarm_spawn", "swarm_send", "swarm_list"]);
    const listed = await h.tool("swarm_list");
    assert.equal(listed.details.presets.length > 0, listed.content[0].text.includes("Presets:"));
    assert.match(listed.content[0].text, /Self: spawner\nParent: parent/);
    assert.deepEqual({ self: listed.details.self, parent: listed.details.parent }, { self: "spawner", parent: "parent" });
    assert.equal(calls().some(c => c[1] === "rename"), false);
    for (const to of ["peer", "*"]) {
      const sent = await h.tool("swarm_send", { to, message: "announcement" });
      assert.equal(sent.isError, false);
      assert.deepEqual(sent.details.deliveries, [{ to: "peer", status: "submitted" }]);
      assert.match(calls().filter(c => c[1] === "prompt").at(-1)![3], /\[swarm message\] swarm-w1-p1/);
    }
    assert.equal(calls().filter(c => c[1] === "rename").length, 1);
    assert.ok(h.notices.some(n => typeof n === "string" && n.includes("This session is now named swarm-w1-p1")));
  } finally { await h.event("session_shutdown", { reason: "reload" }); }
});

test("send schema requires a recipient and bounded message; sending requires herdr", async () => {
  reset(); const h = await harness();
  const validate = (args: any) => validateToolArguments(h.tools.get("swarm_send"), { type: "toolCall", id: "test", name: "swarm_send", arguments: args });
  try {
    assert.throws(() => validate({ message: "no recipient" }), /to/);
    for (const args of [{ to: "", message: "x" }, { to: "peer", message: "" }, { to: "peer", message: "x".repeat(4001) }, { to: "peer", message: "x", from: "impostor" }]) assert.throws(() => validate(args), /Validation failed/);
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
    assert.match(description, /use swarm_list to discover available presets and select a suitable one with agent/);
    assert.match(description, /Omit agent only when no preset fits/);
    assert.match(description, /Use swarm_send to communicate/);
    assert.doesNotMatch(description, /meaningful changes|monitoring a state/);
    await assert.rejects(h.tool("swarm_spawn", { agent: "unknown", task: "x" }), /Unknown preset/);
    await h.tool("swarm_spawn", { name: "first", task: "ROLE_IN_TASK" });
    assert.equal((globalThis as any)[PENDING_COUNT_KEY](), 1);
    const args = calls().find(c => c[1] === "start")!;
    assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-4.1");
    assert.equal(args.includes("--tools"), false);
    assert.equal(args.includes("--approve"), false);
    const other = join(dir, "nested");
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
  } finally { await h.event("session_shutdown", { reason: "reload" }); }
});


test("a missing herdr pi integration is installed once at session start", async () => {
  reset({ integration: "pi: not installed" }); const h = await harness();
  try {
    await sleep(300);
    assert.ok(calls().some(c => c[0] === "integration" && c[1] === "install" && c[2] === "pi"));
    assert.ok(h.notices.some(n => typeof n === "string" && n.includes("Installed herdr's pi integration")));
  } finally { await h.event("session_shutdown", { reason: "reload" }); }
  reset(); const current = await harness();
  try { await sleep(300); assert.equal(calls().some(c => c[0] === "integration"), false); }
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
