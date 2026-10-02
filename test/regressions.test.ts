import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import swarm, { PENDING_COUNT_KEY } from "../src/index.ts";
import { boardPath, readBoard } from "../src/board.ts";
import { readSession, readResult, lastReply, pendingRuns, type Run } from "../src/run.ts";

const dir = mkdtempSync(join(tmpdir(), "swarm-runtime-"));
Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", HERDR_BIN_PATH: resolve("test/fake-herdr.cjs"), FAKE_HERDR_DIR: dir });
const originalKeys = getKeybindings();
setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.interrupt": { defaultKeys: "escape", description: "Interrupt" } }));
const state = (agents: any[] = []) => { writeFileSync(join(dir, "state.json"), JSON.stringify({ agents })); writeFileSync(join(dir, "calls.jsonl"), ""); };
after(() => { setKeybindings(originalKeys); rmSync(dir, { recursive: true, force: true }); });
async function runtime(auto = false, extra?: ExtensionFactory, manager?: SessionManager) {
  const caseDir = mkdtempSync(join(dir, "case-")); const cwd = manager?.getCwd() || caseDir;
  const sessionManager = manager || SessionManager.create(cwd, caseDir);
  const faux = fauxProvider({ provider: "swarm-test", models: [{ id: "test-model", reasoning: false }] });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: caseDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => pi.registerProvider(faux.provider), swarm, ...(extra ? [extra] : [])] });
  await loader.reload();
  if (auto) for (const [name, value] of Object.entries({ "swarm-name": "worker", "swarm-spawner": "spawner", "swarm-session": sessionManager.getSessionFile()! })) loader.getExtensions().runtime.flagValues.set(name, value);
  const modelRuntime = await ModelRuntime.create({ authPath: join(caseDir, "auth.json"), modelsPath: join(caseDir, "models.json") });
  const { session } = await createAgentSession({ cwd, agentDir: caseDir, model: faux.getModel(), thinkingLevel: "xhigh", modelRuntime, resourceLoader: loader, settingsManager, sessionManager });
  let shutdowns = 0; let editor = ""; let terminalInput: ((data: string) => unknown) | undefined;
  const errors: string[] = []; const notices: string[] = [];
  await session.bindExtensions({ mode: "tui", shutdownHandler: () => { shutdowns++; }, onError: e => errors.push(e.error),
    uiContext: { setWidget() {}, getEditorText: () => editor, notify: (message: string) => notices.push(message), onTerminalInput: (handler: typeof terminalInput) => { terminalInput = handler; return () => { terminalInput = undefined; }; } } as any });
  return { session, faux, board: boardPath(cwd), errors, notices, draft: (text: string) => { editor = text; }, type: (data: string) => terminalInput?.(data), shutdowns: () => shutdowns,
    close: async () => { await session.extensionRunner!.emit({ type: "session_shutdown", reason: "reload" }); session.dispose(); } };
}
const count = () => (globalThis as any)[PENDING_COUNT_KEY]?.() ?? 0;
const results = (s: SessionManager) => s.getBranch().filter(e => e.type === "custom_message" && e.customType === "swarm_result");
function spawnerSession() { const cwd = mkdtempSync(join(dir, "spawner-")); const m = SessionManager.create(cwd, cwd); m.appendMessage({ role: "user", content: "start", timestamp: Date.now() }); return m; }
function peerRun(name: string, spawner: SessionManager): Run {
  const m = SessionManager.create(spawner.getCwd(), mkdtempSync(join(dir, "peer-")));
  m.appendMessage({ role: "user", content: "task", timestamp: Date.now() }); m.appendMessage(fauxAssistantMessage(`${name} final`));
  const run: Run = { name, session: m.getSessionFile()!, pane: "w1:p9", boundary: null, detach: false, snapshot: { cwd: spawner.getCwd(), model: "swarm-test/test-model", thinking: "off" } };
  spawner.appendCustomEntry("swarm_spawn", run); return run;
}
const live = (run: Run, status = "working", name: string | undefined = run.name) => ({ name, pane_id: "w1:p19", agent: "pi", agent_status: status, agent_session: { kind: "path", value: run.session } });

