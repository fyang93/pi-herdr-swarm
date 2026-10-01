import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { DAY, post, readBoard } from "../pi-extension/board.ts";
import { send, start, splitDirection, HerdrError, identity } from "../pi-extension/herdr.ts";
import { profiles, loadout } from "../pi-extension/profiles.ts";
import { canExit, finalText, wasAborted, writeJSON, alive } from "../pi-extension/lifecycle.ts";
import swarm, { PENDING_COUNT_KEY } from "../pi-extension/index.ts";
import { frame } from "../pi-extension/ui.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const dir = mkdtempSync(join(tmpdir(), "swarm-test-"));
const fake = resolve("test/fake-herdr.cjs");
chmodSync(fake, 0o755);
Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", HERDR_BIN_PATH: fake, FAKE_HERDR_DIR: dir, PI_SWARM_PROJECT: dir });
let state: any;
function reset(extra: any = {}) {
  state = { agents: [{ name: "parent", pane_id: "w1:p1", agent: "pi", agent_status: "working" }],
    layout: { zoomed: false, panes: [{ pane_id: "w1:p1", rect: { width: 101, height: 20 } }, { pane_id: "w1:p2", rect: { width: 500, height: 100 } }] }, ...extra };
  writeJSON(join(dir, "state.json"), state);
  writeFileSync(join(dir, "calls.jsonl"), "");
}
const calls = () => readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s) as string[]);
after(() => rmSync(dir, { recursive: true, force: true }));

function harness(env: Record<string, string> = {}, branch: any[] = []) {
  for (const key of ["PI_SWARM_AUTO_EXIT", "PI_SWARM_RUN", "PI_SWARM_NAME", "PI_SWARM_SPAWNER", "PI_SWARM_BOARD"]) delete process.env[key];
  Object.assign(process.env, env);
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const notices: any[] = [];
  const entries = [...branch];
  let shutdowns = 0;
  const context: any = {
    cwd: dir, mode: "print", isIdle: () => true, hasPendingMessages: () => false, isProjectTrusted: () => true,
    sessionManager: { getBranch: () => entries, getSessionDir: () => dir, getSessionFile: () => join(dir, "session.jsonl") },
    ui: { setWidget() {}, setStatus() {}, notify: (message: string) => notices.push(message) },
    shutdown: () => { shutdowns++; },
  };
  swarm({
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerMessageRenderer() {},
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    sendMessage: async (message: any) => notices.push(message),
  } as any);
  const event = async (name: string, data: any = {}) => handlers.get(name)?.(data, context);
  const tool = (name: string, params = {}) => tools.get(name).execute("test", params, undefined, undefined, context);
  return { context, notices, entries, event, tool, shutdowns: () => shutdowns };
}
const last = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final result" }] };

test("board stores private messages, exact tags/filters, limits, validates TTL and expires physically", async () => {
  const board = join(dir, "expiry.sqlite");
  const a = post(board, { from: "a", to: "b", message: "private", tags: ["code"] });
  assert.equal(a.expires - a.created, DAY * 1000);
  post(board, { from: "c", to: "*", message: "broadcast", tags: ["codes"] });
  assert.equal(readBoard(board, { from: "a", to: "b", tag: "code" })[0].message, "private");
  assert.equal(readBoard(board, { tag: "cod" }).length, 0);
  assert.equal(readBoard(board, { limit: 1 })[0].message, "broadcast");
  post(board, { from: "a", to: "b", message: "transient" }, 0.01);
  await sleep(25);
  assert.equal(readBoard(board).length, 2);
  const db = new DatabaseSync(board);
  assert.equal(db.prepare("SELECT count(*) AS n FROM notes").get()?.n, 2);
  db.close();
  for (const ttl of [0, -1, Infinity, NaN, 366 * DAY]) assert.throws(() => post(board, { from: "a", to: "b", message: "x" }, ttl));
  assert.throws(() => readBoard(board, { limit: 0 }));
  assert.throws(() => post(board, { from: "a", to: "b", message: " " }));
});

test("independent processes concurrently append without lost writes", async () => {
  const board = join(dir, "concurrent.sqlite");
  const module = resolve("pi-extension/board.ts");
  await Promise.all(Array.from({ length: 8 }, (_, n) => promisify(execFile)(process.execPath, ["--input-type=module", "-e",
    `import {post} from ${JSON.stringify(module)};for(let i=0;i<10;i++) post(${JSON.stringify(board)},{from:'a${n}',to:'*',message:String(i)});`])));
  assert.equal(readBoard(board, { limit: 100 }).length, 80);
});

