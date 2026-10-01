import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { constants, mkdirSync, openSync, closeSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { readdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface Note { from: string; to: string; message: string; kind: "message" | "result"; created: number; expires: number }
type Input = Pick<Note, "from" | "to" | "message"> & Partial<Pick<Note, "kind">>;
export const DAY = 86_400;
export const MESSAGE_LIMIT = 4000;
export const boardPath = (root: string) => join(root, ".pi/swarm/board");
function validate(input: Input): void {
  if (typeof input.from !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(input.from) || typeof input.to !== "string" || !( /^[a-z][a-z0-9_-]{0,31}$/.test(input.to) || (input.to.includes("*") && /^[a-z0-9_*-]{1,128}$/.test(input.to)))) throw new Error("Invalid envelope sender or target.");
  if (input.kind !== undefined && !["message", "result"].includes(input.kind)) throw new Error("Invalid envelope kind.");
  if (typeof input.message !== "string" || !input.message.trim()) throw new Error("Message must be nonempty.");
  if (input.message.length > MESSAGE_LIMIT) throw new Error(`Message exceeds ${MESSAGE_LIMIT} characters; write the body to a file, then send a summary and file path.`);
}
function makeNote(input: Input): Note {
  validate(input);
  const created = Date.now();
  return { from: input.from, to: input.to, message: input.message, kind: input.kind ?? "message", created, expires: created + DAY * 1000 };
}
function publish(path: string, note: Note): Note {
  mkdirSync(path, { recursive: true });
  const fields = { from: note.from, to: note.to, kind: note.kind, created: new Date(note.created).toISOString(), expires: new Date(note.expires).toISOString() };
  const markdown = `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${note.message}`;
  for (let n = 1; ; n++) {
    const name = `${note.created}-${note.from}${n === 1 ? "" : `-${n}`}.md`;
    const file = join(path, name); const temp = join(path, `.${name}.${process.pid}.tmp`);
    let fd: number;
    try { fd = openSync(temp, "wx"); } catch (error: any) { if (error.code === "EEXIST") continue; throw error; }
    try {
      writeFileSync(fd, markdown);
      try { linkSync(temp, file); return note; } catch (error: any) { if (error.code !== "EEXIST") throw error; }
    } finally {
      closeSync(fd);
      try { unlinkSync(temp); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    }
  }
}
// Exit ticks only publish: no directory scan or expiration work on this synchronous path.
export const postSync = (path: string, input: Input): Note => publish(path, makeNote(input));
export async function post(path: string, input: Input, report?: (warning: string) => void): Promise<Note> {
  const note = makeNote(input);
  await readBoard(path, { limit: 1 }, report);
  return publish(path, note);
}
function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error("Invalid timestamp.");
  return Date.parse(value);
}
export async function readBoard(path: string, filter: { from?: string; to?: string; limit?: number } = {}, report: (warning: string) => void = console.warn): Promise<Note[]> {
  const limit = filter.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be 1..100.");
  let files: string[];
  try { files = (await readdir(path)).filter(f => f.endsWith(".md")).sort().reverse(); }
  catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
  // ponytail: scan retained files on access; add an index only if directory size makes this slow.
  const notes: Note[] = []; const buffer = Buffer.alloc(64 * 1024 + 1);
  for (const name of files) {
    const file = join(path, name);
    let text: string;
    try {
      const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        if (!(await handle.stat()).isFile()) { report(`Skipped non-regular board file: ${file}`); continue; }
        let bytes = 0;
        while (bytes < buffer.length) { const r = await handle.read(buffer, bytes, buffer.length - bytes, null); if (!r.bytesRead) break; bytes += r.bytesRead; }
        if (bytes === buffer.length) { report(`Skipped board file over 64 KiB: ${file}`); continue; }
        text = buffer.subarray(0, bytes).toString("utf8");
      } finally { await handle.close(); }
    } catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
    let note: Note;
    try {
      const { frontmatter: f, body } = parseFrontmatter(text);
      if (typeof f.from !== "string" || typeof f.to !== "string" || !["message", "result"].includes(f.kind as string)) continue;
      note = { from: f.from, to: f.to, kind: f.kind as Note["kind"], message: body, created: timestamp(f.created), expires: timestamp(f.expires) };
      validate(note);
      if (!Number.isSafeInteger(note.created) || !Number.isSafeInteger(note.expires) || note.expires <= note.created) continue;
    } catch { continue; }
    if (note.expires <= Date.now()) { try { await unlink(file); } catch (error: any) { if (error.code !== "ENOENT") throw error; } }
    else if (notes.length < limit && (filter.from === undefined || note.from === filter.from) && (filter.to === undefined || note.to === filter.to)) notes.push(note);
  }
  return notes;
}
export function formatNote(note: Note): string {
  validate(note);
  return `[swarm ${note.kind}] ${note.from} → ${note.to}\n${new Date(note.created).toISOString()} · expires ${new Date(note.expires).toISOString()}\n${note.message}`;
}
