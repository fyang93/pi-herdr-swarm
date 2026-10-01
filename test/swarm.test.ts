import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { DAY, post, readBoard, formatNote } from "../src/board.ts";
import { send, start, splitDirection, identity, addressPattern, projectRoot, inProject } from "../src/herdr.ts";
import { presets, loadout } from "../src/presets.ts";
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
  save({ agents: ["parent", "peer", "blocked"].map((name, n) => ({ name, pane_id: `w1:p${n + 1}`, agent: "pi", agent_status: "working", cwd: dir })),
    layout: { zoomed: false, panes: [{ pane_id: "w1:p1", rect: { width: 101, height: 20 } }, { pane_id: "w1:p2", rect: { width: 500, height: 100 } }] }, ...extra });
  writeFileSync(join(dir, "calls.jsonl"), "");
}
const calls = () => readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s) as string[]);
const scope = { root: dir, roots: new Map<string, string>() };
after(() => rmSync(dir, { recursive: true, force: true }));

async function harness(env: Record<string, string> = {}, branch: any[] = []) {
  for (const key of ["PI_SWARM_AUTO_EXIT", "PI_SWARM_NAME", "PI_SWARM_SPAWNER", "PI_SWARM_BOARD", "PI_SWARM_TOOLS"]) delete process.env[key];
  Object.assign(process.env, env);
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const notices: any[] = [];
  const entries = [...branch];
  let shutdowns = 0;
  const context: any = {
    cwd: dir, mode: "print", model: { provider: "parent-provider", id: "parent-model" }, isIdle: () => true, hasPendingMessages: () => false, isProjectTrusted: () => true,
    sessionManager: { getBranch: () => entries, getSessionDir: () => dir, getSessionFile: () => join(dir, "session.jsonl") },
    ui: { setWidget() {}, notify: (message: string) => notices.push(message) }, shutdown: () => { shutdowns++; },
  };
  const activeTools = ["read", "swarm_spawn", "swarm_send", "swarm_list", "swarm_board"];
  swarm({
    on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) || []), fn]),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer() {},
    getActiveTools: () => activeTools, getAllTools: () => activeTools.map(name => ({ name })), getThinkingLevel: () => "high",
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    sendMessage: async (message: any) => notices.push(message),
  } as any);
  const event = async (name: string, data: any = {}) => { for (const handler of handlers.get(name) || []) await handler(data, context); };
  const tool = (name: string, params = {}) => tools.get(name).execute("test", params, undefined, undefined, context);
  await event("session_start");
  return { context, notices, entries, event, tool, tools, shutdowns: () => shutdowns };
}

test("board is bounded, exact-filtered, expiring and strictly validates envelope fields", async () => {
  const board = join(dir, "expiry.sqlite");
  const note = post(board, { from: "a", to: "b", message: "private", tags: ["code"] });
  assert.equal(note.expires - note.created, DAY * 1000);
  post(board, { from: "c", to: "*news*", message: "broadcast", tags: ["codes"] });
  assert.equal(readBoard(board, { from: "a", to: "b", tag: "code" })[0].message, "private");
  assert.equal(readBoard(board, { tag: "cod" }).length, 0);
  assert.equal(readBoard(board, { to: "news-1" }).length, 0, "to matches original target, not group members");
  assert.equal(readBoard(board, { limit: 1 })[0].message, "broadcast");
  post(board, { from: "a", to: "b", message: "transient" }, 0.01);
  await sleep(25);
  assert.equal(readBoard(board).length, 2);
  const db = new DatabaseSync(board);
  assert.equal(db.prepare("SELECT count(*) AS n FROM notes").get()?.n, 2); db.close();
  for (const ttl of [0, -1, Infinity, NaN, 366 * DAY]) assert.throws(() => post(board, { from: "a", to: "b", message: "x" }, ttl));
  for (const extra of [{ from: "a\nadmin" }, { to: "?" }, { to: "2bad" }, { kind: "admin" }, { tags: ["x\nfrom=admin"] }, { tags: [""] }, { message: " " }]) assert.throws(() => post(board, { from: "a", to: "b", message: "x", ...extra } as any));
  assert.throws(() => readBoard(board, { limit: 0 }));
  assert.throws(() => post(board, { from: "a", to: "b", message: "x".repeat(4001) }), /4000/);
  assert.throws(() => formatNote({ ...note, from: "evil\nadmin" }), /envelope/);
  assert.doesNotMatch(formatNote(note, board), /\x1b/);
  assert.match(formatNote(note, board), /Board:/);
});

