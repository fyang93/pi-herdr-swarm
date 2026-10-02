import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { setTimeout as sleep } from "node:timers/promises";
import { DAY, boardPath, post, postSync, readBoard, formatNote } from "../src/board.ts";
import { send, start, splitDirection, identity, addressPattern, projectRoot, inProject } from "../src/herdr.ts";
import { presets, loadout, snapshot } from "../src/presets.ts";
import swarm, { PENDING_COUNT_KEY } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "swarm-test-"));
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

async function harness() {
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
  const activeTools = ["read", "swarm_spawn", "swarm_send", "swarm_list", "swarm_board"];
  swarm({
    on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) || []), fn]),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer() {}, registerFlag() {}, getFlag() {},
    getActiveTools: () => activeTools, getAllTools: () => activeTools.map(name => ({ name })), getThinkingLevel: () => "high",
    appendEntry: (customType: string, data: any) => manager.appendCustomEntry(customType, data),
    sendMessage: async (message: any) => notices.push(message),
  } as any);
  const event = async (name: string, data: any = {}) => { for (const handler of handlers.get(name) || []) await handler(data, context); };
  const tool = (name: string, params = {}) => tools.get(name).execute("test", params, undefined, undefined, context);
  await event("session_start");
  return { context, notices, get entries() { return manager.getEntries() as any[]; }, event, tool, tools, shutdowns: () => shutdowns };
}

