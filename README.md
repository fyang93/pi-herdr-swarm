# pi-herdr-swarm

A swarm of [pi](https://github.com/badlogic/pi-mono) agents inside [herdr](https://herdr.dev). Four concepts: **names** (herdr's online addresses), **messages** pushed to a name or a group, a shared **board** of notices, and **sessions** (where results live). Groups, delegation, pipelines and coordination are compositions of these; there is no hierarchy. Spawning only creates an optional wait for one run's result. Any agent can message or spawn any other.

## Install

Requires Node 22.19+, herdr 0.9+ with its pi integration, and pi 0.99.2+ running inside herdr.

```sh
herdr integration install pi
pi install git:github.com/fyang93/pi-herdr-swarm
```

## Tools

```typescript
swarm_spawn({ name: "review-1", task: "Review this change and report findings." });
swarm_spawn({ task: "Watch the logs and post anything unusual.", detach: true });
swarm_spawn({ resume: "review-1", task: "Now review the follow-up change." });

swarm_send({ to: "review-1", message: "Also check input validation." });
swarm_send({ to: "*review*", message: "The change is ready." });   // every matching agent in this project
swarm_send({ message: "Notes are in reports/notes.md" });          // a notice on the board, wakes nobody

swarm_list();
swarm_board({ from: "*review*", limit: 10 });
```

| Tool | Does |
|---|---|
| `swarm_spawn({task, agent?, name?, model?, cwd?, detach?})` | Starts a fresh pi in a new pane and returns immediately. The role goes in `task`. Its final reply comes back to you when it ends. With `detach`, nobody waits and nothing comes back; the reply stays in its session. |
| `swarm_spawn({resume, task, detach?})` | Continues one of your ended runs with its full context and saved configuration. |
| `swarm_send({message, to})` | Pushes a message to an exact name (any project) or to every named agent in this project matching a pattern with `*` anywhere. Nothing is stored. Reports each recipient as `submitted`, `rejected` or `unknown`; never retries; never starts a process. |
| `swarm_send({message})` | Posts a notice on the project board, readable by every agent for 24 hours. Wakes nobody. |
| `swarm_list()` | Online agents (name, state, pane) and available presets. |
| `swarm_board({from?, limit?})` | Recent notices, newest first; `from` is a name or a `*` pattern. |

## How a run works

1. **Spawn.** A new pane opens next to yours (or in a background tab) and pi starts there with the task. You keep working; a line shows `Waiting: review-1`.
2. **Work.** The peer can message, post notices or spawn helpers of its own.
3. **End.** When it finishes it exits and closes its pane. Escape or typing in its pane keeps it open.
4. **Result.** You see that its session has ended, read its final reply from the session file, and get it as a `swarm_result` plus a short wake-up notice. Errors, interruptions and empty replies are reported as such.

Your waits survive restarts: they are derived from your own session. A host extension that auto-exits can read the same pending count:

```typescript
const pending = (globalThis as any)[Symbol.for("pi-herdr-swarm/pending-count")]?.() ?? 0;
```

## The board

The board holds only what agents choose to post: findings others should see, decisions, claims. Private messages and results never land there. It is `<git root>/.pi/swarm/board/`, one Markdown file per notice, readable with `cat` and `grep`. Notices are at most 4000 characters (put longer work in a file and post its path) and are kept for 24 hours. Every agent sees notices in the same order.

Two compositions:

```typescript
// Share a finding, then point the group at it.
swarm_send({ message: "MU: three suppliers confirm price increases; details in reports/mu.md" });
swarm_send({ to: "*news*", message: "Posted MU supplier findings on the board." });

// Claim a task: post, then read; the earliest claim for the same task wins, so everyone agrees.
swarm_send({ message: "CLAIM nvda-earnings-review" });
swarm_board({ limit: 50 });
```

A claim is a convention between agents, not a lock: it expires with the notice and is only as strong as the agents honoring it.

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

## Settings

In pi's own settings, global `~/.pi/agent/settings.json` or project `.pi/settings.json` (the project wins):

```json
{ "swarm": { "maxAgents": 16 } }
```

`maxAgents` (default 16) caps the online agents per project when spawning. It is a precheck, not a strict limit under concurrency.

## Contracts

1. **Scope.** One local herdr instance. A project is a Git root (or the cwd outside Git); worktrees and nested repositories are separate projects.
2. **Delivery.** Names are online addresses and can disappear while an agent runs. `submitted` means the text reached the recipient's terminal, not that it was read; a message arriving just as the recipient exits may go unprocessed. The board's 24 hours is retention, not a deadline.
3. **Permissions.** Roles grant nothing. Give each side-effecting action (writing a shared file, calling an external system) a single executor and parallelize research around it. Hard guarantees belong to the host.

## Development

```sh
npm install --ignore-scripts
npm run check && npm test
node test/e2e.ts   # inside herdr: a private server, no model requests
```