test("result and exit: native settled completion archives once before shutdown; manual, error and interrupted outcomes", async () => {
  for (const [auto, reply, expected] of [[false, fauxAssistantMessage("manual"), 0], [true, fauxAssistantMessage("final reply"), 1], [true, fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" }), 1], [true, fauxAssistantMessage("stopped", { stopReason: "aborted" }), 0]] as const) {
    state(); const r = await runtime(auto);
    try {
      assert.equal(r.session.thinkingLevel, "off"); assert.ok(r.session.getActiveToolNames().includes("swarm_spawn"));
      r.faux.setResponses([reply]); await r.session.prompt("task"); await sleep(20); assert.equal(r.shutdowns(), expected);
      if (expected) { assert.equal((await readBoard(r.board)).length, 1); assert.equal((await readBoard(r.board))[0].to, "spawner"); }
      else assert.equal(existsSync(r.board), false);
      assert.equal(readFileSync(join(dir, "calls.jsonl"), "utf8"), ""); assert.deepEqual(r.errors, []);
    } finally { await r.close(); }
  }
});

test("user cancellation: actual deferred-settle input, before_settle Escape and editor draft invalidate exit", async () => {
  state(); let session: any; let submitted = false; let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(r => { entered = r; }); const hold = new Promise<void>(r => { release = r; });
  const r = await runtime(true, pi => {
    pi.on("agent_settled", () => { if (!submitted) { submitted = true; void session.prompt("second", { expandPromptTemplates: false }); } });
    pi.on("before_agent_start", async e => { if (e.prompt === "second") { entered(); await hold; } });
  }); session = r.session;
  try {
    r.faux.setResponses([fauxAssistantMessage("old"), fauxAssistantMessage("new")]); const first = r.session.prompt("first"); await started; await sleep(25);
    assert.equal(r.session.isIdle, true); assert.equal(r.session.pendingMessageCount, 0); assert.equal(r.shutdowns(), 0);
    release(); await first; await sleep(20); assert.equal(r.shutdowns(), 1); assert.deepEqual((await readBoard(r.board)).map(n => n.message), ["new"]);
  } finally { release(); await r.close(); }
  let ready!: () => void; let resume!: () => void; let once = true;
  const before = new Promise<void>(r => { ready = r; }); const blocked = new Promise<void>(r => { resume = r; });
  const escape = await runtime(true, pi => { pi.on("agent_before_settle", async () => { if (once) { once = false; ready(); await blocked; } }); });
  try {
    escape.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("next")]); const task = escape.session.prompt("first"); await before;
    assert.equal(escape.type("\x1b"), undefined); resume(); await task; await sleep(20); assert.equal(escape.shutdowns(), 0);
    escape.draft("unfinished draft"); await escape.session.prompt("next"); await sleep(20); assert.equal(escape.shutdowns(), 0);
    escape.draft(""); await escape.session.prompt("continue"); await sleep(20); assert.equal(escape.shutdowns(), 1);
  } finally { resume(); await escape.close(); }
});

test("startup identity: switching sessions or manually resuming without launch flags never grants automatic exit", async () => {
  state(); const r = await runtime(true);
  try { const original = r.session.sessionManager.getSessionFile(); r.session.sessionManager.newSession(); assert.notEqual(r.session.sessionManager.getSessionFile(), original); r.faux.setResponses([fauxAssistantMessage("different session")]); await r.session.prompt("task"); await sleep(20); assert.equal(r.shutdowns(), 0); }
  finally { await r.close(); }
  const manager = spawnerSession(); manager.appendMessage(fauxAssistantMessage("previous"));
  const manual = await runtime(false, undefined, manager);
  try { manual.faux.setResponses([fauxAssistantMessage("manual resume")]); await manual.session.prompt("task"); await sleep(20); assert.equal(manual.shutdowns(), 0); }
  finally { await manual.close(); }
});

test("write failure or reload cancels automatic exit and never retries a failed board write", async () => {
  state(); const r = await runtime(true);
  try { r.faux.setResponses([fauxAssistantMessage("done")]); await r.session.prompt("task"); await r.close(); await sleep(20); assert.equal(r.shutdowns(), 0); assert.equal((await readBoard(r.board)).length, 0); }
  finally { r.session.dispose(); }
  const failed = await runtime(true);
  try {
    const cwd = failed.session.sessionManager.getCwd();
    writeFileSync(join(cwd, ".pi"), "not a directory"); failed.faux.setResponses([fauxAssistantMessage("result")]); await failed.session.prompt("task"); await sleep(30);
    assert.equal(failed.shutdowns(), 0); assert.ok(failed.notices.some(n => n.includes(failed.board))); rmSync(join(cwd, ".pi")); await sleep(30); assert.equal(existsSync(failed.board), false);
  } finally { await failed.close(); }
});

test("session supervision: lost names and same-name replacement do not hide the old session; blocked is edge-triggered", async () => {
  const spawner = spawnerSession(); const run = peerRun("lost", spawner);
  state([live(run, "blocked", "renamed"), { ...live(run), pane_id: "w1:p20", agent_session: { kind: "path", value: "/different.jsonl" } }]);
  const r = await runtime(false, undefined, spawner);
  try {
    await sleep(2300); assert.equal(count(), 1); assert.equal(spawner.getBranch().filter(e => e.type === "custom_message" && e.customType === "swarm_notice").length, 1); assert.equal(results(spawner).length, 0);
    state([{ agent: "pi", pane_id: "w1:p30", agent_status: "idle" }]); await sleep(1200); assert.equal(count(), 1);
  } finally { await r.close(); }
  const restored = await runtime(false, undefined, readSession(spawner.getSessionFile()!));
  try { assert.equal(count(), 1); restored.faux.setResponses([fauxAssistantMessage("processed")]); state([{ ...live(run), agent_session: { kind: "path", value: "/different-session.jsonl" } }]); await sleep(2300); assert.equal(count(), 0); assert.equal(results(restored.session.sessionManager).length, 1);
    const manager = restored.session.sessionManager; const spawn = manager.getEntries().find(e => e.type === "custom" && e.customType === "swarm_spawn")!;
    manager.branch(spawn.id); manager.appendMessage(fauxAssistantMessage("another branch")); await sleep(2200);
    assert.equal(manager.getEntries().filter(e => e.type === "custom_message" && e.customType === "swarm_result").length, 1);
  }
  finally { await restored.close(); }
});

