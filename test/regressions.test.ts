import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import swarm from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "swarm-runtime-"));
after(() => rmSync(dir, { recursive: true, force: true }));
async function session(tools: string[], required: string[] = []) {
  process.env.PI_SWARM_TOOLS = JSON.stringify(required);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [swarm] });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
  const result = await createAgentSession({ cwd: dir, agentDir: dir, model: getModel("openai", "gpt-4.1"), thinkingLevel: "xhigh", modelRuntime, tools, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir) });
  delete process.env.PI_SWARM_TOOLS;
  return result.session;
}

test("real pi startup clamps inherited thinking to model capability and keeps a narrow tool selection", async () => {
  const s = await session(["read"]);
  try { assert.equal(s.thinkingLevel, "off"); assert.deepEqual(s.getActiveToolNames(), ["read"]); }
  finally { s.dispose(); }
});

test("unavailable inherited tools explicitly error and input is handled without model/default-tools fallback", async () => {
  const s = await session(["read", "parent_only_tool"], ["read", "parent_only_tool"]);
  const errors: string[] = [];
  try {
    await s.bindExtensions({ mode: "print", onError: e => errors.push(e.error) });
    assert.ok(errors.some(e => e.includes("parent_only_tool") && e.includes("No fallback")));
    await s.prompt("This must never reach a model", { expandPromptTemplates: false });
    assert.equal(s.messages.some(m => m.role === "user"), false);
    assert.deepEqual(s.getActiveToolNames(), ["read"]);
  } finally { s.dispose(); }
});
