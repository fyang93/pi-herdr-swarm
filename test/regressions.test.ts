import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import swarm, { PENDING_COUNT_KEY } from "../pi-extension/index.ts";
import { post, readBoard, formatNote } from "../pi-extension/board.ts";
import { identity, send, addressPattern } from "../pi-extension/herdr.ts";
import { writeJSON } from "../pi-extension/lifecycle.ts";

const dir = mkdtempSync(join(tmpdir(), "swarm-regression-"));
const fake = resolve("test/fake-herdr.cjs");
chmodSync(fake, 0o755);
Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", HERDR_BIN_PATH: fake, FAKE_HERDR_DIR: dir });
const reset = (extra: any = {}) => writeJSON(join(dir, "state.json"), { agents: [{ name: "parent", pane_id: "w1:p1" }], layout: { panes: [{ pane_id: "w1:p1", rect: { width: 101, height: 20 } }] }, ...extra });
after(() => rmSync(dir, { recursive: true, force: true }));
function harness(board: string, branch: any[] = [], extraEnv: Record<string, string> = {}) {
  for (const key of ["PI_SWARM_AUTO_EXIT", "PI_SWARM_RUN", "PI_SWARM_NAME", "PI_SWARM_SPAWNER"]) delete process.env[key];
  Object.assign(process.env, { PI_SWARM_BOARD: board }, extraEnv);
  const entries = [...branch]; const notices: any[] = []; const tools = new Map<string, any>(); const handlers = new Map<string, Function>();
  let shutdowns = 0;
  const ctx: any = { cwd: dir, mode: "print", isIdle: () => true, hasPendingMessages: () => false, isProjectTrusted: () => true,
    sessionManager: { getSessionDir: () => dir, getBranch: () => entries, getSessionFile: () => join(dir, "session.jsonl") }, ui: { notify() {}, setWidget() {}, setStatus() {} }, shutdown: () => { shutdowns++; } };
  swarm({ on: (name: string, fn: Function) => handlers.set(name, fn), registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer() {},
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }), sendMessage: async (message: any) => { notices.push(message); } } as any);
  const event = async (name: string, data = {}) => handlers.get(name)?.(data, ctx);
  const tool = (name: string, params: any) => tools.get(name).execute("test", params, undefined, undefined, ctx);
  return { entries, notices, event, tool, ctx, shutdowns: () => shutdowns };
}
const assistant = (text: string) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] });

test("pinned launch identity survives herdr outage before board persistence", async () => {
  reset({ listError: true }); process.env.PI_SWARM_NAME = "peer";
  assert.equal(await identity(), "peer");
  const h = harness(join(dir, "offline.sqlite"), [], { PI_SWARM_NAME: "peer" });
  const sent = await h.tool("swarm_send", { to: "parent", message: "durable even when list is down" });
  assert.equal(sent.isError, false);
  assert.equal(readBoard(join(dir, "offline.sqlite"))[0].message, "durable even when list is down");
});

test("same-name respawn clears old consumed state and recovers its failed delivery", async () => {
  reset(); const board = join(dir, "reuse.sqlite"); const h = harness(board);
  await h.event("session_start");
  await h.tool("swarm_spawn", { agent: "worker", name: "peer", task: "test" });
  let run = h.entries.find(e => e.customType === "swarm_spawn").data;
  const first = post(board, { from: "peer", to: "parent", message: "first", kind: "result", tags: ["result"] });
  await h.event("message_start", { message: { role: "user", content: formatNote(first) } });
  writeJSON(join(run.dir, "exit.json"), { type: "done", notified: true, resultCreated: first.created });
  await sleep(1200);
  assert.equal((globalThis as any)[PENDING_COUNT_KEY](), 0);
  assert.equal(h.notices.length, 0);
  await h.tool("swarm_spawn", { agent: "worker", name: "peer", task: "second test" });
  run = h.entries.filter(e => e.customType === "swarm_spawn").at(-1).data;
  const second = post(board, { from: "peer", to: "parent", message: "second, missed", kind: "result", tags: ["result"] });
  writeJSON(join(run.dir, "exit.json"), { type: "done", notified: false, resultCreated: second.created });
  await sleep(3200);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0].content, /second, missed/);
  await h.event("session_shutdown", { reason: "quit" });
});

test("old consumed result does not stand in for latest final result at exit", async () => {
  reset(); const board = join(dir, "latest.sqlite"); const runDir = join(dir, "latest-run"); mkdirSync(runDir);
  const run = { name: "peer", pane: "w1:p9", dir: runDir, started: Date.now() - 100 };
  const old = post(board, { from: "peer", to: "parent", message: "old transient result", kind: "result", tags: ["result"] });
  await sleep(5);
  const latest = post(board, { from: "peer", to: "parent", message: "latest final result", kind: "result", tags: ["result"] });
  writeJSON(join(runDir, "exit.json"), { type: "done", notified: false, resultCreated: latest.created });
  const h = harness(board, [{ type: "custom", customType: "swarm_spawn", data: run }]);
  await h.event("session_start");
  await h.event("message_start", { message: { role: "user", content: formatNote(old) } });
  await sleep(3200);
  assert.match(h.notices[0]?.content, /latest final result/);
  await h.event("session_shutdown", { reason: "quit" });
});

