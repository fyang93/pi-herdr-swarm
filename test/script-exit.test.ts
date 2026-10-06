import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory, type SessionStartEvent, type SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import swarm, { PENDING_COUNT_KEY } from "../src/index.ts";
import { waitingForReply, type Run } from "../src/run.ts";

const dir = mkdtempSync(join(tmpdir(), "swarm-script-exit-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = join(dir, "presets");
mkdirSync(join(agentDir, "agents"), { recursive: true });
writeFileSync(join(agentDir, "agents", "executor.md"), "---\nname: executor\nmodel: swarm-test/test-model\nthinking: off\n---\nYou execute the standalone task.");
Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", HERDR_BIN_PATH: resolve("test/fake-herdr.cjs"), FAKE_HERDR_DIR: dir });
const originalKeys = getKeybindings();
setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.interrupt": { defaultKeys: "escape", description: "Interrupt" } }));
after(() => {
  setKeybindings(originalKeys);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(dir, { recursive: true, force: true });
});
const state = (agents: any[] = []) => {
  writeFileSync(join(dir, "state.json"), JSON.stringify({ agents }));
  writeFileSync(join(dir, "calls.jsonl"), "");
};
const addressed = () => state([{ name: "worker", pane_id: "w1:p1", agent: "pi", cwd: dir }, { name: "peer", pane_id: "w1:p2", agent: "pi", cwd: dir }]);
const reply = (from = "peer") => `[swarm message] ${from} → worker\nUse option B.`;
const waitCall = () => fauxAssistantMessage(fauxToolCall("swarm_send", { to: "peer", message: "Which option?", wait: true }));
const pending = () => (globalThis as any)[PENDING_COUNT_KEY]?.() ?? 0;
async function until(check: () => boolean) {
  for (let n = 0; n < 300 && !check(); n++) await sleep(10);
  assert.ok(check(), "expected lifecycle state within three seconds");
}
// Same faux SDK runtime as regressions.test.ts; shutdown is counted, never an actual pane close.
async function runtime(flags: Record<string, string | boolean> = { "swarm-agent": "executor", "swarm-exit": true }, manager?: SessionManager, extra?: ExtensionFactory, internal = false, sessionStartEvent?: SessionStartEvent) {
  const caseDir = mkdtempSync(join(dir, "case-")); const cwd = manager?.getCwd() || caseDir;
  const sessionManager = manager || SessionManager.create(cwd, caseDir);
  const faux = fauxProvider({ provider: "swarm-test", models: [{ id: "test-model", reasoning: false }] });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: caseDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => pi.registerProvider(faux.provider), swarm, ...(extra ? [extra] : [])] });
  await loader.reload();
  for (const [name, value] of Object.entries(flags)) loader.getExtensions().runtime.flagValues.set(name, value);
  if (internal) for (const [name, value] of Object.entries({ "swarm-name": "worker", "swarm-spawner": "spawner", "swarm-session": sessionManager.getSessionFile()! })) loader.getExtensions().runtime.flagValues.set(name, value);
  const modelRuntime = await ModelRuntime.create({ authPath: join(caseDir, "auth.json"), modelsPath: join(caseDir, "models.json") });
  const { session } = await createAgentSession({ cwd, agentDir: caseDir, model: faux.getModel(), modelRuntime, resourceLoader: loader, settingsManager, sessionManager, sessionStartEvent });
  let shutdowns = 0; let editor = ""; let terminalInput: ((data: string) => unknown) | undefined;
  const errors: string[] = [];
  await session.bindExtensions({ mode: "tui", shutdownHandler: () => { shutdowns++; }, onError: e => errors.push(e.error),
    uiContext: { setWidget() {}, setStatus() {}, getEditorText: () => editor, notify() {}, onTerminalInput: (handler: typeof terminalInput) => { terminalInput = handler; return () => { terminalInput = undefined; }; } } as any });
  return { session, faux, errors, loader, draft: (text: string) => { editor = text; }, type: (data: string) => terminalInput?.(data), shutdowns: () => shutdowns,
    close: async (reason: SessionShutdownEvent["reason"] = "reload") => { await session.extensionRunner!.emit({ type: "session_shutdown", reason }); session.dispose(); } };
}
function forgetProcessState() {
  // A fresh process reconstructs waiting from its session, not extension globals.
  for (const key of Object.getOwnPropertySymbols(globalThis)) if (Symbol.keyFor(key)?.startsWith("pi-herdr-swarm/")) delete (globalThis as any)[key];
}