test("user cancellation: busy result survives Escape once and remains pending until a subsequent completed reply", async () => {
  const spawner = spawnerSession(); const run = peerRun("peer", spawner); state([live(run)]);
  const r = await runtime(true, undefined, spawner);
  try {
    r.faux.setResponses([async (_c, options) => { await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true })); return fauxAssistantMessage("interrupted"); }, fauxAssistantMessage("continued")]);
    const busy = r.session.prompt("busy"); await sleep(20); state(); await sleep(1200);
    assert.equal(count(), 1); r.type("\x1b"); r.session.clearQueue(); await r.session.abort(); await busy;
    assert.equal(r.shutdowns(), 0); assert.equal(results(spawner).length, 1); assert.equal(count(), 1);
    await r.session.prompt("continue"); await sleep(20); assert.equal(count(), 0); assert.equal(r.shutdowns(), 1); assert.equal(results(spawner).length, 1);
  } finally { await r.close(); }
});

test("result and exit: a slow settled handler spans several polls; one result, no stale exit, live zero after processing", async () => {
  const spawner = spawnerSession(); const run = peerRun("peer", spawner); state([live(run)]);
  let release!: () => void; let entered!: () => void; let once = true;
  const hold = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
  let atSettled = -1;
  const r = await runtime(true, pi => { pi.on("agent_settled", async () => { if (once) { once = false; entered(); await hold; } else atSettled = count(); }); }, spawner);
  try {
    r.faux.setResponses([fauxAssistantMessage("old candidate"), fauxAssistantMessage("fresh response")]); const task = r.session.prompt("wait"); await started; state(); await sleep(3300);
    assert.equal(results(spawner).length, 1); assert.equal(count(), 1); assert.equal(r.shutdowns(), 0); assert.equal((await readBoard(r.board)).length, 0);
    release(); await task; await sleep(30); assert.equal(results(spawner).length, 1); assert.equal(atSettled, 0); assert.equal(count(), 0); assert.equal(r.shutdowns(), 1); assert.equal((await readBoard(r.board))[0].message, "fresh response");
  } finally { release(); await r.close(); }
});

test("read-only session boundaries never reuse old, abandoned, empty or corrupt replies; pending ignores raw headers", () => {
  const manager = SessionManager.create(dir, mkdtempSync(join(dir, "branch-")));
  manager.appendMessage({ role: "user", content: "one", timestamp: Date.now() }); manager.appendMessage(fauxAssistantMessage("old")); const boundary = manager.getLeafId()!;
  manager.appendMessage({ role: "user", content: "two", timestamp: Date.now() }); assert.equal(lastReply(manager, boundary), undefined);
  manager.appendMessage(fauxAssistantMessage("abandoned")); manager.branch(boundary);
  manager.appendMessage({ role: "user", content: "alternate", timestamp: Date.now() }); manager.appendMessage(fauxAssistantMessage("new"));
  const file = manager.getSessionFile()!; const before = readFileSync(file, "utf8");
  assert.equal(readResult({ name: "peer", session: file, boundary }).text, "new"); assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(readResult({ name: "peer", session: file, boundary: manager.getLeafId() }).status, "empty");
  manager.appendMessage(fauxAssistantMessage("", { stopReason: "error", errorMessage: "quota" })); assert.equal(readResult({ name: "peer", session: file, boundary }).status, "error");
  manager.resetLeaf(); manager.appendMessage({ role: "user", content: "other root", timestamp: Date.now() }); manager.appendMessage(fauxAssistantMessage("do not reuse"));
  assert.equal(readResult({ name: "peer", session: file, boundary }).status, "unreadable");
  assert.equal(readResult({ name: "peer", session: join(dir, "missing"), boundary: null }).status, "unreadable");
  writeFileSync(file, "{broken"); assert.equal(readResult({ name: "peer", session: file, boundary }).status, "unreadable");
  const spawner = spawnerSession(); const run = peerRun("peer", spawner); const id = spawner.getLeafId()!;
  spawner.appendMessage({ role: "user", content: "[swarm result] peer done", timestamp: Date.now() }); assert.equal(pendingRuns(spawner).size, 1);
  spawner.appendCustomMessageEntry("swarm_result", "actual", true, { name: run.name, session: run.session, spawnEntryId: id }); assert.equal(pendingRuns(spawner).size, 0); assert.equal(pendingRuns(spawner, true).size, 1);
  spawner.appendMessage(fauxAssistantMessage("interrupted", { stopReason: "aborted" })); assert.equal(pendingRuns(spawner, true).size, 1);
  spawner.appendMessage(fauxAssistantMessage("processed")); assert.equal(pendingRuns(spawner, true).size, 0);
});
