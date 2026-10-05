import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import swarm, { PENDING_COUNT_KEY } from "../src/index.ts";
import { readSession, readResult, lastReply, wasAborted, pendingRuns, type Run } from "../src/run.ts";

const dir = mkdtempSync(join(tmpdir(), "swarm-runtime-"));
Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", HERDR_BIN_PATH: resolve("test/fake-herdr.cjs"), FAKE_HERDR_DIR: dir });
const originalKeys = getKeybindings();
setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.interrupt": { defaultKeys: "escape", description: "Interrupt" } }));
const state = (agents: any[] = []) => { writeFileSync(join(dir, "state.json"), JSON.stringify({ agents })); writeFileSync(join(dir, "calls.jsonl"), ""); };
after(() => { setKeybindings(originalKeys); rmSync(dir, { recursive: true, force: true }); });
async function runtime(auto = false, extra?: ExtensionFactory, manager?: SessionManager, flags: Record<string, string> = {}) {
  const caseDir = mkdtempSync(join(dir, "case-")); const cwd = manager?.getCwd() || caseDir;
  const sessionManager = manager || SessionManager.create(cwd, caseDir);
  const faux = fauxProvider({ provider: "swarm-test", models: [{ id: "test-model", reasoning: false }] });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: caseDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => pi.registerProvider(faux.provider), swarm, ...(extra ? [extra] : [])] });
  await loader.reload();
  if (auto) for (const [name, value] of Object.entries({ "swarm-name": "worker", "swarm-spawner": "spawner", "swarm-session": sessionManager.getSessionFile()! })) loader.getExtensions().runtime.flagValues.set(name, value);
  for (const [name, value] of Object.entries(flags)) loader.getExtensions().runtime.flagValues.set(name, value);
  const modelRuntime = await ModelRuntime.create({ authPath: join(caseDir, "auth.json"), modelsPath: join(caseDir, "models.json") });
  const { session } = await createAgentSession({ cwd, agentDir: caseDir, model: faux.getModel(), thinkingLevel: "xhigh", modelRuntime, resourceLoader: loader, settingsManager, sessionManager });
  let shutdowns = 0; let editor = ""; let terminalInput: ((data: string) => unknown) | undefined; let widget: any;
  const errors: string[] = []; const notices: string[] = [];
  await session.bindExtensions({ mode: "tui", shutdownHandler: () => { shutdowns++; }, onError: e => errors.push(e.error),
    uiContext: { setWidget: (_key: string, factory: any) => { widget = factory; }, setStatus() {}, getEditorText: () => editor, notify: (message: string) => notices.push(message), onTerminalInput: (handler: typeof terminalInput) => { terminalInput = handler; return () => { terminalInput = undefined; }; } } as any });
  return { session, faux, errors, notices, draft: (text: string) => { editor = text; }, type: (data: string) => terminalInput?.(data), shutdowns: () => shutdowns,
    waiting: () => widget ? widget(undefined, { fg: (_c: string, text: string) => text }).render(200)[0] : "",
    close: async () => { await session.extensionRunner!.emit({ type: "session_shutdown", reason: "reload" }); session.dispose(); } };
}
const count = () => (globalThis as any)[PENDING_COUNT_KEY]?.() ?? 0;
const results = (s: SessionManager) => s.getBranch().filter(e => e.type === "custom_message" && e.customType === "swarm_result");
function spawnerSession() { const cwd = mkdtempSync(join(dir, "spawner-")); const m = SessionManager.create(cwd, cwd); m.appendMessage({ role: "user", content: "start", timestamp: Date.now() }); return m; }
function peerRun(name: string, spawner: SessionManager): Run {
  const m = SessionManager.create(spawner.getCwd(), mkdtempSync(join(dir, "peer-")));
  m.appendMessage({ role: "user", content: "task", timestamp: Date.now() }); m.appendMessage(fauxAssistantMessage(`${name} final`));
  const run: Run = { name, session: m.getSessionFile()!, pane: "w1:p9", boundary: null, snapshot: { cwd: spawner.getCwd(), model: "swarm-test/test-model", thinking: "off" } };
  spawner.appendCustomEntry("swarm_spawn", run); return run;
}
const live = (run: Run, status = "working", name: string | undefined = run.name) => ({ name, pane_id: "w1:p19", agent: "pi", agent_status: status, agent_session: { kind: "path", value: run.session } });

