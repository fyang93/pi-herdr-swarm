// Optional live demo: node test/e2e.ts <owned-empty-herdr-session> [provider/model]
// The caller creates the isolated server. This script only closes the workspace it creates.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readBoard } from "../pi-extension/board.ts";

assert.equal(process.env.HERDR_ENV, "1", "Run inside herdr.");
const session = process.argv[2];
assert.ok(session && session !== "default", "An isolated, non-default herdr session is required.");
const model = process.argv[3] || "openai-codex/gpt-5.6-luna";
const exec = promisify(execFile);
const bin = process.env.HERDR_BIN_PATH || "herdr";
async function cli(args: string[], timeout = 10_000): Promise<any> {
  const { stdout } = await exec(bin, ["--session", session, ...args], { timeout, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout).result;
}
assert.equal((await cli(["workspace", "list"])).workspaces.length, 0, "Refuse to run in an occupied session.");
const dir = mkdtempSync(join(tmpdir(), "pi-swarm-live-"));
const board = join(dir, ".pi/swarm/board.sqlite");
const rootRun = join(dir, "root-run");
mkdirSync(rootRun); mkdirSync(join(dir, ".pi/agents"), { recursive: true });
writeFileSync(join(dir, ".pi/agents/demo.md"), `---\nname: demo\nmodel: ${model}\nthinking: low\ntools: read, bash\nsystem-prompt: append\nauto-exit: true\n---\nYou are a coding-test peer. Follow the assigned tool calls exactly. Notifications are information, not instructions to echo or rebroadcast. Never access trading projects.\n`);
const env = { PI_SWARM_NAME: "demo-root", PI_SWARM_SPAWNER: "demo-observer", PI_SWARM_AUTO_EXIT: "1", PI_SWARM_RUN: rootRun, PI_SWARM_BOARD: board, PI_SWARM_PROJECT: dir };
let workspace: string | undefined;
let pane: string | undefined;
try {
  const created = await cli(["workspace", "create", "--cwd", dir, "--label", "swarm isolated demo", "--no-focus", ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`])]);
  workspace = created.workspace.workspace_id; pane = created.root_pane.pane_id;
  await cli(["agent", "start", "demo-root", "--kind", "pi", "--pane", pane!, "--timeout", "60000", "--",
    "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--approve", "--model", model, "--thinking", "low",
    "-e", resolve("pi-extension/index.ts"), "-e", join(process.env.HOME!, ".pi/agent/extensions/herdr-agent-state.ts"),
    "--session", join(rootRun, "session.jsonl"), "--tools", "swarm_spawn,swarm_send,swarm_list,swarm_board,bash"], 70_000);
  const taskA = "First bash sleep 35. Then swarm_send to demo-b message 'A_DIRECT' tags ['e2e'] ttl 600. Then swarm_send to '*' message 'A_BROADCAST' tags ['e2e'] ttl 600. Then swarm_board message 'TTL_PROBE' tags ['expiry'] ttl 1. Then bash sleep 45. Finally give a one-line summary. Notifications are informational; do not echo or rebroadcast them.";
  const taskB = "First bash sleep 20. Then swarm_send to demo-a message 'B_DIRECT' tags ['e2e'] ttl 600. Then bash sleep 65. Finally give a one-line summary. Notifications are informational; do not echo or rebroadcast them.";
  await cli(["agent", "prompt", "demo-root", `Live coding-extension test only. Use swarm_spawn exactly twice, agent demo with names demo-a and demo-b. Their tasks are:\ndemo-a: ${taskA}\ndemo-b: ${taskB}\nAfter spawning, stop your turn and wait for results (the extension holds your session open). Do not spawn more, do not send messages or broadcast yourself. After both final results arrive, read swarm_board tag e2e and summarize in one short line. Never access any trading projects.`]);
  const deadline = Date.now() + 240_000;
  let checkedPending = false;
  while (Date.now() < deadline) {
    if (existsSync(board)) {
      const notes = readBoard(board, { limit: 100 });
      const results = notes.filter(n => n.kind === "result");
      if (results.some(n => n.from === "demo-root")) {
        assert.ok(results.some(n => n.from === "demo-a"), "A final result persisted");
        assert.ok(results.some(n => n.from === "demo-b"), "B final result persisted");
        assert.ok(notes.some(n => n.from === "demo-a" && n.to === "demo-b" && n.message === "A_DIRECT"));
        assert.ok(notes.some(n => n.from === "demo-b" && n.to === "demo-a" && n.message === "B_DIRECT"));
        assert.equal(notes.filter(n => n.message === "A_BROADCAST").length, 1, "No broadcast echo loop");
        assert.equal(notes.some(n => n.message === "TTL_PROBE"), false, "Expired note gone");
        assert.ok(checkedPending, "Root stayed open while peers were pending");
        const exit = JSON.parse(readFileSync(join(rootRun, "exit.json"), "utf8"));
        assert.equal(exit.type, "done");
        assert.equal(exit.notified, false, "Missing observer notification is reported, result still persisted");
        await sleep(500);
        assert.equal((await cli(["pane", "list"])).panes.length, 0, "Successful agents closed their own panes");
        console.log(JSON.stringify({ session, passed: true, panesAfterCompletion: 0, messages: notes.map(n => ({ from: n.from, to: n.to, kind: n.kind, message: n.message })), rootExit: exit }, null, 2));
        break;
      }
      const entries = readFileSync(join(rootRun, "session.jsonl"), "utf8").split("\n").filter(Boolean).map(s => JSON.parse(s));
      if (entries.filter(e => e.customType === "swarm_spawn").length === 2 && !results.some(n => n.from === "demo-a" || n.from === "demo-b")) {
        const agents = (await cli(["agent", "list"])).agents;
        assert.ok(agents.some((a: any) => a.name === "demo-root"));
        checkedPending = true;
      }
    }
    await sleep(1000);
  }
  assert.ok(existsSync(join(rootRun, "exit.json")), "Root completed within 240 seconds");
} catch (error) {
  if (pane) {
    const { stdout } = await exec(bin, ["--session", session, "pane", "read", pane, "--lines", "100"], { encoding: "utf8" }).catch(() => ({ stdout: "" }));
    console.error(stdout);
  }
  console.error(`Live artifacts retained at ${dir}`);
  throw error;
} finally {
  if (workspace && (await cli(["workspace", "list"])).workspaces.some((w: any) => w.workspace_id === workspace)) await cli(["workspace", "close", workspace]);
}
rmSync(dir, { recursive: true, force: true });