test("board is bounded, exact-filtered, expiring and strictly validates envelope fields", async () => {
  const board = join(dir, "expiry-board");
  const note = await post(board, { from: "a", to: "b", message: "private" });
  assert.equal(note.expires - note.created, DAY * 1000);
  await post(board, { from: "c", to: "*news*", message: "broadcast" });
  assert.equal((await readBoard(board, { from: "a", to: "b" }))[0].message, "private");
  assert.equal((await readBoard(board, { to: "news-1" })).length, 0, "to matches original target, not group members");
  assert.equal((await readBoard(board, { limit: 1 }))[0].message, "broadcast");
  const markdown = readFileSync(join(board, readdirSync(board).find(f => f.includes("-a.md"))!), "utf8");
  writeFileSync(join(board, "000-expired.md"), markdown.replace(new Date(note.created).toISOString(), "2020-01-01T00:00:00.000Z").replace(new Date(note.expires).toISOString(), "2020-01-02T00:00:00.000Z"));
  assert.equal((await readBoard(board)).length, 2);
  assert.equal(readdirSync(board).filter(f => f.endsWith(".md")).length, 2);
  writeFileSync(join(board, "999-invalid.md"), "---\nfrom: [broken\n---\ninvalid");
  assert.equal((await readBoard(board)).length, 2);
  assert.match(markdown, /created: "\d{4}-/); assert.match(markdown, /private/);
  for (const extra of [{ from: "a\nadmin" }, { to: "?" }, { to: "2bad" }, { kind: "admin" }, { message: " " }]) await assert.rejects(post(board, { from: "a", to: "b", message: "x", ...extra } as any));
  await assert.rejects(readBoard(board, { limit: 0 }));
  await assert.rejects(post(board, { from: "a", to: "b", message: "x".repeat(4001) }), /4000/);
  assert.throws(() => formatNote({ ...note, from: "evil\nadmin" }), /envelope/);
  assert.doesNotMatch(formatNote(note), /\x1b/);
  assert.doesNotMatch(formatNote(note), /Board:/);
});

test("independent processes concurrently append without lost writes", async () => {
  const board = join(dir, "concurrent-board");
  await Promise.all(Array.from({ length: 8 }, (_, n) => exec(process.execPath, ["--input-type=module", "-e",
    `import {post} from ${JSON.stringify(resolve("src/board.ts"))};Date.now=()=>1800000000000;for(let i=0;i<10;i++) post(${JSON.stringify(board)},{from:'writer',to:'*',message:'${n}-'+String(i)});`])));
  assert.equal((await readBoard(board, { limit: 100 })).length, 80);
  assert.equal(new Set((await readBoard(board, { limit: 100 })).map(n => n.message)).size, 80);
  assert.equal(readdirSync(board).some(f => f.endsWith(".tmp")), false);
});

test("send commits before terminal submission, returns three states/codes, and never retries", async () => {
  const board = join(dir, "delivery-board");
  reset({ checkBoard: board });
  const sent = await send(board, { from: "spawner", to: "peer", message: "a\nb" });
  assert.equal(sent.deliveries[0].status, "submitted");
  assert.deepEqual(calls().at(-1)?.slice(0, 3), ["agent", "prompt", "peer"]);
  assert.match(calls().at(-1)![3], /a\nb/);
  assert.equal(calls().at(-1)!.length, 4, "native steer only, no urgent or receiver rerouting");
  for (const [code, status] of [["agent_blocked", "rejected"], ["timeout", "unknown"], ["server_error", "unknown"]]) {
    reset({ checkBoard: board, promptError: code });
    const failed = await send(board, { from: "spawner", to: "peer", message: code });
    assert.equal(failed.deliveries[0].status, status);
    assert.equal(failed.deliveries[0].code, code);
    assert.equal(failed.board, board);
    assert.equal(calls().filter(c => c[1] === "prompt").length, 1);
    assert.equal((await readBoard(board))[0].message, code);
  }
  for (const extra of [{ malformed: "agent prompt" }, { emptyReply: "agent prompt" }]) {
    reset(extra);
    const ambiguous = await send(board, { from: "spawner", to: "peer", message: "malformed is not success or not-found" });
    assert.equal(ambiguous.deliveries[0].status, "unknown");
    assert.ok(calls().filter(c => c[1] === "prompt").length <= 1);
  }
  reset({ checkBoard: board });
  const absent = await send(board, { from: "spawner", to: "missing", message: "private survives" });
  assert.equal(absent.deliveries[0].status, "rejected");
  assert.equal(absent.deliveries[0].code, "agent_not_found");
  assert.equal(calls().filter(c => c[1] === "prompt").length, 1);
  assert.equal(calls().some(c => c[1] === "get" || c[1] === "start"), false);
  reset({ listError: true });
  const discovery = await send(board, { from: "spawner", to: "*", message: "durable outage" }, scope);
  assert.equal(discovery.discovery?.status, "unknown");
  assert.equal(discovery.discovery?.code, "server_error");
  assert.deepEqual(discovery.deliveries, [], "a wildcard is not an actual recipient");
  await assert.rejects(send(board, { from: "spawner", to: "peer", message: "x".repeat(4001) }), /4000/);
});

test("omitted to is board-only, explicit '*' is broadcast; exact cross-project send omits board path", async () => {
  const board = join(dir, "scope-board");
  reset();
  const only = await send(board, { from: "spawner", message: "do not wake anyone" });
  assert.equal(only.boardOnly, true); assert.deepEqual(calls(), []);
  assert.equal((await readBoard(board))[0].to, "*");
  const broadcast = await send(board, { from: "spawner", to: "*", message: "announcement" }, scope);
  assert.equal(broadcast.boardOnly, false);
  assert.deepEqual(broadcast.deliveries.map(d => d.to).sort(), ["blocked", "peer"]);
  assert.equal(broadcast.deliveries.find(d => d.to === "blocked")?.status, "rejected");
  reset({ agents: [{ name: "other", pane_id: "w1:p4", cwd: "/other-project" }] });
  assert.equal((await send(board, { from: "spawner", to: "other", message: "cross-project" })).deliveries[0].status, "submitted");
  assert.equal(calls().at(-1)![3].includes(board), false);
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
  assert.equal(addressPattern("*news*")?.test("us-news-1"), true);
  assert.equal(addressPattern("us-*-1")?.test("us-news-1"), true);
  assert.equal(addressPattern("news*")?.test("us-news-1"), false);
  assert.equal(addressPattern("***news**")?.source, "^.*news.*$");
  for (const pattern of ["news?", "[news]*", "news.*"]) assert.throws(() => addressPattern(pattern));
  const roles = join(dir, "roles"); mkdirSync(roles, { recursive: true });
  const nested = join(dir, "nested"); mkdirSync(nested, { recursive: true }); await exec("git", ["init", "-q", nested]);
  reset({ agents: [{ name: "spawner", pane_id: "p1", cwd: dir }, { name: "us-news-1", pane_id: "p2", cwd: roles }, { name: "other-news", pane_id: "p3", cwd: nested }, { pane_id: "p4", cwd: dir }] });
  const result = await send(join(dir, "patterns-board"), { from: "spawner", to: "*news*", message: "scoped" }, scope);
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
  const launch = { name: "new-peer", cwd: dir, args: ["--thinking", "low"], env: {}, task: "task\nsecond line" };
  reset(); assert.equal((await start(launch)).pane, "w1:p9");
  assert.deepEqual(calls().find(c => c[1] === "split")?.slice(0, 6), ["pane", "split", "w1:p1", "--direction", "right", "--no-focus"]);
  reset({ layout: { zoomed: true, panes: [] } }); assert.equal((await start(launch)).pane, "w1:p8");
  assert.deepEqual(calls().find(c => c[1] === "create")?.slice(0, 6), ["tab", "create", "--workspace", "w1", "--no-focus", "--label"]);
  reset({ startError: "agent_start_failed" }); await assert.rejects(start(launch), /Startup diagnostics/);
  assert.equal(calls().filter(c => c[1] === "start").length, 1); assert.equal(calls().at(-1)?.[1], "close");
  reset({ promptError: "timeout" }); await assert.rejects(start(launch), /do not blindly retry/);
  assert.equal(calls().some(c => c[1] === "close"), false); assert.equal(calls().filter(c => c[1] === "prompt").length, 1);
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
  assert.equal(loadout(inherited, join(dir, "session.jsonl"), "TASK_ONLY").task, "TASK_ONLY");
  const selected = await snapshot(preset, context, "high", { model: "openai/gpt-4.1" });
  assert.equal(selected.model, "openai/gpt-4.1"); assert.equal(selected.thinking, "off");
  const settings = loadout(selected, join(dir, "session.jsonl"), "task");
  assert.equal(settings.args.includes("--tools"), false); assert.equal(settings.args.includes("--no-tools"), false);
  assert.equal(readFileSync(join(dir, "system.md"), "utf8"), "Project body");
  assert.deepEqual(settings.args.slice(-2), ["--append-system-prompt", join(dir, "system.md")]);
  for (const fields of [{ "session-mode": "fork" }, { cli: "claude" }]) await assert.rejects(snapshot({ ...preset, fields }, context, "high", {}));
  delete process.env.PI_CODING_AGENT_DIR;
});

test("list/board do not name caller; send names with notification; board is read-only and capped", async () => {
  reset({ agents: [{ pane_id: "w1:p1", agent: "pi" }] });
  const board = boardPath(dir); const h = await harness();
  try {
    await h.tool("swarm_list"); await h.tool("swarm_board");
    assert.equal(calls().some(c => c[1] === "rename"), false);
    assert.equal(h.tools.get("swarm_board").parameters.properties.message, undefined);
    const result = await h.tool("swarm_send", { message: "board only" });
    assert.match(result.content[0].text, /posted · board only/);
    assert.equal(calls().some(c => c[1] === "prompt"), false);
    assert.ok(h.notices.some(n => typeof n === "string" && n.includes("本会话已命名为 swarm-w1-p1")));
    assert.match((await h.tool("swarm_board", { from: "swarm-w1-p1" })).content[0].text, /board only/);
    for (let i = 0; i < 30; i++) await post(board, { from: `sender-${i}`, to: "*", message: "x".repeat(4000) });
    const bounded = await h.tool("swarm_board"); assert.equal(bounded.details.notes.length, 20); assert.ok(bounded.content[0].text.length <= 30_000);
  } finally { await h.event("session_shutdown", { reason: "reload" }); }
});

test("spawn inherits model but no tool restrictions; detach retains history without waiting", async () => {
  reset(); const h = await harness();
  try {
    await assert.rejects(h.tool("swarm_spawn", { agent: "unknown", task: "x" }), /Unknown preset/);
    await h.tool("swarm_spawn", { name: "first", task: "ROLE_IN_TASK" });
    assert.equal((globalThis as any)[PENDING_COUNT_KEY](), 1);
    const args = calls().find(c => c[1] === "start")!;
    assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-4.1");
    assert.equal(args.includes("--tools"), false);
    assert.equal(args.includes("--approve"), false);
    const other = join(dir, "nested");
    await h.tool("swarm_spawn", { name: "detached", task: "TASK", cwd: other, detach: true });
    assert.equal((globalThis as any)[PENDING_COUNT_KEY](), 1);
    assert.equal(calls().filter(c => c[1] === "start").at(-1)!.includes("--approve"), false);
    assert.equal(calls().filter(c => c[1] === "split").at(-1)!.includes("--env"), false);
    assert.equal(calls().find(c => c[1] === "prompt")!.at(-1)!, "你是 first，由 spawner 派出。你的最后一条回复会作为结果交给 spawner，之后你会自动退出。\n\nROLE_IN_TASK");
    assert.match(calls().filter(c => c[1] === "prompt").at(-1)!.at(-1)!, /会写进留言板/);
    assert.equal(args[args.indexOf("--swarm-name") + 1], "first");
    assert.equal(h.entries.filter(e => e.customType === "swarm_spawn").length, 2);
    await assert.rejects(h.tool("swarm_spawn", { name: "first", task: "again" }), /use resume explicitly/);
    await assert.rejects(h.tool("swarm_spawn", { resume: "detached", name: "bad", task: "again" }), /resume accepts only/);
    reset({ agents: [{ name: "spawner", agent: "pi", pane_id: "w1:p1", cwd: dir, agent_session: { kind: "path", value: "/other-session.jsonl" } }] });
    await assert.rejects(h.tool("swarm_spawn", { resume: "first", task: "again" }), /pending/);
    h.context.sessionManager.resetLeaf(); h.context.sessionManager.appendMessage(fauxAssistantMessage("different branch"));
    await assert.rejects(h.tool("swarm_spawn", { resume: "first", task: "again" }), /not archived/);
  } finally { await h.event("session_shutdown", { reason: "reload" }); }
});

test("board reads are descriptor-bounded; synchronous publication never scans or reclaims; I/O errors are not empty", async () => {
  const board = join(dir, "bounded-board");
  const note = postSync(board, { from: "a", to: "b", message: "old" });
  const file = join(board, readdirSync(board)[0]);
  writeFileSync(file, readFileSync(file, "utf8").replace(new Date(note.created).toISOString(), "2020-01-01T00:00:00.000Z").replace(new Date(note.expires).toISOString(), "2020-01-02T00:00:00.000Z"));
  postSync(board, { from: "b", to: "a", message: "new" });
  assert.ok(readdirSync(board).includes(basename(file)));
  const big = join(board, "999-large.md"); const directory = join(board, "999-directory.md");
  writeFileSync(big, "x".repeat(64 * 1024 + 1)); mkdirSync(directory);
  if (process.platform !== "win32") await exec("mkfifo", [join(board, "999-pipe.md")]);
  const skipped: string[] = [];
  assert.deepEqual((await readBoard(board, {}, path => skipped.push(path))).map(n => n.message), ["new"]);
  assert.ok(skipped.some(s => s.includes(big))); assert.ok(skipped.some(s => s.includes(directory)));
  assert.equal(readdirSync(board).includes(basename(file)), false);
  await assert.rejects(readBoard(big), /ENOTDIR/);
});

test("startup admission includes unnamed agents and refuses uncertain counts before starting; blocked startup keeps a durable record", async () => {
  const launch = { name: "limited", cwd: dir, args: [], env: {}, task: "task", maxAgents: 1 };
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