test("exit: settled completion shuts down; manual, error and interrupted outcomes", async () => {
  for (const [auto, reply, expected] of [[false, fauxAssistantMessage("manual"), 0], [true, fauxAssistantMessage("final reply"), 1], [true, fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" }), 1], [true, fauxAssistantMessage("stopped", { stopReason: "aborted" }), 0]] as const) {
    state(); const r = await runtime(auto);
    try {
      assert.equal(r.session.thinkingLevel, "off"); assert.ok(r.session.getActiveToolNames().includes("swarm_spawn"));
      r.faux.setResponses([reply]); await r.session.prompt("task"); await sleep(20); assert.equal(r.shutdowns(), expected);
      assert.equal(existsSync(join(r.session.sessionManager.getCwd(), ".pi/swarm")), false, "completion creates no shared storage");
      assert.equal(readFileSync(join(dir, "calls.jsonl"), "utf8"), ""); assert.deepEqual(r.errors, []);
    } finally { await r.close(); }
  }
});

test("a real codemode monitor sends changes while keeping the peer alive until stopped", async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const r = await runtime(true, pi => { createCodemodeExtension()(pi); pi.on("tool_execution_start", event => { if (event.toolName === "bash") entered(); }); }, undefined, { "swarm-tools": "codemode" });
  const cwd = r.session.sessionManager.getCwd(); const stop = join(cwd, "stop"); const status = join(cwd, "status");
  state([{ name: "worker", pane_id: "w1:p1", agent: "pi", cwd }, { name: "spawner", pane_id: "w1:p2", agent: "pi", cwd }]);
  writeFileSync(status, "ready");
  const script = `let previous = "ready"; while (true) {
    const sample = await tools.bash({command: ${JSON.stringify(`sleep 0.05; if [ -f '${stop}' ]; then echo STOP; else cat '${status}'; fi`)}});
    const current = sample.output.trim(); if (current === "STOP") break;
    if (current !== previous) { await tools.swarm_send({to: "spawner", message: current}); previous = current; }
  } text("monitoring stopped");`;
  r.faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", { code: script })), fauxAssistantMessage("monitoring stopped")]);
  const task = r.session.prompt("monitor until stopped");
  try {
    assert.ok(r.session.getActiveToolNames().includes("codemode"));
    await Promise.race([started, task.then(() => { throw new Error("codemode ended before monitoring started"); })]);
    for (const change of ["degraded", "recovered"]) {
      writeFileSync(status, change);
      const notified = () => readFileSync(join(dir, "calls.jsonl"), "utf8").includes(`\\n${change}`);
      for (let n = 0; n < 100 && !notified(); n++) await sleep(10);
      assert.ok(notified()); assert.equal(r.session.isIdle, false); assert.equal(r.shutdowns(), 0);
    }
    await sleep(100);
    assert.equal(readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(line => line.includes('"prompt"')).length, 2, "unchanged state sends no repeat");
    writeFileSync(stop, "stop"); await task; await sleep(20);
    assert.equal(r.shutdowns(), 1); assert.deepEqual(r.errors, []);
  } finally { writeFileSync(stop, "stop"); await task; await r.close(); }
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
    release(); await first; await sleep(20); assert.equal(r.shutdowns(), 1); assert.equal(lastReply(r.session.sessionManager, null)?.content[0].type === "text" && (lastReply(r.session.sessionManager, null)!.content[0] as any).text, "new");
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

test("reload before the exit tick cancels automatic exit", async () => {
  state(); const r = await runtime(true);
  try { r.faux.setResponses([fauxAssistantMessage("done")]); await r.session.prompt("task"); await r.close(); await sleep(20); assert.equal(r.shutdowns(), 0); }
  finally { r.session.dispose(); }
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

test("busy result reaches the next tool boundary without a finished notice", async () => {
  const spawner = spawnerSession(); const run = peerRun("peer", spawner); state([live(run)]);
  const r = await runtime(false, undefined, spawner);
  let release!: () => void; let entered!: () => void; let nextContext = "";
  const hold = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    r.faux.setResponses([async () => { entered(); await hold; return fauxAssistantMessage(fauxToolCall("swarm_list", {})); },
      context => { nextContext = JSON.stringify(context); return fauxAssistantMessage("processed"); }]);
    const busy = r.session.prompt("busy"); await started; state(); await sleep(1200);
    assert.equal(count(), 1); assert.equal(r.waiting(), "");
    release(); await busy;
    assert.match(nextContext, /\[swarm result\]/); assert.match(nextContext, /peer final/);
    assert.equal(results(spawner).length, 1); assert.equal(count(), 0);
    assert.equal(spawner.getEntries().some(e => e.type === "custom_message" && e.customType === "swarm_notice"), false);
    assert.deepEqual(r.errors, []);
  } finally { release(); await r.close(); }
});

test("user cancellation: busy result survives Escape once and remains pending until a subsequent completed reply", async () => {
  const spawner = spawnerSession(); const run = peerRun("peer", spawner); state([live(run)]);
  const r = await runtime(true, undefined, spawner);
  try {
    r.faux.setResponses([async (_c, options) => { await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true })); return fauxAssistantMessage("interrupted"); }, fauxAssistantMessage("continued")]);
    const busy = r.session.prompt("busy"); await sleep(20); state(); await sleep(1200);
    assert.equal(count(), 1); assert.equal(r.waiting(), ""); // the result is queued, not yet processed
    r.type("\x1b"); r.session.clearQueue(); await r.session.abort(); await busy;
    assert.equal(r.shutdowns(), 0); assert.equal(results(spawner).length, 1); assert.equal(count(), 1);
    await r.session.prompt("continue"); await sleep(20); assert.equal(count(), 0); assert.equal(r.shutdowns(), 1); assert.equal(results(spawner).length, 1);
    assert.deepEqual(r.errors, []);
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
    assert.equal(results(spawner).length, 0); assert.equal(count(), 1); assert.equal(r.shutdowns(), 0);
    release(); await task; await sleep(30); assert.equal(results(spawner).length, 1); assert.equal(atSettled, 0); assert.equal(count(), 0); assert.equal(r.shutdowns(), 1);
  } finally { release(); await r.close(); }
});

test("restoring the steering queue without aborting cannot lose a peer result", async () => {
  const spawner = spawnerSession(); const run = peerRun("peer", spawner); state([live(run)]);
  const r = await runtime(false, undefined, spawner);
  let release!: () => void; let entered!: () => void; let nextContext = "";
  const hold = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    r.faux.setResponses([async () => { entered(); await hold; return fauxAssistantMessage("current task finished"); },
      context => { nextContext = JSON.stringify(context); return fauxAssistantMessage("processed"); }]);
    const task = r.session.prompt("busy"); await started; state(); await sleep(1200);
    r.session.clearQueue(); // Alt+Up restores the queues without aborting the current request.
    release(); await task;
    assert.equal(results(spawner).length, 1); assert.match(nextContext, /peer final/);
    assert.equal(count(), 0); assert.deepEqual(r.errors, []);
  } finally { release(); await r.close(); }
});