test("arbitrary '*' patterns are anchored, scoped and report actual recipient names", async () => {
  assert.equal(addressPattern("*news*")?.test("us-news-1"), true);
  assert.equal(addressPattern("us-*-1")?.test("us-news-1"), true);
  assert.equal(addressPattern("news*")?.test("us-news-1"), false);
  assert.equal(addressPattern("***news**")?.source, "^.*news.*$");
  for (const pattern of ["news?", "[news]*", "news.*"]) assert.throws(() => addressPattern(pattern));
  Object.assign(process.env, { PI_SWARM_PROJECT: dir });
  reset({ agents: [
    { name: "us-news-1", pane_id: "w1:p2", cwd: dir }, { name: "news-2", pane_id: "w1:p3", cwd: join(dir, "roles") },
    { name: "blocked", pane_id: "w1:p4", cwd: dir }, { name: "other-news-1", pane_id: "w1:p5", cwd: "/other" }, { pane_id: "w1:p6", cwd: dir },
  ] });
  const result = await send(join(dir, "patterns.sqlite"), { from: "parent", to: "*news*", message: "scoped" });
  assert.deepEqual(result.deliveries.map(d => d.to).sort(), ["news-2", "us-news-1"]);
  const exact = await send(join(dir, "patterns.sqlite"), { from: "parent", to: "other-news-1", message: "explicit cross-project" });
  assert.equal(exact.deliveries[0].to, "other-news-1");
  const partial = await send(join(dir, "patterns.sqlite"), { from: "parent", to: "*", message: "partial broadcast" });
  assert.equal(partial.deliveries.find(d => d.to === "blocked")?.submitted, false);
  assert.equal(partial.deliveries.find(d => d.to === "us-news-1")?.submitted, true);
});

test("default board reads every sender without notifications, with bounded count and text", async () => {
  reset(); const board = join(dir, "bounded.sqlite");
  for (let i = 0; i < 30; i++) post(board, { from: `sender-${i}`, to: "*", message: "x".repeat(4000) });
  const h = harness(board);
  const result = await h.tool("swarm_board", {});
  assert.equal(result.details.notes.length, 20);
  assert.ok(result.content[0].text.length <= 30_000);
  assert.match(result.content[0].text, /truncated/);
  assert.equal(h.notices.length, 0);
  assert.equal(h.entries.length, 0);
});

test("send and board share 4000-character limit; long automatic final summaries still exit", async () => {
  reset(); const board = join(dir, "length.sqlite"); const runDir = join(dir, "long-run"); mkdirSync(runDir);
  assert.throws(() => post(board, { from: "a", to: "b", message: "x".repeat(4001) }), /summary and file path/);
  await assert.rejects(send(board, { from: "a", to: "b", message: "x".repeat(4001) }), /4000/);
  const h = harness(board, [], { PI_SWARM_NAME: "peer", PI_SWARM_SPAWNER: "parent", PI_SWARM_RUN: runDir, PI_SWARM_AUTO_EXIT: "1" });
  await h.event("session_start");
  await h.event("agent_end", { messages: [assistant("x".repeat(8000))] });
  await h.event("agent_before_settle", { outcome: "completed" });
  await h.event("agent_settled");
  assert.equal(h.shutdowns(), 1);
  const note = readBoard(board)[0];
  assert.ok(note.message.length <= 4000);
  assert.match(note.message, /Full final response.*session.jsonl/);
  assert.equal(note.expires - note.created, 86_400_000);
  await h.event("session_shutdown", { reason: "quit" });
});

test("input during final send produces a newer persisted final, not an exit based on old output", async () => {
  reset({ delay: 100 }); const board = join(dir, "new-input.sqlite"); const runDir = join(dir, "new-input-run"); mkdirSync(runDir);
  const h = harness(board, [], { PI_SWARM_NAME: "peer", PI_SWARM_SPAWNER: "parent", PI_SWARM_RUN: runDir, PI_SWARM_AUTO_EXIT: "1" });
  await h.event("session_start");
  await h.event("agent_end", { messages: [assistant("old")] });
  await h.event("agent_before_settle", { outcome: "completed" });
  const inFlight = h.event("agent_settled");
  await sleep(10);
  await h.event("input", { text: "new request" });
  await h.event("agent_end", { messages: [assistant("new final")] });
  await h.event("agent_settled");
  await inFlight;
  await sleep(200);
  assert.equal(h.shutdowns(), 1);
  const notes = readBoard(board);
  assert.equal(notes[0].message, "new final");
  assert.equal(JSON.parse(readFileSync(join(runDir, "exit.json"), "utf8")).resultCreated, notes[0].created);
  await h.event("session_shutdown", { reason: "quit" });
});