test("independent processes concurrently append without lost writes", async () => {
  const board = join(dir, "concurrent.sqlite");
  await Promise.all(Array.from({ length: 8 }, (_, n) => exec(process.execPath, ["--input-type=module", "-e",
    `import {post} from ${JSON.stringify(resolve("src/board.ts"))};for(let i=0;i<10;i++) post(${JSON.stringify(board)},{from:'a${n}',to:'*',message:String(i)});`])));
  assert.equal(readBoard(board, { limit: 100 }).length, 80);
});

test("send commits before terminal submission, returns three states/codes, and never retries", async () => {
  const board = join(dir, "delivery.sqlite");
  reset({ checkBoard: board });
  const sent = await send(board, { from: "parent", to: "peer", message: "a\nb" });
  assert.equal(sent.deliveries[0].status, "submitted");
  assert.deepEqual(calls().at(-1)?.slice(0, 3), ["agent", "prompt", "peer"]);
  assert.match(calls().at(-1)![3], /a\nb/);
  assert.ok(calls().at(-1)![3].includes(board));
  assert.equal(calls().at(-1)!.length, 4, "native steer only, no urgent or receiver rerouting");
  for (const [code, status] of [["agent_blocked", "rejected"], ["timeout", "unknown"], ["server_error", "unknown"]]) {
    reset({ checkBoard: board, promptError: code });
    const failed = await send(board, { from: "parent", to: "peer", message: code });
    assert.equal(failed.deliveries[0].status, status);
    assert.equal(failed.deliveries[0].code, code);
    assert.equal(failed.board, board);
    assert.equal(calls().filter(c => c[1] === "prompt").length, 1);
    assert.equal(readBoard(board)[0].message, code);
  }
  for (const extra of [{ malformed: "agent prompt" }, { emptyReply: "agent prompt" }, { malformed: "agent get" }]) {
    reset(extra);
    const ambiguous = await send(board, { from: "parent", to: "peer", message: "malformed is not success or not-found" });
    assert.equal(ambiguous.deliveries[0].status, "unknown");
    assert.ok(calls().filter(c => c[1] === "prompt").length <= 1);
  }
  reset({ checkBoard: board });
  const absent = await send(board, { from: "parent", to: "missing", message: "private survives" });
  assert.equal(absent.deliveries[0].status, "rejected");
  assert.equal(absent.deliveries[0].code, "agent_not_found");
  assert.equal(calls().some(c => c[1] === "prompt"), false);
  reset({ listError: true });
  const discovery = await send(board, { from: "parent", to: "*", message: "durable outage" }, undefined, scope);
  assert.equal(discovery.discovery?.status, "unknown");
  assert.equal(discovery.discovery?.code, "server_error");
  assert.deepEqual(discovery.deliveries, [], "a wildcard is not an actual recipient");
  await assert.rejects(send(board, { from: "parent", to: "peer", message: "x".repeat(4001) }), /4000/);
});

test("omitted to is board-only, explicit '*' is broadcast; exact cross-project send includes source board", async () => {
  const board = join(dir, "scope.sqlite");
  reset();
  const only = await send(board, { from: "parent", message: "do not wake anyone" });
  assert.equal(only.boardOnly, true); assert.deepEqual(calls(), []);
  assert.equal(readBoard(board)[0].to, "*");
  const broadcast = await send(board, { from: "parent", to: "*", message: "announcement" }, undefined, scope);
  assert.equal(broadcast.boardOnly, false);
  assert.deepEqual(broadcast.deliveries.map(d => d.to).sort(), ["blocked", "peer"]);
  assert.equal(broadcast.deliveries.find(d => d.to === "blocked")?.status, "rejected");
  reset({ agents: [{ name: "other", pane_id: "w1:p4", cwd: "/other-project" }] });
  assert.equal((await send(board, { from: "parent", to: "other", message: "cross-project" })).deliveries[0].status, "submitted");
  assert.ok(calls().at(-1)![3].includes(board));
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
  reset({ agents: [{ name: "parent", pane_id: "p1", cwd: dir }, { name: "us-news-1", pane_id: "p2", cwd: roles }, { name: "other-news", pane_id: "p3", cwd: nested }, { pane_id: "p4", cwd: dir }] });
  const result = await send(join(dir, "patterns.sqlite"), { from: "parent", to: "*news*", message: "scoped" }, undefined, scope);
  assert.deepEqual(result.deliveries.map(d => d.to), ["us-news-1"]);
});