test("Escape during a slow before-settle preserves a late result without waking the cancelled task", async () => {
  const spawner = spawnerSession(); const run = peerRun("peer", spawner); state([live(run)]);
  let release!: () => void; let entered!: () => void; let once = true;
  const hold = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const r = await runtime(true, pi => { pi.on("agent_before_settle", async () => { if (once) { once = false; entered(); await hold; } }); }, spawner);
  try {
    r.faux.setResponses([fauxAssistantMessage("current task finished"), fauxAssistantMessage("processed")]);
    const task = r.session.prompt("busy"); await started; state(); await sleep(1200);
    r.type("\x1b"); r.session.clearQueue(); const abort = r.session.abort(); release(); await Promise.all([task, abort]);
    assert.equal(results(spawner).length, 1); assert.equal(count(), 1); assert.equal(r.shutdowns(), 0);
    await r.session.prompt("continue"); await sleep(20);
    assert.equal(results(spawner).length, 1); assert.equal(count(), 0); assert.equal(r.shutdowns(), 1); assert.deepEqual(r.errors, []);
  } finally { release(); await r.close(); }
});

test("two completed peers survive a provider error and recovery without duplicate results", async () => {
  const spawner = spawnerSession(); const first = peerRun("first", spawner); const second = peerRun("second", spawner); state([live(first), { ...live(second), pane_id: "w1:p20" }]);
  const r = await runtime(false, undefined, spawner);
  let release!: () => void; let entered!: () => void; let nextContext = "";
  const hold = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    r.faux.setResponses([async () => { entered(); await hold; return fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" }); },
      context => { nextContext = JSON.stringify(context); return fauxAssistantMessage("recovered"); }]);
    const task = r.session.prompt("busy"); await started; state(); await sleep(1200); release(); await task;
    assert.equal(results(spawner).length, 2); assert.equal(count(), 2);
    await r.session.prompt("continue");
    assert.equal(results(spawner).length, 2); assert.equal(new Set(results(spawner).map(e => (e as any).details.spawnEntryId)).size, 2);
    assert.match(nextContext, /first final/); assert.match(nextContext, /second final/); assert.equal(count(), 0); assert.deepEqual(r.errors, []);
  } finally { release(); await r.close(); }
});

