import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { MESSAGE_LIMIT } from "./board.ts";

export interface Run { name: string; pane: string; dir: string; started: number; consumed?: number; warned?: boolean }
export interface Exit { type: "done" | "error" | "quit"; notified?: boolean; resultCreated?: number }
export function resultStamp(text: string): { name: string; created: number } | undefined {
  const match = text.match(/^\[swarm result\] ([a-z][a-z0-9_-]{0,31}) → [^\n]+\n(\S+) · expires /);
  const created = match && Date.parse(match[2]);
  return match && Number.isFinite(created) ? { name: match[1], created: created as number } : undefined;
}
export function readJSON(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (error: any) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}
export function writeJSON(path: string, data: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(data));
  renameSync(`${path}.tmp`, path);
}
export function alive(pid: unknown): boolean | undefined {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return undefined;
  try { process.kill(pid as number, 0); return true; } catch (error: any) {
    return error.code === "ESRCH" ? false : undefined;
  }
}
export function wasAborted(message: any): boolean {
  return message?.stopReason === "aborted" || (message?.stopReason === "error" && /operation was aborted|AbortError/i.test(String(message.errorMessage ?? "")));
}
export function finalText(message: any): string {
  if (message?.stopReason === "error") return `Agent error: ${message.errorMessage || "unknown provider error"}`;
  return message?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim() || "Agent finished without a text summary.";
}
export function finalSummary(message: any, sessionFile: string): string {
  const text = finalText(message);
  if (text.length <= MESSAGE_LIMIT) return text;
  const suffix = `\n… Full final response is in the existing pi session: ${sessionFile}`;
  return text.slice(0, Math.max(0, MESSAGE_LIMIT - suffix.length)) + suffix;
}
export function canExit(autoExit: boolean, last: any, outcome: string, pending: boolean, children: number): boolean {
  return autoExit && !!last && outcome !== "aborted" && !wasAborted(last) && !pending && children === 0;
}
