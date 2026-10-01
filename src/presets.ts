import { parseFrontmatter, loadSkills, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
export interface Preset { name: string; description: string; body: string; fields: Record<string, unknown> }
export interface Snapshot { cwd: string; model: string; thinking: string; systemPrompt?: { mode: "append" | "replace"; body: string }; skills: { name: string; base: string; content: string }[] }
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
  const mode = String(f["system-prompt"] ?? "append");
  if (!["append", "replace"].includes(mode)) throw new Error("system-prompt must be append or replace.");
  const requestedSkills = String(f.skills ?? f.skill ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const available = requestedSkills.length ? loadSkills({ cwd, agentDir: agentDir(), skillPaths: [], includeDefaults: true }).skills : [];
  return { cwd, model: `${selected.provider}/${selected.id}`, thinking: clampThinkingLevel(selected, level as ModelThinkingLevel),
    systemPrompt: preset?.body ? { mode: mode as "append" | "replace", body: preset.body } : undefined,
    skills: requestedSkills.map(name => {
      const skill = available.find(s => s.name === name);
      if (!skill) throw new Error(`Skill ${name} not found in ${cwd} or ${agentDir()}.`);
      return { name, base: dirname(skill.filePath), content: readFileSync(skill.filePath, "utf8") };
    }),
  };
}
export function loadout(config: Snapshot, session: string, task: string) {
  const args = ["--session", session, "-e", extensionPath, "--model", config.model, "--thinking", config.thinking];
  const prompt = [config.systemPrompt?.body, ...config.skills.map(s => `<skill name=${JSON.stringify(s.name)} base=${JSON.stringify(s.base)}>\n${s.content}\n</skill>`)].filter(Boolean).join("\n\n");
  if (prompt) {
    const path = join(dirname(session), "system.md");
    writeFileSync(path, prompt);
    args.push(config.systemPrompt?.mode === "replace" ? "--system-prompt" : "--append-system-prompt", path);
  }
  return { args, task };
}