test("late settled results are delivered as one batch with one follow-up reply", async () => {
  const spawner = spawnerSession(); const first = peerRun("first", spawner); const second = peerRun("second", spawner); state([live(first), { ...live(second), pane_id: "w1:p20" }]);
  let entered!: () => void; let release!: () => void; let once = true; let nextContext = "";
  const started = new Promise<void>(resolve => { entered = resolve; }); const hold = new Promise<void>(resolve => { release = resolve; });
  const r = await runtime(false, pi => { pi.on("agent_before_settle", async () => { if (once) { once = false; entered(); await hold; } }); }, spawner);
  try {
    r.faux.setResponses([fauxAssistantMessage("current task finished"), context => { nextContext = JSON.stringify(context); return fauxAssistantMessage("processed batch"); }, fauxAssistantMessage("unexpected extra reply")]);
    const task = r.session.prompt("busy"); await started; state(); await sleep(1200); release(); await task;
    assert.equal(results(spawner).length, 2); assert.equal(r.faux.state.callCount, 2);
    assert.match(nextContext, /first final/); assert.match(nextContext, /second final/); assert.equal(count(), 0); assert.deepEqual(r.errors, []);
  } finally { release(); await r.close(); }
});

for (const navigate of [false, true]) test(navigate ? "Escape plus tree navigation cannot restart a deferred result wake" : "Escape after a deferred result wake prevents replies and side effects, but not the next user task", async () => {
  const spawner = spawnerSession(); spawner.appendMessage(fauxAssistantMessage("before delegation")); const beforeDelegation = spawner.getLeafId()!;
  const run = peerRun("peer", spawner); state([live(run)]);
  let before!: () => void; let settle!: () => void; let releaseBefore!: () => void; let releaseSettled!: () => void; let firstBefore = true; let firstSettled = true;
  const beforeStarted = new Promise<void>(resolve => { before = resolve; }); const settledStarted = new Promise<void>(resolve => { settle = resolve; });
  const beforeHold = new Promise<void>(resolve => { releaseBefore = resolve; }); const settledHold = new Promise<void>(resolve => { releaseSettled = resolve; });
  const r = await runtime(true, pi => {
    pi.on("agent_before_settle", async () => { if (firstBefore) { firstBefore = false; before(); await beforeHold; } });
    pi.on("agent_settled", async () => { if (firstSettled) { firstSettled = false; settle(); await settledHold; } });
  }, spawner);
  const sideEffect = join(spawner.getCwd(), "unwanted-write"); let wakeAborted = false;
  try {
    r.faux.setResponses([fauxAssistantMessage("current task finished"), (_context, options) => {
      wakeAborted = options?.signal?.aborted === true;
      return fauxAssistantMessage(fauxToolCall("write", { path: sideEffect, content: "should not run" }));
    }, fauxAssistantMessage("processed by user request")]);
    const task = r.session.prompt("busy"); await beforeStarted; state(); await sleep(1200); releaseBefore(); await settledStarted;
    r.type("\x1b"); r.session.clearQueue(); const abort = r.session.abort();
    if (navigate) await r.session.navigateTree(beforeDelegation, { summarize: false });
    releaseSettled(); await Promise.all([task, abort]);
    assert.ok(r.faux.state.callCount === 1 || wakeAborted, "the cancelled wake must not reach a provider with a live signal"); assert.equal(existsSync(sideEffect), false);
    assert.ok(wasAborted(lastReply(spawner, null))); assert.equal(results(spawner).length, 1); assert.equal(count(), navigate ? 0 : 1); assert.equal(r.shutdowns(), 0);
    r.faux.setResponses([fauxAssistantMessage("processed by user request")]);
    await r.session.prompt("continue"); await sleep(20);
    assert.equal(lastReply(spawner, null)?.stopReason, "stop"); assert.equal(results(spawner).length, 1); assert.equal(count(), 0); assert.equal(r.shutdowns(), 1); assert.deepEqual(r.errors, []);
  } finally { releaseBefore(); releaseSettled(); await r.close(); }
});