test("every private and broadcast notification sees an already committed note; failures persist without retries", async () => {
  const board = join(dir, "delivery.sqlite");
  reset({ checkBoard: board });
  const sent = await send(board, { from: "parent", to: "peer", message: "a\nb" });
  assert.equal(sent.deliveries[0].submitted, true);
  assert.deepEqual(calls()[0].slice(0, 3), ["agent", "prompt", "peer"]);
  assert.match(calls()[0][3], /a\nb/);
  reset({ checkBoard: board });
  const failure = await send(board, { from: "parent", to: "blocked", message: "important private" });
  assert.equal(failure.deliveries[0].submitted, false);
  assert.equal(calls().length, 1);
  assert.equal(readBoard(board, { to: "blocked" })[0].message, "important private");
  reset({ checkBoard: board, agents: [state.agents[0], { name: "peer", pane_id: "w1:p2", cwd: dir }, { name: "other-project", pane_id: "w1:p4", cwd: "/another-project" }, { pane_id: "w1:p3", cwd: dir }] });
  const broadcast = await send(board, { from: "parent", to: "*", message: "announcement" });
  assert.deepEqual(broadcast.deliveries.map(d => d.to).sort(), ["peer"]);
  reset({ checkBoard: board, listError: true });
  assert.equal((await send(board, { from: "parent", to: "*", message: "durable despite outage" })).deliveries[0].submitted, false);
  assert.equal(readBoard(board)[0].message, "durable despite outage");
});

test("names are resolved from the caller's current pane", async () => {
  reset();
  assert.equal(await identity(), "parent");
  reset({ agents: [{ pane_id: "w1:p1", agent: "pi" }] });
  assert.equal(await identity(), "swarm");
  assert.deepEqual(calls().at(-1), ["agent", "rename", "w1:p1", "swarm"]);
});

test("split reserves divider and only splits caller; tiny/zoomed caller gets background tab in caller workspace", async () => {
  assert.equal(splitDirection(100, 20), undefined);
  assert.equal(splitDirection(101, 15), "right");
  assert.equal(splitDirection(50, 31), "down");
  assert.equal(splitDirection(50, 30), undefined);
  reset();
  const launch = { name: "peer", cwd: dir, args: ["--tools", "read"], env: { PI_SWARM_NAME: "peer" }, task: "task\nsecond line" };
  assert.equal((await start(launch)).pane, "w1:p9");
  assert.deepEqual(calls().find(c => c[1] === "split")?.slice(0, 6), ["pane", "split", "w1:p1", "--direction", "right", "--no-focus"]);
  assert.deepEqual(calls().at(-1), ["agent", "prompt", "peer", "task\nsecond line"]);
  for (const layout of [{ ...state.layout, zoomed: true }, { ...state.layout, panes: [{ pane_id: "w1:p1", rect: { width: 48, height: 48 } }, state.layout.panes[1]] }]) {
    reset({ layout });
    assert.equal((await start(launch)).pane, "w1:p8");
    assert.deepEqual(calls().find(c => c[1] === "create")?.slice(0, 6), ["tab", "create", "--workspace", "w1", "--no-focus", "--label"]);
    assert.equal(calls().some(c => c[1] === "split"), false);
  }
});

test("start failures are not retried; uncertain/blocked panes remain inspectable", async () => {
  const launch = { name: "peer", cwd: dir, args: [], env: {}, task: "task" };
  reset({ startError: "agent_start_failed" });
  await assert.rejects(start(launch), /Startup diagnostics/);
  assert.equal(calls().filter(c => c[1] === "start").length, 1);
  assert.equal(calls().at(-1)?.[1], "close");
  for (const startError of ["agent_not_ready", "timeout"]) {
    reset({ startError });
    await assert.rejects(start(launch), /kept for inspection/);
    assert.equal(calls().some(c => c[1] === "close"), false);
  }
  reset({ promptError: "agent_blocked" });
  await assert.rejects(start(launch), /do not blindly retry/);
  assert.equal(calls().filter(c => c[1] === "prompt").length, 1);
  reset({ agents: [{ name: "peer", pane_id: "w1:p2" }] });
  await assert.rejects(start(launch), /already live/);
  assert.equal(calls().some(c => c[1] === "split"), false);
  reset({ promptError: "agent_blocked" });
  assert.equal((await send(join(dir, "errors.sqlite"), { from: "parent", to: "peer", message: "x" })).deliveries[0].submitted, false);
  assert.equal(new HerdrError("x", "y").code, "x");
});