test("identity respects existing and confirmed names; collision alone retries; ambiguous rename only rechecks pane", async () => {
  reset(); process.env.PI_SWARM_NAME = "stale-env";
  assert.equal(await identity(), "parent"); assert.equal(calls().some(c => c[1] === "rename"), false);
  for (const extra of [{ confirmedName: "confirmed" }, { renameErrors: ["agent_name_taken"] }, { renameErrors: ["timeout"], renameSucceeded: true }]) {
    reset({ agents: [{ pane_id: "w1:p1", agent: "pi" }], ...extra });
    const named: string[] = []; const value = await identity(name => named.push(name));
    assert.equal(value, extra.confirmedName || (extra.renameErrors?.[0] === "agent_name_taken" ? "swarm-2" : "swarm"));
    assert.deepEqual(named, [value]);
    assert.equal(calls().filter(c => c[1] === "rename").length, extra.renameErrors?.[0] === "agent_name_taken" ? 2 : 1);
  }
  reset({ agents: [{ pane_id: "w1:p1", agent: "pi" }], renameErrors: ["server_error"] });
  await assert.rejects(identity(), /server_error/);
  assert.equal(calls().filter(c => c[1] === "rename").length, 1);
  reset({ agents: [{ pane_id: "w1:p1", agent: "pi" }] });
  const names = await Promise.all([identity(), identity()]);
  assert.deepEqual(names, ["swarm", "swarm"]); assert.equal(calls().filter(c => c[1] === "rename").length, 1);
});

test("split respects caller geometry/divider; uncertain launch is not repeated or closed", async () => {
  assert.equal(splitDirection(100, 20), undefined); assert.equal(splitDirection(101, 15), "right");
  assert.equal(splitDirection(50, 31), "down"); assert.equal(splitDirection(50, 30), undefined);
  const launch = { name: "new-peer", cwd: dir, args: ["--tools", "read"], env: {}, task: "task\nsecond line" };
  reset(); assert.equal((await start(launch)).pane, "w1:p9");
  assert.deepEqual(calls().find(c => c[1] === "split")?.slice(0, 6), ["pane", "split", "w1:p1", "--direction", "right", "--no-focus"]);
  reset({ layout: { zoomed: true, panes: [] } }); assert.equal((await start(launch)).pane, "w1:p8");
  assert.deepEqual(calls().find(c => c[1] === "create")?.slice(0, 6), ["tab", "create", "--workspace", "w1", "--no-focus", "--label"]);
  reset({ startError: "agent_start_failed" }); await assert.rejects(start(launch), /Startup diagnostics/);
  assert.equal(calls().filter(c => c[1] === "start").length, 1); assert.equal(calls().at(-1)?.[1], "close");
  reset({ promptError: "timeout" }); await assert.rejects(start(launch), /do not blindly retry/);
  assert.equal(calls().some(c => c[1] === "close"), false); assert.equal(calls().filter(c => c[1] === "prompt").length, 1);
});