for (const interrupt of [false, true]) test(interrupt ? "idle reload cannot clear cancellation of a deferred result wake" : "idle reload during a deferred result wake preserves one handoff and one archive", async () => {
  const spawner = spawnerSession(); const run = peerRun("peer", spawner); state([live(run)]);
  let before!: () => void; let settle!: () => void; let releaseBefore!: () => void; let releaseSettled!: () => void; let firstBefore = true; let firstSettled = true;
  const beforeStarted = new Promise<void>(resolve => { before = resolve; }); const settledStarted = new Promise<void>(resolve => { settle = resolve; });
  const beforeHold = new Promise<void>(resolve => { releaseBefore = resolve; }); const settledHold = new Promise<void>(resolve => { releaseSettled = resolve; });
  const r = await runtime(false, pi => {
    pi.on("agent_before_settle", async () => { if (firstBefore) { firstBefore = false; before(); await beforeHold; } });
    pi.on("agent_settled", async () => { if (firstSettled) { firstSettled = false; settle(); await settledHold; } });
  }, spawner);
  try {
    r.faux.setResponses([fauxAssistantMessage("current task finished"), fauxAssistantMessage("processed result"), fauxAssistantMessage("unexpected duplicate reply")]);
    const task = r.session.prompt("busy"); await beforeStarted; state(); await sleep(1200); releaseBefore(); await settledStarted;
    assert.equal(r.session.isIdle, true);
    if (interrupt) { r.type("\x1b"); await r.session.abort(); }
    await r.session.reload(); await sleep(1250); releaseSettled(); await task;
    assert.equal(results(spawner).length, 1); assert.equal(r.faux.state.callCount, interrupt ? 1 : 2);
    assert.equal(count(), interrupt ? 1 : 0); assert.deepEqual(r.errors, []);
    if (interrupt) {
      assert.ok(wasAborted(lastReply(spawner, null)));
      r.faux.setResponses([fauxAssistantMessage("processed by user request")]); await r.session.prompt("continue"); assert.equal(count(), 0);
    }
  } finally { releaseBefore(); releaseSettled(); await r.close(); }
});

test("manual compaction retains a collected result and idle polling delivers it even if herdr then fails", async () => {
  const spawner = spawnerSession();
  for (let n = 0; n < 5; n++) {
    spawner.appendMessage({ role: "user", content: "old task ".repeat(3000), timestamp: Date.now() });
    spawner.appendMessage(fauxAssistantMessage("old reply ".repeat(3000)));
  }
  const run = peerRun("peer", spawner); state([live(run)]);
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const hold = new Promise<void>(resolve => { release = resolve; });
  const r = await runtime(false, pi => { pi.on("session_before_compact", async event => {
    entered(); await hold;
    return { compaction: { summary: "old tasks summarized", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
  }); }, spawner);
  try {
    r.faux.setResponses([fauxAssistantMessage("processed")]);
    const compact = r.session.compact(); await started; assert.equal(r.session.isIdle, false);
    state(); await sleep(1200); assert.equal(results(spawner).length, 0);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ agents: [], listError: true }));
    release(); await compact; await sleep(1250); await r.session.waitForIdle();
    assert.equal(results(spawner).length, 1); assert.equal(count(), 0); assert.deepEqual(r.errors, []);
  } finally { release(); await r.close(); }
});

