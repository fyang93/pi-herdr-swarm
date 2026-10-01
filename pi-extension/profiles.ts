import { parseFrontmatter, loadSkills } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
export interface Profile { name: string; description: string; body: string; fields: Record<string, unknown> }
export function profiles(cwd: string, trusted: boolean): Profile[] {
  const found = new Map<string, Profile>();
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
const csv = (value: unknown) => String(value ?? "").split(",").map(s => s.trim()).filter(Boolean);

export function loadout(profile: Profile, runDir: string, cwd: string, task: string, model?: string): { args: string[]; task: string; autoExit: boolean } {
  const f = profile.fields;
  if (f.cli && f.cli !== "pi") throw new Error("Only pi agent profiles are supported.");
  if (f["session-mode"] && f["session-mode"] !== "standalone") throw new Error("Swarm agents use fresh standalone sessions, not fork/lineage modes.");
  const args = ["--session", join(runDir, "session.jsonl"), "-e", extensionPath];
  if (model || f.model) args.push("--model", model || String(f.model));
  if (f.thinking) args.push("--thinking", String(f.thinking));
  const tools = csv(f.tools);
  if (tools.length) args.push("--tools", [...new Set([...tools, "swarm_spawn", "swarm_send", "swarm_list", "swarm_board"])].join(","));
  if (profile.body && f["system-prompt"]) {
    if (!["append", "replace"].includes(String(f["system-prompt"]))) throw new Error("system-prompt must be append or replace.");
    const path = join(runDir, "system.md");
    writeFileSync(path, profile.body);
    args.push(f["system-prompt"] === "replace" ? "--system-prompt" : "--append-system-prompt", path);
  } else if (profile.body) task = `${profile.body}\n\n${task}`;
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
  return { args, task, autoExit: f["auto-exit"] !== false };
}
export function profileCwd(profile: Profile, callerCwd: string, override?: string): string {
  return resolve(callerCwd, override ?? String(profile.fields.cwd ?? "."));
}
