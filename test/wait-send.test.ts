import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import swarm from "../src/index.ts";
import { readResult, waitingForReply } from "../src/run.ts";

const dir = mkdtempSync(join(tmpdir(), "swarm-wait-send-"));
Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", HERDR_BIN_PATH: resolve("test/fake-herdr.cjs"), FAKE_HERDR_DIR: dir });
const state = (targets = ["peer"], extra: Record<string, unknown> = {}) => {
  writeFileSync(join(dir, "state.json"), JSON.stringify({ agents: [{ name: "worker", pane_id: "w1:p1", agent: "pi", cwd: dir },
    ...targets.map((name, n) => ({ name, pane_id: `w1:p${n + 2}`, agent: "pi", cwd: dir }))], ...extra }));
  writeFileSync(join(dir, "calls.jsonl"), "");
};
after(() => rmSync(dir, { recursive: true, force: true }));
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
  const { session } = await createAgentSession({ cwd, agentDir: caseDir, model: faux.getModel(), modelRuntime, resourceLoader: loader, settingsManager, sessionManager });
  let shutdowns = 0; const errors: string[] = [];
  await session.bindExtensions({ mode: "tui", shutdownHandler: () => { shutdowns++; }, onError: e => errors.push(e.error),
    uiContext: { setWidget() {}, setStatus() {}, getEditorText: () => "", notify() {}, onTerminalInput: () => () => {} } as any });
  return { session, faux, errors, shutdowns: () => shutdowns,
    close: async () => { await session.extensionRunner!.emit({ type: "session_shutdown", reason: "reload" }); session.dispose(); } };
}
const nativeReply = (from: string, text = "Use option B.", wait = false) => `[swarm message] ${from} → worker${wait ? " (waiting for your reply)" : ""}\n${text}`;
const resultMessage = (name: string) => ({ customType: "swarm_result", content: `[swarm result] ${name}\nSession: /tmp/${name}\nfinished`, display: true, details: { name, session: `/tmp/${name}`, status: "reply" } });
const calls = () => readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const waitCall = (to: string | string[] = "peer") => fauxAssistantMessage(fauxToolCall("swarm_send", { to, message: "Which option should I use?", wait: true }));