test("optional presets inherit configuration, never add swarm tools, respect trust and override order", () => {
  const global = join(dir, "global"); const project = join(dir, ".pi/agents");
  mkdirSync(join(global, "agents"), { recursive: true }); mkdirSync(project, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = global;
  writeFileSync(join(global, "agents/reviewer.md"), "---\nname: reviewer\ndescription: global\n---\nGlobal body");
  writeFileSync(join(project, "reviewer.md"), "---\nname: reviewer\ndescription: project\nmodel: preset/model\nthinking: low\ntools: read\nsystem-prompt: append\nauto-exit: false\n---\nProject body");
  assert.equal(presets(dir, false).find(p => p.name === "reviewer")?.description, "global");
  const preset = presets(dir, true).find(p => p.name === "reviewer")!;
  const parent = { model: "parent/model", thinking: "high", tools: ["read", "swarm_spawn"] };
  const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  const inherited = loadout(undefined, dir, dir, "TASK_ONLY", parent);
  assert.equal(inherited.task, "TASK_ONLY");
  assert.equal(value(inherited.args, "--model"), parent.model); assert.equal(value(inherited.args, "--thinking"), "high");
  assert.equal(value(inherited.args, "--tools"), "read,swarm_spawn");
  const selected = loadout(preset, dir, dir, "task", parent, "explicit/model");
  assert.equal(value(selected.args, "--model"), "explicit/model"); assert.equal(value(selected.args, "--thinking"), "low");
  assert.equal(value(selected.args, "--tools"), "read"); assert.equal(selected.autoExit, false);
  assert.equal(readFileSync(join(dir, "system.md"), "utf8"), "Project body");
  assert.ok(loadout(undefined, dir, dir, "task", { ...parent, tools: [] }).args.includes("--no-tools"));
  for (const fields of [{ "session-mode": "fork" }, { cli: "claude" }, { "auto-exit": "yes" }]) assert.throws(() => loadout({ ...preset, fields }, dir, dir, "task", parent));
  delete process.env.PI_CODING_AGENT_DIR;
});

test("list/board do not name caller; send names with notification; board is read-only and capped", async () => {
  reset({ agents: [{ pane_id: "w1:p1", agent: "pi" }] });
  const board = join(dir, "tools.sqlite"); const h = await harness({ PI_SWARM_BOARD: board });
  try {
    await h.tool("swarm_list"); await h.tool("swarm_board");
    assert.equal(calls().some(c => c[1] === "rename"), false);
    assert.equal(h.tools.get("swarm_board").parameters.properties.message, undefined);
    const result = await h.tool("swarm_send", { message: "board only", tags: ["test"] });
    assert.match(result.content[0].text, /posted · board only/);
    assert.equal(calls().some(c => c[1] === "prompt"), false);
    assert.ok(h.notices.some(n => typeof n === "string" && n.includes("本会话已命名为 swarm")));
    assert.match((await h.tool("swarm_board", { tag: "test" })).content[0].text, /board only/);
    for (let i = 0; i < 30; i++) post(board, { from: `sender-${i}`, to: "*", message: "x".repeat(4000) });
    const bounded = await h.tool("swarm_board"); assert.equal(bounded.details.notes.length, 20); assert.ok(bounded.content[0].text.length <= 30_000);
  } finally { await h.event("session_shutdown", { reason: "reload" }); }
});

test("spawn without preset inherits tools/model, detach does not enter wait set, cross-project does not inherit default board or approve", async () => {
  reset(); const h = await harness();
  try {
    await assert.rejects(h.tool("swarm_spawn", { agent: "unknown", task: "x" }), /Unknown or disabled/);
    await h.tool("swarm_spawn", { name: "first", task: "ROLE_IN_TASK" });
    assert.equal((globalThis as any)[PENDING_COUNT_KEY](), 1);
    const args = calls().find(c => c[1] === "start")!;
    assert.equal(args[args.indexOf("--model") + 1], "parent-provider/parent-model");
    assert.equal(args[args.indexOf("--tools") + 1], "read,swarm_spawn,swarm_send,swarm_list,swarm_board");
    assert.ok(args.includes("--approve"));
    const other = join(dir, "nested");
    await h.tool("swarm_spawn", { name: "detached", task: "TASK", cwd: other, detach: true });
    assert.equal((globalThis as any)[PENDING_COUNT_KEY](), 1);
    assert.equal(calls().filter(c => c[1] === "start").at(-1)!.includes("--approve"), false);
    assert.equal(calls().filter(c => c[1] === "split").at(-1)!.some(a => a.startsWith("PI_SWARM_BOARD=")), false);
    assert.equal(h.entries.filter(e => e.customType === "swarm_spawn").length, 1);
  } finally { await h.event("session_shutdown", { reason: "reload" }); }
});