test("tree summary does not deliver a cached result into an abandoned branch", async () => {
  const spawner = spawnerSession(); spawner.appendMessage(fauxAssistantMessage("before delegation")); const before = spawner.getLeafId()!;
  spawner.appendMessage({ role: "user", content: "old branch task", timestamp: Date.now() }); spawner.appendMessage(fauxAssistantMessage("old branch reply"));
  const run = peerRun("peer", spawner); const spawn = spawner.getLeafId()!; state([live(run)]);
  const r = await runtime(false, undefined, spawner);
  let entered!: () => void; let release!: () => void; let nextContext = "";
  const started = new Promise<void>(resolve => { entered = resolve; }); const hold = new Promise<void>(resolve => { release = resolve; });
  try {
    r.faux.setResponses([async () => { entered(); await hold; return fauxAssistantMessage("old branch summarized"); },
      context => { nextContext = JSON.stringify(context); return fauxAssistantMessage("new branch reply"); }, fauxAssistantMessage("processed peer result")]);
    const navigation = r.session.navigateTree(before, { summarize: true }); await started; assert.equal(r.session.isIdle, false);
    state(); await sleep(1200); release(); await navigation; await sleep(1250);
    assert.equal(results(spawner).length, 0); assert.equal(count(), 0);
    await r.session.prompt("continue on new branch"); assert.doesNotMatch(nextContext, /peer final/);
    await r.session.navigateTree(spawn, { summarize: false }); await sleep(1250); await r.session.waitForIdle();
    assert.equal(results(spawner).length, 1); assert.equal(count(), 0); assert.deepEqual(r.errors, []);
  } finally { release(); await r.close(); }
});

test("a replaced boundary draft is proposed again without dropping another extension's entries", async () => {
  const spawner = spawnerSession(); const run = peerRun("peer", spawner); state([live(run)]);
  let release!: () => void; let entered!: () => void; let once = true; let nextContext = "";
  const hold = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const r = await runtime(false, pi => { pi.on("turn_end", event => {
    if (once && event.entries.some(entry => entry.type === "custom_message" && entry.customType === "swarm_result")) {
      once = false;
      return { entries: [{ type: "custom_message", customType: "other", content: "another extension's entry", display: true }], continue: false };
    }
  }); }, spawner);
  try {
    r.faux.setResponses([async () => { entered(); await hold; return fauxAssistantMessage("current task finished"); },
      context => { nextContext = JSON.stringify(context); return fauxAssistantMessage("processed"); }]);
    const task = r.session.prompt("busy"); await started; state(); await sleep(1200); release(); await task;
    assert.equal(results(spawner).length, 1); assert.match(nextContext, /peer final/); assert.match(nextContext, /another extension's entry/);
    assert.equal(count(), 0); assert.deepEqual(r.errors, []);
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
  manager.appendMessage(fauxAssistantMessage("checking", { stopReason: "toolUse" })); assert.equal(readResult({ name: "peer", session: file, boundary }).status, "incomplete", "ended mid-tool is not a final reply");
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
  // Navigating to a branch that holds the spawn but not its result must not wait forever.
  spawner.branch(id); spawner.appendMessage({ role: "user", content: "another path", timestamp: Date.now() });
  assert.equal(pendingRuns(spawner).size, 0); assert.equal(pendingRuns(spawner, true).size, 0);
});

test("--swarm-agent starts a session as a preset: its model, thinking and role", async () => {
  const agents = mkdtempSync(join(dir, "agent-dir-")); const previous = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(join(agents, "agents")); process.env.PI_CODING_AGENT_DIR = agents;
  writeFileSync(join(agents, "agents", "executor.md"), "---\nname: executor\nmodel: swarm-test/test-model\nthinking: low\n---\nYou alone write the account.");
  const r = await runtime(false, undefined, undefined, { "swarm-agent": "executor" });
  try {
    let prompt = "";
    r.faux.setResponses([async (context: any) => { prompt = JSON.stringify(context); return fauxAssistantMessage("ok"); }]);
    await r.session.prompt("hello");
    assert.equal(r.session.model?.id, "test-model"); assert.equal(r.session.thinkingLevel, "off"); // clamped: the faux model does not reason
    assert.match(prompt, /You alone write the account\./); assert.deepEqual(r.errors, []);
    await sleep(200); // let session_start work (integration check) settle before the session closes
  } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await r.close(); }
});