for (const auto of [true, false]) test(auto ? "wait:true parks a spawned peer after an ordinary native send, until its addressed reply" : "wait:true also parks an ordinary parent session; it is not a spawned-peer-only API", async () => {
  const target = auto ? "spawner" : "peer"; state([target]); let result: any;
  const r = await runtime(auto, pi => { pi.on("tool_execution_end", event => { if (event.toolName === "swarm_send") result = event.result; }); });
  try {
    assert.equal(r.session.getActiveToolNames().includes("ask_question"), false);
    r.faux.setResponses([waitCall(target), fauxAssistantMessage("unexpected continuation")]);
    await r.session.prompt("ask for a decision"); await sleep(30);
    assert.equal(result?.terminate, true); assert.equal(result?.details?.wait, true);
    assert.deepEqual(waitingForReply(r.session.sessionManager), [target]);
    assert.equal(r.faux.state.callCount, 1); assert.equal(r.session.isIdle, true); assert.equal(r.shutdowns(), 0);
    assert.equal(readResult({ name: "worker", session: r.session.sessionManager.getSessionFile()!, boundary: null }).status, "incomplete", "a parked send is not a final result");
    assert.ok(calls().some(args => args[0] === "agent" && args[1] === "prompt" && args[2] === target && args.includes(`[swarm message] worker → ${target} (waiting for your reply)\nWhich option should I use?`)));
    assert.equal(r.session.sessionManager.getEntries().some(e => (e.type === "custom" || e.type === "custom_message") && ["swarm_question", "swarm_wait", "swarm_reply", "swarm_message"].includes(e.customType)), false);
    assert.equal(existsSync(join(r.session.sessionManager.getCwd(), ".pi/swarm")), false);
    r.session.clearQueue(); await r.session.reload(); await sleep(30);
    assert.deepEqual(waitingForReply(r.session.sessionManager), [target]); assert.equal(r.shutdowns(), 0);
    let context = "";
    r.faux.setResponses([c => { context = JSON.stringify(c); return fauxAssistantMessage("Complete result using option B."); }]);
    await r.session.prompt(nativeReply(target, "Use option B.", auto), { source: "rpc", expandPromptTemplates: false }); await sleep(30);
    assert.match(context, /Use option B/); assert.deepEqual(waitingForReply(r.session.sessionManager), []);
    assert.equal(r.shutdowns(), auto ? 1 : 0); assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("a mixed tool batch stops after wait:true without later side effects or a duplicate send", async () => {
  state(); const r = await runtime(true); const sideEffect = join(r.session.sessionManager.getCwd(), "unwanted-write");
  try {
    r.faux.setResponses([fauxAssistantMessage([
      fauxToolCall("read", { path: "missing-file" }),
      fauxToolCall("swarm_send", { to: "peer", message: "May I write this file?", wait: true }),
      fauxToolCall("write", { path: sideEffect, content: "must not execute" }),
      fauxToolCall("swarm_send", { to: "peer", message: "duplicate request", wait: true }),
    ]), fauxAssistantMessage(fauxToolCall("write", { path: sideEffect, content: "must not continue" })), fauxAssistantMessage("unexpected continuation")]);
    await r.session.prompt("ask before writing"); await sleep(30);
    assert.equal(r.faux.state.callCount, 1); assert.equal(existsSync(sideEffect), false);
    assert.equal(calls().filter(args => args[0] === "agent" && args[1] === "prompt").length, 1);
    assert.deepEqual(waitingForReply(r.session.sessionManager), ["peer"]);
    assert.equal(r.shutdowns(), 0); assert.equal(r.session.isIdle, true); assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("unrelated swarm messages do not release a wait, which survives a fresh disk-backed restart", async () => {
  state(); const r = await runtime(true); let file = "";
  try {
    r.faux.setResponses([waitCall(), fauxAssistantMessage("unexpected continuation")]);
    await r.session.prompt("ask"); file = r.session.sessionManager.getSessionFile()!;
    assert.deepEqual(waitingForReply(r.session.sessionManager), ["peer"]);
    assert.match(readFileSync(file, "utf8"), /"wait":true/);
    r.session.clearQueue();
  } finally { await r.close(); }
  // Recover only from the existing transcript, with no process-local delivery state.
  delete (globalThis as any)[Symbol.for("pi-herdr-swarm/result-delivery")];
  const restored = await runtime(true, undefined, SessionManager.open(file));
  try {
    assert.deepEqual(waitingForReply(restored.session.sessionManager), ["peer"]);
    await sleep(30); assert.equal(restored.shutdowns(), 0);
    restored.faux.setResponses([fauxAssistantMessage("still waiting"), fauxAssistantMessage("Complete result using option B.")]);
    await restored.session.prompt(nativeReply("unrelated", "Can you help?", true), { source: "rpc", expandPromptTemplates: false }); await sleep(30);
    assert.deepEqual(waitingForReply(restored.session.sessionManager), ["peer"]); assert.equal(restored.shutdowns(), 0);
    await restored.session.prompt(nativeReply("peer"), { source: "rpc", expandPromptTemplates: false }); await sleep(30);
    assert.deepEqual(waitingForReply(restored.session.sessionManager), []); assert.equal(restored.shutdowns(), 1);
    assert.equal(calls().filter(args => args[0] === "agent" && args[1] === "prompt").length, 1, "restart must not resend the request");
    assert.deepEqual(restored.errors, []);
  } finally { await restored.close(); }
});

test("wait:true resumes when an ended recipient returns its swarm_result", async () => {
  state(["peer"]); let send!: (message: any) => void;
  const r = await runtime(true, pi => { send = message => pi.sendMessage(message, { triggerTurn: true }); });
  try {
    r.faux.setResponses([waitCall(), fauxAssistantMessage("Complete result")]);
    await r.session.prompt("ask");
    assert.deepEqual(waitingForReply(r.session.sessionManager), ["peer"]);
    send(resultMessage("peer"));
    await r.session.waitForIdle(); await sleep(30);
    assert.deepEqual(waitingForReply(r.session.sessionManager), []);
    assert.equal(r.faux.state.callCount, 2); assert.equal(r.shutdowns(), 1); assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("human input ends a restored wait and allows tool execution", async () => {
  state(); const r = await runtime(true); let file = "";
  try {
    r.faux.setResponses([waitCall()]);
    await r.session.prompt("ask"); file = r.session.sessionManager.getSessionFile()!;
    assert.deepEqual(waitingForReply(r.session.sessionManager), ["peer"]);
  } finally { await r.close(); }
  const restored = await runtime(true, undefined, SessionManager.open(file));
  const output = join(restored.session.sessionManager.getCwd(), "human-takeover.txt");
  try {
    assert.deepEqual(waitingForReply(restored.session.sessionManager), ["peer"]);
    restored.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: output, content: "human took over" })),
      fauxAssistantMessage("done"),
    ]);
    await restored.session.prompt("Stop waiting; write the file now."); await sleep(30);
    assert.deepEqual(waitingForReply(restored.session.sessionManager), []);
    assert.equal(readFileSync(output, "utf8"), "human took over");
    assert.equal((globalThis as any)[Symbol.for("pi-herdr-swarm/pending-count")](), 0);
    assert.equal(restored.shutdowns(), 1); assert.deepEqual(restored.errors, []);
  } finally { await restored.close(); }
});

test("a native reply queued while wait:true is being submitted resumes through pi's ordinary steering queue", async () => {
  state(["peer"], { delay: 150 }); let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); let context = "";
  const r = await runtime(true, pi => { pi.on("tool_execution_start", event => { if (event.toolName === "swarm_send") entered(); }); });
  try {
    r.faux.setResponses([waitCall(), c => { context = JSON.stringify(c); return fauxAssistantMessage("Complete result using option B."); }]);
    const task = r.session.prompt("ask"); await started;
    const reply = r.session.prompt(nativeReply("peer"), { source: "rpc", expandPromptTemplates: false, streamingBehavior: "steer" });
    await Promise.all([task, reply]); await r.session.waitForIdle(); await sleep(30);
    assert.match(context, /Use option B/); assert.deepEqual(waitingForReply(r.session.sessionManager), []);
    assert.equal(r.faux.state.callCount, 2); assert.equal(r.shutdowns(), 1); assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("a partially submitted wait parks only for successful recipients and resumes on their reply", async () => {
  state(["peer", "blocked"]); const r = await runtime(true);
  try {
    r.faux.setResponses([waitCall(["peer", "blocked", "missing"]), fauxAssistantMessage("unexpected continuation")]);
    await r.session.prompt("ask several recipients"); await sleep(30);
    assert.deepEqual(waitingForReply(r.session.sessionManager), ["peer"]);
    assert.equal(r.faux.state.callCount, 1); assert.equal(r.shutdowns(), 0);
    r.faux.setResponses([fauxAssistantMessage("Complete result using option B.")]);
    await r.session.prompt(nativeReply("peer"), { source: "rpc", expandPromptTemplates: false }); await sleep(30);
    assert.deepEqual(waitingForReply(r.session.sessionManager), []); assert.equal(r.shutdowns(), 1); assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("ordinary sends continue normally; failed wait deliveries do not park the sender", async () => {
  for (const wait of [false, true]) {
    state([wait ? "blocked" : "peer"]); const r = await runtime(true);
    try {
      r.faux.setResponses([fauxAssistantMessage(fauxToolCall("swarm_send", { to: wait ? "blocked" : "peer", message: "update", ...(wait ? { wait: true } : {}) })), fauxAssistantMessage("done")]);
      await r.session.prompt("send"); await sleep(30);
      assert.deepEqual(waitingForReply(r.session.sessionManager), []);
      if (!wait) assert.ok(calls().some(args => args[0] === "agent" && args[1] === "prompt" && args.includes("[swarm message] worker → peer\nupdate")), "ordinary sends retain their original header");
      assert.equal(r.faux.state.callCount, 2); assert.equal(r.shutdowns(), 1); assert.deepEqual(r.errors, []);
    } finally { await r.close(); }
  }
});
