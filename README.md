# pi-herdr-swarm

A swarm of [pi](https://github.com/badlogic/pi-mono) agents inside [herdr](https://herdr.dev). Four concepts: **names** (herdr's online addresses), **messages**, an expiring **board**, and **sessions** (where results live). Groups, delegation and pipelines are compositions of these; there is no hierarchy. Spawning only creates an optional wait for one run's result. Any agent can message or spawn any other.

## Install

Requires Node 22.19+, herdr 0.9+ with its pi integration, and pi running inside herdr.

```sh
herdr integration install pi
pi install git:github.com/fyang93/pi-herdr-swarm
```

## Tools

```typescript
swarm_spawn({ name: "review-1", task: "Review this change and report findings." });
swarm_spawn({ task: "Watch the logs for errors.", detach: true });
swarm_spawn({ resume: "review-1", task: "Now review the follow-up change." });

swarm_send({ to: "review-1", message: "Also check input validation." });
swarm_send({ to: "*review*", message: "The change is ready." });   // every matching agent in this project
swarm_send({ message: "Notes are in reports/notes.md" });          // board only, wakes nobody

swarm_list();
swarm_board({ from: "review-1", limit: 10 });
```

| Tool | Does |
|---|---|
| `swarm_spawn({task, agent?, name?, model?, cwd?, detach?})` | Starts a fresh pi in a new pane and returns immediately. The role goes in `task`. Its final reply comes back to you when it ends; with `detach` it goes to the board only and nobody waits. |
| `swarm_spawn({resume, task, detach?})` | Continues one of your ended runs with its full context and saved configuration. |
| `swarm_send({message, to?})` | Writes to the board, then delivers to `to`: an exact name (any project), or a pattern with `*` anywhere (same project only). Omit `to` to only post. Reports each recipient as `submitted`, `rejected` or `unknown`; never retries. Never starts a process. |
| `swarm_list()` | Online agents (name, state, pane) and available presets. |
| `swarm_board({from?, to?, limit?})` | Recent unexpired messages, newest first. |

## How a run works

1. **Spawn.** A new pane opens next to yours (or in a background tab) and pi starts there with the task. You keep working; a line shows `Waiting: review-1`.
2. **Work.** The peer can message, broadcast or spawn helpers of its own.
3. **End.** When it finishes, it posts its final reply to the board, exits and closes its pane. Escape or typing in its pane keeps it open.
4. **Result.** You see that its session has ended, read the final reply from its session file, and get it as a `swarm_result` plus a short wake-up notice. Errors, interruptions and empty replies are reported as such.

Your waits survive restarts: they are derived from your own session. A host extension that auto-exits can read the same pending count:

```typescript
const pending = (globalThis as any)[Symbol.for("pi-herdr-swarm/pending-count")]?.() ?? 0;
```

## Presets

Optional configuration in `~/.pi/agent/agents/*.md` or a trusted project's `.pi/agents/*.md`: `description`, `model`, `thinking`, `cwd`, and a body that is appended to the peer's system prompt (its role and rules). Presets configure; they never restrict tools, extensions or skills, which pi loads as usual. Without a preset, a peer inherits your current model and thinking.

```markdown
---
name: reviewer
description: Careful code review
thinking: high
---
Report actionable findings with file paths.
```

## The board

`<git root>/.pi/swarm/board/` holds one Markdown file per message, readable with `cat` and `grep`. Messages are at most 4000 characters (put longer work in a file and send its path) and are kept for 24 hours.

## Contracts

1. **Scope.** One local herdr instance. A project is a Git root (or the cwd outside Git); worktrees and nested repositories are separate projects. `PI_SWARM_MAX_AGENTS` (default 16) caps spawning per project as a precheck, not a strict limit under concurrency.
2. **Delivery.** Names are online addresses and can disappear while an agent runs. `submitted` means the text reached the recipient's terminal, not that it was read; a message arriving just as the recipient exits may go unprocessed. The board's 24 hours is retention, not a deadline.
3. **Permissions.** Roles grant nothing. Give each side-effecting action (writing a shared file, calling an external system) a single executor and parallelize research around it. Hard guarantees belong to the host.

## Development

```sh
npm install --ignore-scripts
npm run check && npm test
node test/e2e.ts   # inside herdr: a private server, no model requests
```
