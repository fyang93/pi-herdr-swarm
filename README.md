# pi-herdr-swarm

A swarm of [pi](https://github.com/badlogic/pi-mono) agents inside [herdr](https://herdr.dev). Four concepts: **names** (herdr's online addresses), **messages** pushed to a name or a group, a shared **board** of notices, and **sessions** (where results live). Groups, delegation, pipelines and coordination are compositions of these; there is no hierarchy. Spawning only creates an optional wait for one run's result. Any agent can message or spawn any other.

## Install

Requires Node 22.19+, herdr 0.9+ and pi 0.99.2+ running inside herdr. Supervision depends on herdr's pi integration reporting each session's path; the extension installs it when missing (pi sessions started before that need a restart).

```sh
pi install git:github.com/fyang93/pi-herdr-swarm
```

## Tools

```typescript
swarm_spawn({ name: "review-1", task: "Review this change and report findings." });
swarm_spawn({ task: "Watch the logs and post anything unusual.", detach: true });
swarm_spawn({ resume: "review-1", task: "Now review the follow-up change." });

swarm_send({ to: "review-1", message: "Also check input validation." });
swarm_send({ to: "*review*", message: "The change is ready." });   // every matching agent in this project
swarm_board({ message: "Notes are in reports/notes.md" });         // a notice on the board, wakes nobody

swarm_list();
swarm_board({ from: "*review*", limit: 10 });
```

| Tool | Does |
|---|---|
| `swarm_spawn({task, agent?, name?, model?, cwd?, detach?})` | Starts a fresh pi in a new pane and returns immediately. The role goes in `task`. Its final reply comes back to you when it ends. With `detach`, nobody waits and nothing comes back; the reply stays in its session. |
| `swarm_spawn({resume, task, detach?})` | Continues one of your ended runs with its full context and saved configuration. |
| `swarm_send({message, to})` | Requires `to`. Pushes a message to an exact name (any project) or to every named agent in this project matching a pattern with `*` anywhere. Nothing is stored. Reports each recipient as `submitted`, `rejected` or `unknown`; never retries; never starts a process. |
| `swarm_board({message})` | Posts a notice on the project board, readable by every agent for 24 hours. Wakes nobody. `from` and `limit` are ignored when posting. |
| `swarm_list()` | Online agents (name, state, pane) and available presets. |
| `swarm_board({from?, limit?})` | Without `message`, reads recent notices, newest first (20 default, 100 max); `from` is a name or a `*` pattern. |

## How a run works

1. **Spawn.** A new pane opens by splitting the roomiest of your pane and your peers' panes, so peers tile together (a background tab only when none can be split into two usable halves) and pi starts there with the task. You keep working; a line shows `Waiting: review-1`.
2. **Work.** The peer can message, post notices or spawn helpers of its own.
3. **End.** When it finishes it exits and closes its pane. Escape or typing in its pane keeps it open.
4. **Result.** You see that its session has ended, read its final reply from the session file, and get it as a `swarm_result` plus a short wake-up notice. Errors, interruptions and empty replies are reported as such.

Your waits survive restarts: they are derived from your own session. A host extension that auto-exits can read the same pending count:

```typescript
const pending = (globalThis as any)[Symbol.for("pi-herdr-swarm/pending-count")]?.() ?? 0;
```

## The board

The board holds only what agents choose to post: findings others should see, decisions, what each is working on. Private messages and results never land there. It is `<git root>/.pi/swarm/board/`, one Markdown file per notice, readable with `cat` and `grep`. Notices are at most 4000 characters (put longer work in a file and post its path) and are kept for 24 hours.

Two compositions:

```typescript
// Share a finding, then point the group at it.
swarm_board({ message: "The flaky test comes from a shared temp dir; details in reports/flaky.md" });
swarm_send({ to: "*test*", message: "Posted the flaky-test finding on the board." });

// Announce what you are taking on, so others can see it before starting the same work.
swarm_board({ message: "Taking: migrate the config loader" });
```

An announcement is not a lock: two agents can announce the same work at nearly the same moment and both proceed. When only one executor may act, the host must enforce it.

## Presets

Optional configuration in `~/.pi/agent/agents/*.md` or a trusted project's `.pi/agents/*.md`: `description`, `model`, `thinking`, `cwd`, and a body that is appended to the peer's system prompt (its role and rules). Presets configure; they never restrict tools, extensions or skills, which pi loads as usual. Without a preset, a peer inherits your current model and thinking. To start a session as a preset outside `swarm_spawn` (say, from a script), run `pi --swarm-agent <name>`.

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
3. **Host.** Interactive pi (TUI). Reloading through the SDK or RPC while a turn runs is not supported: the TUI refuses it, and a result read just before could be delivered twice.
4. **Permissions.** Roles grant nothing. Give each side-effecting action (writing a shared file, calling an external system) a single executor and parallelize research around it. Hard guarantees belong to the host.

## Development

```sh
npm install --ignore-scripts
npm run check && npm test
node test/e2e.ts   # inside herdr: a private server, no model requests
```
