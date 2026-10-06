import { getAgentDir, parseFrontmatter, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
export interface Preset { name: string; description: string; body: string; fields: Record<string, unknown> }
/** Resolved launch configuration, saved in the spawn record for resume. `prompt` is appended to pi's system prompt. */
/** `tools` are activated in the peer when registered; they add to pi's tools and never restrict them. */
export interface Snapshot { cwd: string; model: string; thinking: string; prompt?: string; tools?: string[]; preset?: string; canSpawn?: string[] }
/** Absent policy is unrestricted; only an explicit list of exact preset IDs is accepted. */
export function spawnPolicy(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(name => typeof name !== "string" || !name.trim() || name !== name.trim() || name.includes("*"))) {
    throw new Error("can-spawn must be a list of exact preset names (or [] to deny all).");
  }
  return [...new Set(value)];
}
export function checkSpawn(policy: unknown, presetName?: string): void {
  const allowed = spawnPolicy(policy);
  if (allowed !== undefined && (presetName === undefined || !allowed.includes(presetName))) {
    throw new Error(`Spawn denied by can-spawn policy: ${presetName ?? "unpreset peer"}.`);
  }
}
/** A preset's `requires-tools`: a YAML list (`[codemode]`), a name, or a comma-separated string. */
export function requiredTools(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : String(value).split(",")).map(name => String(name).trim()).filter(Boolean);
}
export function presets(cwd: string, trusted: boolean): Preset[] {
  const found = new Map<string, Preset>();
  for (const dir of [join(getAgentDir(), "agents"), ...(trusted ? [join(cwd, ".pi/agents")] : [])]) {
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
  const canSpawn = spawnPolicy(f["can-spawn"]);
  if (f.cli && f.cli !== "pi") throw new Error("Only pi presets are supported.");
  if (f["session-mode"] && f["session-mode"] !== "standalone") throw new Error("Only standalone sessions are supported.");
  const cwd = await realpath(resolve(context.cwd, overrides.cwd ?? String(f.cwd ?? ".")));
  const requested = overrides.model ?? (f.model === undefined ? undefined : String(f.model));
  const matches = requested !== undefined ? context.modelRegistry.getAll().filter(m => m.id === requested || `${m.provider}/${m.id}` === requested) : [];
  const selected = requested !== undefined ? matches.length === 1 ? matches[0] : undefined : context.model;
  if (!selected) throw new Error(`Model unavailable: ${requested || "select a model before spawning"}`);
  const level = String(f.thinking ?? thinking);
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) throw new Error(`Invalid thinking level: ${level}`);
  const tools = requiredTools(f["requires-tools"]);
  return { cwd, model: `${selected.provider}/${selected.id}`, thinking: clampThinkingLevel(selected, level as ModelThinkingLevel), prompt: preset?.body || undefined, tools: tools.length ? tools : undefined, preset: preset?.name, canSpawn };
}
/** pi command-line arguments that reproduce a snapshot. */
export function loadout(config: Snapshot, session: string): string[] {
  // Always this copy: pi loads an identical path once, so an installed package is not loaded twice.
  const args = ["--session", session, "-e", extensionPath, "--model", config.model, "--thinking", config.thinking];
  const policy = spawnPolicy(config.canSpawn);
  if (policy !== undefined) args.push("--swarm-can-spawn", JSON.stringify(policy));
  if (config.tools?.length) args.push("--swarm-tools", config.tools.join(","));
  if (config.prompt) {
    const path = join(dirname(session), "system.md");
    writeFileSync(path, config.prompt);
    args.push("--append-system-prompt", path);
  }
  return args;
}