for (const outcome of ["stop", "error", "aborted"] as const) test(`standalone --swarm-exit: ${outcome} outcome`, async () => {
  state(); const r = await runtime(); let context = "";
  try {
    const registered = r.loader.getExtensions().extensions.flatMap(e => [...e.flags.values()]).find(f => f.name === "swarm-exit");
    assert.equal(registered?.type, "boolean");
    r.faux.setResponses([c => { context = JSON.stringify(c); return fauxAssistantMessage(outcome === "stop" ? "complete" : "", { stopReason: outcome, ...(outcome === "error" ? { errorMessage: "provider unavailable" } : {}) }); }]);
    await r.session.prompt("initial task"); await sleep(30);
    assert.equal(r.shutdowns(), outcome === "aborted" ? 0 : 1, "initial user prompt is not human takeover");
    assert.match(context, /You execute the standalone task/);
    assert.doesNotMatch(context, /spawned by|last reply is delivered to/);
    assert.equal(readFileSync(join(dir, "calls.jsonl"), "utf8"), "", "fake shutdown must not close a pane");
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

for (const flags of [{ "swarm-agent": "executor" }, { "swarm-agent": "executor", "swarm-exit": false }, {}] as Record<string, string | boolean>[]) test(`interactive session does not exit: ${JSON.stringify(flags)}`, async () => {
  state(); const r = await runtime(flags);
  try {
    r.faux.setResponses([fauxAssistantMessage("complete"), fauxAssistantMessage("follow-up")]);
    await r.session.prompt("initial task"); await sleep(30); assert.equal(r.shutdowns(), 0);
    await r.session.prompt("another human task"); await sleep(30); assert.equal(r.shutdowns(), 0);
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("--swarm-exit is generic: no preset or internal launch flags required", async () => {
  state(); const r = await runtime({ "swarm-exit": true });
  try { r.faux.setResponses([fauxAssistantMessage("complete")]); await r.session.prompt("initial task"); await sleep(30); assert.equal(r.shutdowns(), 1); assert.deepEqual(r.errors, []); }
  finally { await r.close(); }
});

test("wait:true prevents exit, survives disk restart, and addressed swarm replies do not take over", async () => {
  addressed(); const r = await runtime(); let file = "";
  try {
    r.faux.setResponses([waitCall(), fauxAssistantMessage("must not continue")]);
    await r.session.prompt("initial task"); await sleep(30);
    assert.equal(r.faux.state.callCount, 1); assert.equal(r.shutdowns(), 0); assert.deepEqual(waitingForReply(r.session.sessionManager), ["peer"]);
    file = r.session.sessionManager.getSessionFile()!; r.session.clearQueue();
    await r.session.reload(); await sleep(30);
    assert.deepEqual(waitingForReply(r.session.sessionManager), ["peer"]); assert.equal(r.shutdowns(), 0); assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
  forgetProcessState(); const restored = await runtime(undefined, SessionManager.open(file));
  try {
    await sleep(30); assert.equal(restored.shutdowns(), 0); assert.deepEqual(waitingForReply(restored.session.sessionManager), ["peer"]);
    restored.faux.setResponses([fauxAssistantMessage("still waiting"), fauxAssistantMessage("complete using option B")]);
    await restored.session.prompt(reply("unrelated"), { source: "rpc", expandPromptTemplates: false }); await sleep(30);
    assert.equal(restored.shutdowns(), 0); assert.deepEqual(waitingForReply(restored.session.sessionManager), ["peer"]);
    await restored.session.prompt(reply(), { source: "rpc", expandPromptTemplates: false }); await sleep(30);
    assert.deepEqual(waitingForReply(restored.session.sessionManager), []); assert.equal(restored.shutdowns(), 1); assert.deepEqual(restored.errors, []);
  } finally { await restored.close(); }
});

for (const suffix of ["", " (waiting for your reply)"]) test(`native swarm headers are not human takeover even on interactive input: ${suffix || "ordinary"}`, async () => {
  addressed(); const r = await runtime();
  try {
    r.faux.setResponses([waitCall(), fauxAssistantMessage("whole result")]);
    await r.session.prompt("initial task"); await sleep(30); assert.equal(r.shutdowns(), 0);
    await r.session.prompt(`[swarm message] peer → worker${suffix}\nUse option B.`, { source: "interactive", expandPromptTemplates: false }); await sleep(30);
    assert.equal(r.shutdowns(), 1); assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("plain submitted follow-up ends waiting and still exits after completion", async () => {
  addressed(); const r = await runtime();
  try {
    r.faux.setResponses([waitCall(), fauxAssistantMessage("follow-up complete")]);
    await r.session.prompt("initial task"); assert.equal(r.shutdowns(), 0);
    await r.session.prompt("Stop waiting; process this follow-up task.", { source: "interactive" }); await sleep(30);
    assert.deepEqual(waitingForReply(r.session.sessionManager), []); assert.equal(r.shutdowns(), 1);
    assert.equal(r.session.sessionManager.getEntries().some(e => e.type === "custom" && e.customType === "swarm_takeover"), false);
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("Escape keeps the settled session open; the next submitted task still exits", async () => {
  state(); let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const hold = new Promise<void>(resolve => { release = resolve; });
  let once = true; const r = await runtime(undefined, undefined, pi => { pi.on("agent_before_settle", async () => { if (once) { once = false; entered(); await hold; } }); });
  try {
    r.faux.setResponses([fauxAssistantMessage("initial completion"), fauxAssistantMessage("follow-up complete")]);
    const task = r.session.prompt("initial task"); await started;
    assert.equal(r.type("\x1b"), undefined); release(); await task; await sleep(30); assert.equal(r.shutdowns(), 0);
    await r.session.prompt("host follow-up task", { source: "interactive" }); await sleep(30);
    assert.equal(r.shutdowns(), 1); assert.deepEqual(r.errors, []);
  } finally { release(); await r.close(); }
});

test("an unsubmitted editor draft keeps the settled session open", async () => {
  state(); const r = await runtime();
  try {
    r.draft("unfinished instructions");
    r.faux.setResponses([fauxAssistantMessage("initial completion"), fauxAssistantMessage("follow-up complete")]);
    await r.session.prompt("initial task"); await sleep(30); assert.equal(r.shutdowns(), 0);
    r.draft(""); await r.session.prompt("submitted instructions"); await sleep(30);
    assert.equal(r.shutdowns(), 1); assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("a herdr-style interactive prompt arriving after settlement completes before exit", async () => {
  state(); let session!: Awaited<ReturnType<typeof runtime>>["session"];
  let submitted = false; let followUp: Promise<void> | undefined;
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const hold = new Promise<void>(resolve => { release = resolve; });
  const r = await runtime(undefined, undefined, pi => {
    pi.on("agent_settled", () => {
      if (!submitted) { submitted = true; followUp = session.prompt("HOST_FOLLOWUP", { source: "interactive" }); }
    });
    pi.on("before_agent_start", async event => { if (event.prompt === "HOST_FOLLOWUP") { entered(); await hold; } });
  }); session = r.session;
  try {
    let context = "";
    r.faux.setResponses([fauxAssistantMessage("initial completion"), c => { context = JSON.stringify(c); return fauxAssistantMessage("host follow-up complete"); }]);
    const task = session.prompt("initial task"); await started; await sleep(30);
    assert.equal(r.shutdowns(), 0, "the old exit candidate must not close a queued host task");
    release(); await task; await followUp; await session.waitForIdle(); await sleep(30);
    assert.match(context, /HOST_FOLLOWUP/); assert.equal(r.faux.state.callCount, 2);
    assert.equal(r.shutdowns(), 1); assert.deepEqual(r.errors, []);
  } finally { release(); await r.close(); }
});

test("submitted steering during the first provider call is more work, not permanent takeover", async () => {
  state(); let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const hold = new Promise<void>(resolve => { release = resolve; });
  const r = await runtime();
  try {
    r.faux.setResponses([async () => { entered(); await hold; return fauxAssistantMessage("first reply"); }, fauxAssistantMessage("whole manual result")]);
    const task = r.session.prompt("initial task"); await started;
    assert.equal(r.session.sessionManager.getBranch().some(e => e.type === "message" && e.message.role === "assistant"), false);
    await r.session.prompt("Actually, I will direct this now.", { source: "interactive", streamingBehavior: "steer" });
    release(); await task; await r.session.waitForIdle(); await sleep(30);
    assert.equal(r.faux.state.callCount, 2); assert.equal(r.shutdowns(), 1); assert.deepEqual(r.errors, []);
  } finally { release(); await r.close(); }
});

test("reload preserves the original standalone session's exit eligibility", async () => {
  state(); const r = await runtime();
  try {
    await r.session.reload();
    r.faux.setResponses([fauxAssistantMessage("complete")]); await r.session.prompt("initial task"); await sleep(30);
    assert.equal(r.shutdowns(), 1); assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("session navigation never rebinds standalone exit eligibility, including after reload", async () => {
  state(); const original = await runtime();
  const previousSessionFile = original.session.sessionManager.getSessionFile()!;
  const cwd = original.session.sessionManager.getCwd();
  await original.close("new");
  // /new replaces the extension factory as well as the session, not just its active branch.
  const manager = SessionManager.create(cwd, mkdtempSync(join(dir, "replacement-")));
  const r = await runtime(undefined, manager, undefined, false, { type: "session_start", reason: "new", previousSessionFile });
  try {
    assert.notEqual(r.session.sessionManager.getSessionFile(), previousSessionFile);
    await r.session.reload();
    r.faux.setResponses([fauxAssistantMessage("another session's result")]); await r.session.prompt("initial task in different session"); await sleep(30);
    assert.equal(r.shutdowns(), 0); assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("pending children prevent standalone exit until their result is followed by a completed reply", async () => {
  const cwd = mkdtempSync(join(dir, "parent-")); const parent = SessionManager.create(cwd, cwd);
  const child = SessionManager.create(cwd, mkdtempSync(join(dir, "child-")));
  child.appendMessage({ role: "user", content: "child task", timestamp: Date.now() }); child.appendMessage(fauxAssistantMessage("child complete"));
  const run: Run = { name: "child", pane: "w1:p9", session: child.getSessionFile()!, boundary: null, snapshot: { cwd, model: "swarm-test/test-model", thinking: "off" } };
  parent.appendCustomEntry("swarm_spawn", run);
  state([{ name: "child", pane_id: "w1:p9", agent: "pi", agent_status: "working", agent_session: { kind: "path", value: run.session } }]);
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const hold = new Promise<void>(resolve => { release = resolve; });
  const r = await runtime(undefined, parent); let context = "";
  try {
    r.faux.setResponses([fauxAssistantMessage("delegated, awaiting child"), async c => { context = JSON.stringify(c); entered(); await hold; return fauxAssistantMessage("whole result including child"); }]);
    await r.session.prompt("initial task"); await sleep(30); assert.equal(pending(), 1); assert.equal(r.shutdowns(), 0);
    state(); await Promise.race([started, sleep(3000).then(() => { throw new Error("child result was not delivered"); })]);
    assert.match(context, /child complete/); assert.equal(pending(), 1); assert.equal(r.shutdowns(), 0, "archiving alone is not enough");
    release(); await r.session.waitForIdle(); await until(() => r.shutdowns() === 1);
    assert.equal(pending(), 0); assert.equal(parent.getEntries().filter(e => e.type === "custom_message" && e.customType === "swarm_result").length, 1);
    assert.deepEqual(r.errors, []);
  } finally { release(); await r.close(); }
});

for (const explicitExit of [false, true]) test(`internal swarm_spawn peers still exit after a manual reply (swarm-exit=${explicitExit})`, async () => {
  addressed(); const r = await runtime(explicitExit ? { "swarm-exit": true } : {}, undefined, undefined, true);
  try {
    r.faux.setResponses([waitCall(), fauxAssistantMessage("whole result after manual reply")]);
    await r.session.prompt("initial task"); await sleep(30); assert.equal(r.shutdowns(), 0);
    r.type("\x1b");
    await r.session.prompt("human answer: use option B"); await sleep(30);
    assert.deepEqual(waitingForReply(r.session.sessionManager), []); assert.equal(r.shutdowns(), 1); assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});
