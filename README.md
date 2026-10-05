# pi-herdr-swarm

A swarm of [pi](https://github.com/badlogic/pi-mono) agents inside [herdr](https://herdr.dev). Three concepts: **names** (herdr's online addresses), **messages** pushed to a name or a group, and **sessions** (where results live). Groups, delegation, pipelines and coordination are compositions of these; there is no hierarchy. Spawning returns immediately; its result arrives when the run ends. Any agent can message or spawn any other.

## Install

Requires Node 22.19+, herdr >=0.9.0 on Linux/macOS (>=0.9.1 on Windows), and pi 0.99.2+ running inside herdr. Supervision depends on herdr's pi integration reporting each session's path; the extension installs it when missing (pi sessions started before that need a restart).

```sh
pi install git:github.com/fyang93/pi-herdr-swarm
```

## Tools

```typescript
swarm_spawn({ name: "review-1", task: "Review this change and report findings." });
swarm_spawn({ agent: "monitor", task: "Keep an eye on health.json and tell me if the service status changes." }); // example preset, see Presets
swarm_spawn({ resume: "review-1", task: "Now review the follow-up change." });

swarm_send({ to: "review-1", message: "Also check input validation." });
swarm_send({ to: "*review*", message: "The change is ready." });   // every matching agent in this project
swarm_send({ to: "*", message: "Notes are in reports/notes.md" }); // announce to all other named agents in this project

swarm_list();
```

| Tool | Does |
|---|---|
| `swarm_spawn({task, agent?, name?, model?, cwd?})` | Starts a fresh pi in a new pane and returns immediately. Select a preset role with `agent`, or describe the role in `task`. The peer stays running while its task runs, then exits and returns its final reply. Communicate with `swarm_send` during the task. Close its pane to stop it. |
| `swarm_spawn({resume, task})` | Continues one of your ended runs with its full context and saved configuration. |
| `swarm_send({message, to})` | Requires `to`. Pushes a message to an exact name (any project) or to every named agent in this project matching a pattern with `*` anywhere. No separate message store. Reports each recipient as `submitted`, `rejected` or `unknown`; never retries; never starts a process. |
| `swarm_list()` | Your name, online agents (name, state, pane), and available presets. |

## How a run works

1. **Spawn.** A new pane opens by splitting the roomiest of your pane and your peers' panes, so peers tile together (a background tab only when none can be split into two usable halves) and pi starts there with the task. The task is sent verbatim, without a prompt wrapper; it defines what work to do and when to report. You keep working; a line shows `Waiting: review-1`.
2. **Work.** The peer can message or spawn helpers of its own. Long-running monitoring scripts keep the task active and can send updates with codemode's `tools.swarm_send()`; keeping a pane open alone does not keep monitoring.
3. **End.** Peers exit and close their pane when the task settles. Escape or typing in their pane keeps it open. Close a pane to stop a running task.
4. **Result.** When a peer session ends, the extension reads its final reply and delivers it into your session as a single `swarm_result` message. The peer's system prompt says so, so its last reply restates the whole result even after it answered a later message. It starts a reply when you are idle, or enters at the next safe turn boundary while you are working; no separate `finished` notice is sent. Clearing the input queue does not discard results. A result already handed to pi may arrive on the branch you navigate to; Escape prevents its automatic reply, not its archival.

Your waits survive restarts: they are derived from your own session. A peer waits for its own helpers before exiting; start long-running monitors from a session that will remain available. A host extension that auto-exits can read the same pending count:

```typescript
const pending = (globalThis as any)[Symbol.for("pi-herdr-swarm/pending-count")]?.() ?? 0;
```

## Announcements and reports

Use `swarm_send` with `to: "*"` for project-wide announcements, or a name pattern for a group. Broadcasts reach currently online named agents other than the sender, not agents that join later. Messages are at most 4000 characters; write detailed reports or persistent findings to ordinary files, then send a summary and path.

```typescript
// After writing reports/flaky.md, notify the group.
swarm_send({ to: "*test*", message: "The flaky test comes from a shared temp dir; details in reports/flaky.md" });

swarm_send({ to: "*", message: "Taking: migrate the config loader" });
```

An announcement is not a lock: two agents can announce the same work at nearly the same moment and both proceed. When only one executor may act, the host must enforce it.

## Presets

Optional configuration in `~/.pi/agent/agents/*.md` or a trusted project's `.pi/agents/*.md`: `description`, `model`, `thinking`, `cwd`, `requires-tools`, and a body that is appended to the peer's system prompt (its role and rules). Trusted project presets override user presets of the same name. Presets configure; they never restrict tools, extensions or skills, which pi loads as usual. `requires-tools` lists already registered tools the role depends on (`[codemode]`; a single name or comma-separated string also works); the peer activates them, and reports a missing one rather than installing it. Without a preset, a peer inherits your current model and thinking. To start a session as a preset outside `swarm_spawn` (say, from a script), run `pi --swarm-agent <name>`; it applies the model, thinking, role and required tools, while `cwd` applies only when spawning.

```markdown
---
name: reviewer
description: Careful code review
thinking: high
---
Report actionable findings with file paths.
```

`examples/agents/monitor.md` is an example preset (a codemode watch loop with `requires-tools: [codemode]`), not loaded by default; copy it into an agents directory to use it.

## Settings

In pi's own settings, global `~/.pi/agent/settings.json` or project `.pi/settings.json` (the project wins):

```json
{ "swarm": { "maxAgents": 16 } }
```

`maxAgents` (default 16) caps the online agents per project when spawning. It is a precheck, not a strict limit under concurrency.

## Contracts

1. **Scope.** One local herdr instance. A project is a Git root (or the cwd outside Git); worktrees and nested repositories are separate projects.
2. **Delivery.** Names are online addresses and can disappear while an agent runs. `submitted` means the text reached the recipient's terminal, not that it was read; a message arriving just as the recipient exits may go unprocessed.
3. **Host.** Interactive pi (TUI). Idle reload retains in-flight results and cancellation; reloading through the SDK or RPC while a turn runs remains unsupported.
4. **Permissions.** Roles grant nothing. Give each side-effecting action (writing a shared file, calling an external system) a single executor and parallelize research around it. Hard guarantees belong to the host.

## Development

```sh
npm install --ignore-scripts
npm run check && npm test
node test/e2e.ts   # inside herdr: a private server, no model requests
```
