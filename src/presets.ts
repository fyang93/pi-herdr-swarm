import { parseFrontmatter, loadSkills } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
export interface Preset { name: string; description: string; body: string; fields: Record<string, unknown> }
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
const csv = (value: unknown) => String(value ?? "").split(",").map(s => s.trim()).filter(Boolean);

export function loadout(preset: Preset | undefined, runDir: string, cwd: string, task: string, parent: { model?: string; thinking: string; tools: string[] }, model?: string): { args: string[]; task: string; autoExit: boolean; tools: string[]; session: string } {
  const f = preset?.fields ?? {};
  if (f.cli && f.cli !== "pi") throw new Error("Only pi agent profiles are supported.");
  if (f["session-mode"] && f["session-mode"] !== "standalone") throw new Error("Swarm agents use fresh standalone sessions, not fork/lineage modes.");
  const session = join(runDir, "session.jsonl");
  const args = ["--session", session, "-e", extensionPath];
  const selectedModel = model ?? (f.model === undefined ? parent.model : String(f.model));
  if (!selectedModel) throw new Error("Select a model before spawning a peer.");
  args.push("--model", selectedModel, "--thinking", String(f.thinking ?? parent.thinking));
  // pi clamps thinking to the selected model's capabilities on startup.
  const tools = f.tools === undefined ? parent.tools : csv(f.tools);
  args.push(...(tools.length ? ["--tools", tools.join(",")] : ["--no-tools"]));
  if (preset?.body && f["system-prompt"]) {
    if (!["append", "replace"].includes(String(f["system-prompt"]))) throw new Error("system-prompt must be append or replace.");
    const path = join(runDir, "system.md");
    writeFileSync(path, preset.body);
    args.push(f["system-prompt"] === "replace" ? "--system-prompt" : "--append-system-prompt", path);
  } else if (preset?.body) task = `${preset.body}\n\n${task}`;
  const requested = csv(f.skills ?? f.skill);
  if (requested.length) {
    const { skills } = loadSkills({ cwd, agentDir: agentDir(), skillPaths: [], includeDefaults: true });
    const blocks = requested.map(name => {
      const skill = skills.find(s => s.name === name);
      if (!skill) throw new Error(`Skill ${name} not found in default skill directories.`);
      return `<skill name=${JSON.stringify(name)} base=${JSON.stringify(dirname(skill.filePath))}>\n${readFileSync(skill.filePath, "utf8")}\n</skill>`;
    });
    // One task submission: separate /skill prompts could settle and exit before the task arrives.
    task = `${blocks.join("\n\n")}\n\n${task}`;
  }
  if (f["auto-exit"] !== undefined && typeof f["auto-exit"] !== "boolean") throw new Error("auto-exit must be a boolean.");
  return { args, task, autoExit: f["auto-exit"] !== false, tools, session };
}
export function presetCwd(preset: Preset | undefined, callerCwd: string, override?: string): string {
  return resolve(callerCwd, override ?? String(preset?.fields.cwd ?? "."));
}
