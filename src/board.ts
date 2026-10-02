import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { constants, mkdirSync, openSync, closeSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { readdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

/** A notice an agent chose to post. The board holds nothing else: no private messages, no automatic results. */
export interface Note { from: string; message: string; created: number; expires: number }
export const DAY = 86_400;
export const MESSAGE_LIMIT = 4000;
export const boardPath = (root: string) => join(root, ".pi/swarm/board");

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
export function validateName(name: string): string {
  if (!NAME.test(name)) throw new Error("Agent names must match [a-z][a-z0-9_-]{0,31}.");
  return name;
}
/** An exact name, or a pattern with '*' anywhere (anchored, consecutive stars merged). Names are groups. */
export function namePattern(address: string): (name: string) => boolean {
  if (!address.includes("*")) { validateName(address); return name => name === address; }
  if (!/^[a-z0-9_*-]{1,128}$/.test(address)) throw new Error("Wildcard addresses support only name characters and '*', not '?', brackets or other glob syntax.");
  const pattern = new RegExp(`^${address.replace(/\*+/g, ".*")}$`);
  return name => pattern.test(name);
}
export function checkMessage(message: string): string {
  if (typeof message !== "string" || !message.trim()) throw new Error("Message must be nonempty.");
  if (message.length > MESSAGE_LIMIT) throw new Error(`Message exceeds ${MESSAGE_LIMIT} characters; write the body to a file, then send a summary and file path.`);
  return message;
}

function publish(path: string, note: Note): Note {
  mkdirSync(path, { recursive: true });
  const fields = { from: note.from, created: new Date(note.created).toISOString(), expires: new Date(note.expires).toISOString() };
  const markdown = `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${note.message}`;
  for (let n = 1; ; n++) {
    const name = `${note.created}-${note.from}${n === 1 ? "" : `-${n}`}.md`;
    const file = join(path, name);
    const temp = join(path, `.${name}.${process.pid}.tmp`);
    let fd: number;
    try { fd = openSync(temp, "wx"); } catch (error: any) { if (error.code === "EEXIST") continue; throw error; }
    try {
      writeFileSync(fd, markdown);
      // link fails atomically if the name exists, so a notice is never overwritten.
      try { linkSync(temp, file); return note; } catch (error: any) { if (error.code !== "EEXIST") throw error; }
    } finally {
      closeSync(fd);
      try { unlinkSync(temp); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    }
  }
}
export async function post(path: string, input: Pick<Note, "from" | "message">, report?: (warning: string) => void): Promise<Note> {
  const created = Date.now();
  const note = { from: validateName(input.from), message: checkMessage(input.message), created, expires: created + DAY * 1000 };
  await scanBoard(path, report ?? (() => {})); // reclaim expired notices
  return publish(path, note);
}

function timestamp(value: unknown): number {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new Error("Invalid timestamp.");
  return time;
}
const CAP = 64 * 1024;
/** Read at most CAP bytes from an opened regular file; undefined when it is larger or not a regular file. */
async function readCapped(file: string, report: (warning: string) => void): Promise<string | undefined> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) { report(`Skipped non-regular board file: ${file}`); return undefined; }
    const buffer = Buffer.alloc(CAP + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, null);
      if (!bytesRead) break;
      bytes += bytesRead;
    }
    if (bytes > CAP) { report(`Skipped board file over 64 KiB: ${file}`); return undefined; }
    return buffer.subarray(0, bytes).toString("utf8");
  } finally { await handle.close(); }
}
function parseNote(text: string): Note | undefined {
  try {
    const { frontmatter: f, body } = parseFrontmatter(text);
    if (typeof f.from !== "string" || !NAME.test(f.from)) return undefined;
    const note: Note = { from: f.from, message: body, created: timestamp(f.created), expires: timestamp(f.expires) };
    return note.expires > note.created ? note : undefined;
  } catch { return undefined; }
}
/** Every unexpired notice, newest first; reclaims expired files on the way. */
async function scanBoard(path: string, report: (warning: string) => void): Promise<Note[]> {
  let files: string[];
  try { files = (await readdir(path)).filter(f => f.endsWith(".md")).sort().reverse(); }
  catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
  // ponytail: scan retained files on access; add an index only if directory size makes this slow.
  const notes: Note[] = [];
  for (const name of files) {
    const file = join(path, name);
    let text: string | undefined;
    try { text = await readCapped(file, report); }
    catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
    const note = text === undefined ? undefined : parseNote(text);
    if (!note) continue;
    if (note.expires > Date.now()) notes.push(note);
    else try { await unlink(file); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
  return notes;
}
/** Recent notices, newest first; `from` is an exact name or a '*' pattern. */
export async function readBoard(path: string, filter: { from?: string; limit?: number } = {}, report: (warning: string) => void = console.warn): Promise<Note[]> {
  const limit = filter.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be 1..100.");
  const matches = filter.from === undefined ? () => true : namePattern(filter.from);
  return (await scanBoard(path, report)).filter(note => matches(note.from)).slice(0, limit);
}
/** Names that still sign retained notices: reusing one would make two agents indistinguishable on the board. */
export async function boardSenders(path: string): Promise<Set<string>> {
  return new Set((await scanBoard(path, () => {})).map(note => note.from));
}
export function formatNote(note: Note): string {
  validateName(note.from);
  return `[swarm notice] ${note.from}\n${new Date(note.created).toISOString()} · expires ${new Date(note.expires).toISOString()}\n${note.message}`;
}