test("profile priority, YAML, tool restrictions and standalone loadout", () => {
  const global = join(dir, "global");
  const project = join(dir, ".pi/agents");
  mkdirSync(join(global, "agents"), { recursive: true }); mkdirSync(project, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = global;
  writeFileSync(join(global, "agents/worker.md"), "---\nname: worker\ndescription: global\n---\nGlobal body");
  writeFileSync(join(project, "worker.md"), "---\nname: worker\ndescription: 'project role'\nmodel: provider/model\nthinking: low\ntools: read, bash\nsystem-prompt: append\nauto-exit: false\n---\nProject body");
  assert.equal(profiles(dir, false).find(p => p.name === "worker")?.description, "global");
  const profile = profiles(dir, true).find(p => p.name === "worker")!;
  assert.equal(profile.description, "project role");
  const settings = loadout(profile, dir, dir, "task");
  assert.equal(settings.autoExit, false);
  assert.match(settings.args[settings.args.indexOf("--tools") + 1], /^read,bash,swarm_spawn,swarm_send,swarm_list,swarm_board$/);
  assert.equal(readFileSync(join(dir, "system.md"), "utf8"), "Project body");
  assert.throws(() => loadout({ ...profile, fields: { "session-mode": "fork" } }, dir, dir, "task"), /standalone/);
  assert.throws(() => loadout({ ...profile, fields: { cli: "claude" } }, dir, dir, "task"), /Only pi/);
  delete process.env.PI_CODING_AGENT_DIR;
});

test("settled-only completion is suppressed by pending work, children, Escape and aborted tools", () => {
  assert.equal(canExit(true, last, "completed", false, 0), true);
  assert.equal(canExit(true, last, "completed", true, 0), false);
  assert.equal(canExit(true, last, "completed", false, 1), false);
  assert.equal(canExit(true, last, "aborted", false, 0), false);
  assert.equal(canExit(true, undefined, "completed", false, 0), false);
  assert.equal(wasAborted({ stopReason: "error", errorMessage: "AbortError: operation was aborted" }), true);
  assert.equal(finalText({ stopReason: "error", errorMessage: "quota" }), "Agent error: quota");
  assert.equal(alive(process.pid), true);
});

test("agent_end does not exit; final settled result persists before notification and exit marker", async () => {
  const runDir = join(dir, "finish"); mkdirSync(runDir);
  const board = join(dir, "finish.sqlite");
  reset({ checkBoard: board });
  const h = harness({ PI_SWARM_AUTO_EXIT: "1", PI_SWARM_RUN: runDir, PI_SWARM_NAME: "peer", PI_SWARM_SPAWNER: "parent", PI_SWARM_BOARD: board });
  await h.event("session_start");
  await h.event("agent_end", { messages: [last] });
  assert.equal(h.shutdowns(), 0);
  await h.event("agent_before_settle", { outcome: "completed" });
  h.context.hasPendingMessages = () => true;
  await h.event("agent_settled");
  assert.equal(readBoard(board).length, 0);
  h.context.hasPendingMessages = () => false;
  await h.event("agent_settled");
  assert.equal(h.shutdowns(), 1);
  assert.equal(readBoard(board)[0].kind, "result");
  assert.deepEqual(JSON.parse(readFileSync(join(runDir, "exit.json"), "utf8")), { type: "done", notified: true, resultCreated: readBoard(board)[0].created });
  await h.event("session_shutdown", { reason: "quit" });
});

test("final failed notification remains recoverable; provider error is not a successful result", async () => {
  const runDir = join(dir, "error-finish"); mkdirSync(runDir);
  const board = join(dir, "error-finish.sqlite");
  reset({ checkBoard: board, promptError: "agent_not_found" });
  const h = harness({ PI_SWARM_AUTO_EXIT: "1", PI_SWARM_RUN: runDir, PI_SWARM_NAME: "peer", PI_SWARM_SPAWNER: "parent", PI_SWARM_BOARD: board });
  await h.event("session_start");
  await h.event("agent_end", { messages: [{ ...last, stopReason: "error", errorMessage: "quota" }] });
  await h.event("agent_before_settle", { outcome: "error" });
  await h.event("agent_settled");
  assert.equal(h.shutdowns(), 1);
  assert.match(readBoard(board)[0].message, /quota/);
  assert.equal(JSON.parse(readFileSync(join(runDir, "exit.json"), "utf8")).notified, false);
  await h.event("session_shutdown", { reason: "quit" });
});

test("queued input arriving during completion submission prevents shutdown", async () => {
  const runDir = join(dir, "race"); mkdirSync(runDir);
  reset({ delay: 80 });
  const h = harness({ PI_SWARM_AUTO_EXIT: "1", PI_SWARM_RUN: runDir, PI_SWARM_NAME: "peer", PI_SWARM_SPAWNER: "parent", PI_SWARM_BOARD: join(dir, "race.sqlite") });
  await h.event("session_start");
  await h.event("agent_end", { messages: [last] });
  await h.event("agent_before_settle", { outcome: "completed" });
  const settled = h.event("agent_settled");
  await sleep(10); h.context.hasPendingMessages = () => true;
  await settled;
  assert.equal(h.shutdowns(), 0);
  assert.equal(existsSync(join(runDir, "exit.json")), false);
  await h.event("session_shutdown", { reason: "reload" });
});

test("Esc stays open, quit records early end, reload does not pretend to quit", async () => {
  const runDir = join(dir, "abort"); mkdirSync(runDir);
  reset();
  const h = harness({ PI_SWARM_AUTO_EXIT: "1", PI_SWARM_RUN: runDir, PI_SWARM_NAME: "peer", PI_SWARM_SPAWNER: "parent" });
  await h.event("session_start");
  await h.event("agent_end", { messages: [{ ...last, stopReason: "aborted" }] });
  await h.event("agent_before_settle", { outcome: "aborted" });
  await h.event("agent_settled");
  assert.equal(h.shutdowns(), 0);
  await h.event("session_shutdown", { reason: "reload" });
  assert.equal(existsSync(join(runDir, "exit.json")), false);
  await h.event("session_shutdown", { reason: "quit" });
  assert.equal(JSON.parse(readFileSync(join(runDir, "exit.json"), "utf8")).type, "quit");
});

test("unlisted live process remains unknown; confirmed exit without result wakes the spawner; parent shutdown does not kill peers", async () => {
  const runDir = join(dir, "missing"); mkdirSync(runDir);
  writeJSON(join(runDir, "runtime.json"), { pid: process.pid });
  const run = { name: "missing", pane: "w1:p9", dir: runDir, started: Date.now() };
  reset();
  const h = harness({}, [{ type: "custom", customType: "swarm_spawn", data: run }]);
  await h.event("session_start");
  assert.equal((globalThis as any)[PENDING_COUNT_KEY](), 1);
  await sleep(1200);
  assert.match(h.notices[0]?.content, /does not prove completion or a crash/);
  assert.equal(h.entries.some(e => e.customType === "swarm_resolved"), false);
  writeJSON(join(runDir, "exit.json"), { type: "quit" });
  await sleep(3200);
  assert.match(h.notices.at(-1)?.content, /exited \(quit\) without an unexpired result/);
  assert.equal((globalThis as any)[PENDING_COUNT_KEY](), 0);
  await h.event("session_shutdown", { reason: "quit" });
  assert.equal(calls().some(c => c[1] === "close"), false);
});

test("missed final notification is recovered from board on spawner restart", async () => {
  const runDir = join(dir, "recovery"); mkdirSync(runDir);
  const board = join(dir, "recovery.sqlite");
  const run = { name: "peer", pane: "w1:p9", dir: runDir, started: Date.now() - 100 };
  writeJSON(join(runDir, "exit.json"), { type: "done", notified: false });
  post(board, { from: "peer", to: "parent", message: "recover me", kind: "result", tags: ["result"] });
  reset();
  const h = harness({ PI_SWARM_BOARD: board }, [{ type: "custom", customType: "swarm_spawn", data: run }]);
  await h.event("session_start");
  await sleep(3200);
  assert.match(h.notices[0]?.content, /Recovered.*\n[\s\S]*recover me/);
  assert.equal(h.entries.filter(e => e.customType === "swarm_resolved").length, 1);
  await h.event("session_shutdown", { reason: "quit" });
});

test("tool primitives expose no UUID, unknown definitions fail, board-only posts do not notify", async () => {
  reset();
  const board = join(dir, "tools.sqlite");
  const h = harness({ PI_SWARM_BOARD: board });
  const result = await h.tool("swarm_list");
  assert.match(result.content[0].text, /parent · working · w1:p1/);
  assert.match(result.content[0].text, /Definitions:/);
  await assert.rejects(h.tool("swarm_spawn", { agent: "unknown", task: "x" }), /Unknown definition/);
  await h.tool("swarm_board", { message: "board only", tags: ["test"] });
  assert.equal(calls().some(c => c[1] === "prompt"), false);
  assert.match((await h.tool("swarm_board", { tag: "test" })).content[0].text, /board only/);
});

test("frames handle Chinese, ANSI and narrow widths", () => {
  const theme = { fg: (_name: string, text: string) => `\x1b[36m${text}\x1b[0m` };
  for (const width of [1, 3, 4, 8, 30, 80]) {
    const lines = frame("蜂群", ["研究员 · working · w1:p9", "\x1b[31merror\x1b[0m"], theme as any).render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
});
