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
export interface Snapshot { cwd: string; model: string; thinking: string; prompt?: string; extensionLoaded?: boolean }
export function presets(cwd: string, trusted: boolean): Preset[] {
  const found = new Map<string, Preset>();
  for (const dir of [fileURLToPath(new URL("../agents/", import.meta.url)), join(agentDir(), "agents"), ...(trusted ? [join(cwd, ".pi/agents")] : [])]) {
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
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) throw new Error(`Invalid thinking level: ${level}`);
  const settings = (path: string) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; } };
  const hasPackage = (value: any) => (Array.isArray(value.packages) ? value.packages : []).some((pkg: any) => String(typeof pkg === "string" ? pkg : pkg?.source ?? "").replace(/\/$/, "").endsWith("pi-herdr-swarm"));
  const globalSettings = settings(join(agentDir(), "settings.json"));
  // Mirror pi: trust is the nearest decision at or above cwd, and project settings are <cwd>/.pi/settings.json.
  let projectTrusted = false;
  try {
    const trust = settings(join(agentDir(), "trust.json"));
    let dir = cwd;
    let decided = false;
    while (true) {
      if (typeof trust[dir] === "boolean") { projectTrusted = trust[dir]; decided = true; break; }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!decided && globalSettings.defaultProjectTrust === "always") projectTrusted = true;
  } catch { /* Unknown trust: load explicitly with -e. */ }
  const projectSettings = projectTrusted ? settings(join(cwd, ".pi/settings.json")) : {};
  return { cwd, model: `${selected.provider}/${selected.id}`, thinking: clampThinkingLevel(selected, level as ModelThinkingLevel), prompt: preset?.body || undefined, extensionLoaded: hasPackage(globalSettings) || hasPackage(projectSettings) };
}
/** pi command-line arguments that reproduce a snapshot. */
export function loadout(config: Snapshot, session: string): string[] {
  const args = ["--session", session, ...(config.extensionLoaded ? [] : ["-e", extensionPath]), "--model", config.model, "--thinking", config.thinking];
  if (config.prompt) {
    const path = join(dirname(session), "system.md");
    writeFileSync(path, config.prompt);
    args.push("--append-system-prompt", path);
  }
  return args;
}
