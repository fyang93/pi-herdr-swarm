import { parseFrontmatter, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
export interface Preset { name: string; description: string; body: string; fields: Record<string, unknown> }
/** Resolved launch configuration, saved in the spawn record for resume. `prompt` is appended to pi's system prompt. */
export interface Snapshot { cwd: string; model: string; thinking: string; prompt?: string }
export function presets(cwd: string, trusted: boolean): Preset[] {
  const found = new Map<string, Preset>();
  for (const dir of [join(agentDir(), "agents"), ...(trusted ? [join(cwd, ".pi/agents")] : [])]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter(f => f.endsWith(".md")).sort()) {
      const { frontmatter, body } = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
      const name = String(frontmatter.name ?? file.slice(0, -3));
      found.set(name, { name, description: String(frontmatter.description ?? ""), body: body.trim(), fields: frontmatter });
    }
  }
  return [...found.values()];
}
export async function snapshot(preset: Preset | undefined, context: ExtensionContext, thinking: string, overrides: { model?: string; cwd?: string }): Promise<Snapshot> {
  const f = preset?.fields ?? {};
  if (f.cli && f.cli !== "pi") throw new Error("Only pi presets are supported.");
  if (f["session-mode"] && f["session-mode"] !== "standalone") throw new Error("Only standalone sessions are supported.");
  const cwd = await realpath(resolve(context.cwd, overrides.cwd ?? String(f.cwd ?? ".")));
  const requested = overrides.model ?? (f.model === undefined ? undefined : String(f.model));
  const matches = requested !== undefined ? context.modelRegistry.getAll().filter(m => m.id === requested || `${m.provider}/${m.id}` === requested) : [];
  const selected = requested !== undefined ? matches.length === 1 ? matches[0] : undefined : context.model;
  if (!selected) throw new Error(`Model unavailable: ${requested || "select a model before spawning"}`);
  const level = String(f.thinking ?? thinking);
  if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(level)) throw new Error(`Invalid thinking level: ${level}`);
  return { cwd, model: `${selected.provider}/${selected.id}`, thinking: clampThinkingLevel(selected, level as ModelThinkingLevel), prompt: preset?.body || undefined };
}
export function loadout(config: Snapshot, session: string, task: string) {
  const args = ["--session", session, "-e", extensionPath, "--model", config.model, "--thinking", config.thinking];
  if (config.prompt) {
    const path = join(dirname(session), "system.md");
    writeFileSync(path, config.prompt);
    args.push("--append-system-prompt", path);
  }
  return { args, task };
}
