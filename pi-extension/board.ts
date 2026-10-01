import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface Note {
  from: string;
  to: string;
  message: string;
  tags: string[];
  kind: "message" | "result";
  created: number;
  expires: number;
}
export const DAY = 86_400;
export const MESSAGE_LIMIT = 4000;
export const boardPath = (cwd: string) => resolve(cwd, process.env.PI_SWARM_BOARD || ".pi/swarm/board.sqlite");

/** SQLite handles cross-process writers; no file locks or coordination protocol. */
function withBoard<T>(path: string, action: (db: DatabaseSync) => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout=5000;
      PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS notes (
        sender TEXT NOT NULL, recipient TEXT NOT NULL, message TEXT NOT NULL,
        tags TEXT NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL
      );`);
    // ponytail: scan a day's messages; add indexes only if board traffic makes this slow.
    db.prepare("DELETE FROM notes WHERE expires <= ?").run(Date.now());
    return action(db);
  } finally { db.close(); }
}

export function post(path: string, input: Pick<Note, "from" | "to" | "message"> & Partial<Pick<Note, "tags" | "kind">>, ttl = DAY): Note {
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 365 * DAY) throw new Error("ttl must be > 0 and <= 365 days (seconds).");
  if (!input.from.trim() || !input.to.trim() || !input.message.trim()) throw new Error("Sender, recipient and message must be nonempty.");
  if (input.message.length > MESSAGE_LIMIT) throw new Error(`Message exceeds ${MESSAGE_LIMIT} characters; write the body to a file, then send a summary and file path.`);
  const created = Date.now();
  const note: Note = { ...input, tags: input.tags ?? [], kind: input.kind ?? "message", created, expires: created + ttl * 1000 };
  withBoard(path, db => db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(note.from, note.to, note.message, JSON.stringify(note.tags), note.kind, note.created, note.expires));
  return note;
}

export function readBoard(path: string, filter: { from?: string; to?: string; tag?: string; since?: number; limit?: number } = {}): Note[] {
  const limit = filter.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be 1..100.");
  return withBoard(path, db => db.prepare(`SELECT sender AS "from", recipient AS "to", message, tags, kind, created, expires
    FROM notes WHERE expires > ? AND (? IS NULL OR sender = ?) AND (? IS NULL OR recipient = ?)
    AND created >= ? AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?))
    ORDER BY created DESC, rowid DESC LIMIT ?`)
    .all(Date.now(), filter.from ?? null, filter.from ?? null, filter.to ?? null, filter.to ?? null,
      filter.since ?? 0, filter.tag ?? null, filter.tag ?? null, limit)
    .map(row => ({ ...row, tags: JSON.parse(row.tags as string) }) as Note));
}

export function formatNote(note: Note): string {
  return `[swarm ${note.kind}] ${note.from} → ${note.to}${note.tags.length ? ` #${note.tags.join(" #")}` : ""}\n` +
    `${new Date(note.created).toISOString()} · expires ${new Date(note.expires).toISOString()}\n${note.message}`;
}
