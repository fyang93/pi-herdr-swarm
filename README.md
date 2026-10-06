# pi-herdr-swarm

A swarm of [pi](https://github.com/badlogic/pi-mono) agents inside [herdr](https://herdr.dev). Three concepts: **names** (herdr's online addresses), **messages** pushed to exact names, and **sessions** (where results live). Delegation and coordination are compositions of these; there is no implicit hierarchy. Spawning returns immediately; its result arrives when the run ends. Peers can message one another; presets can restrict which roles they may spawn.

## Install

Requires Node 22.19+, herdr >=0.9.0 on Linux/macOS (>=0.9.1 on Windows), and pi 0.99.2+ running inside herdr. Supervision depends on herdr's pi integration reporting each session's path: run `herdr integration install pi` once (pi sessions started before that need a restart); the extension warns when it is missing.

```sh
pi install git:github.com/fyang93/pi-herdr-swarm
```

## Tools

```typescript
swarm_spawn({ name: "review-1", task: "Review this change and report findings." });
swarm_spawn({ agent: "monitor", task: "Keep an eye on health.json and tell me if the service status changes." }); // example preset, see Presets
swarm_spawn({ resume: "review-1", task: "Now review the follow-up change." });

swarm_send({ to: "review-1", message: "Also check input validation." });
swarm_send({ to: ["review-1", "review-2"], message: "The change is ready." }); // explicit recipients only
swarm_send({ to: "review-1", message: "Should we preserve the old API?", wait: true }); // stop until review-1 replies

swarm_list();
```

| Tool | Does |
|---|---|
| `swarm_spawn({task, agent?, name?, model?, cwd?})` | Starts a fresh pi in a new pane and returns immediately. Select a preset role with `agent`, or describe the role in `task`. The peer stays running while its task runs, then exits and returns its final reply. Communicate with `swarm_send` during the task. Close its pane to stop it. |
| `swarm_spawn({resume, task})` | Continues one of your ended runs with its full context and saved configuration. |
| `swarm_send({message, to, wait?})` | Requires `to`: an exact name or a nonempty array of exact names (any project). No wildcards, recipient discovery, or broadcast. No separate message store. Reports each recipient as `submitted`, `rejected` or `unknown`; never retries; never starts a process. |
| `swarm_list()` | Your name, online agents (`name · role/task · state · pane` when a pane title exists), and available presets. |

## Online identity

Every session inside herdr gets a name at startup, before its first tool call. Existing herdr names are preserved; unnamed `--swarm-agent reviewer` sessions use `availableName` (e.g. `reviewer-1`), and other unnamed sessions use `swarm-<pane>`.

Swarm sessions self-report through `herdr pane report-metadata <pane> --source pi-herdr-swarm --title ...`: preset launches publish the preset name and description; spawned/resumed peers publish their saved preset (or `peer`) and a bounded first-sentence/line summary of the current task. Herdr exposes this as **`title`** in `herdr agent list` (not `terminal_title`); herdr bounds the display title (80 characters in 0.9.1). `swarm_list` and its UI show it beside each online name, across projects; agents without a title keep the old name/state/pane display. Plain manually launched pi sessions do not publish a title. The extension clears its own title on shutdown, reload and session replacement, and re-reports it only for the applicable session. There is no separate identity/task registry or state file.

## How a run works

1. **Spawn.** A new pane opens by splitting the roomiest of your pane and your peers' panes, so peers tile together (a background tab only when none can be split into two usable halves) and pi starts there with the task. The task is sent verbatim, without a prompt wrapper; it defines what work to do and when to report. You keep working; a compact status widget shows one row per running peer: elapsed `mm:ss`, name (preset), and herdr status. While `working`, it also shows the latest unfinished tool (e.g. `bash`, `read`) from the peer's active session branch. It refreshes every second and disappears when no peers remain; elapsed time comes from the existing spawn record, so resume starts a new clock.
2. **Work.** The peer can message helpers or spawn them when its preset allows it. Long-running monitoring scripts keep the task active and can send updates with codemode's `tools.swarm_send()`; keeping a pane open alone does not keep monitoring.
3. **End.** Peers exit and close their pane when the task settles. Escape, an outstanding `wait:true`, or an editor draft keeps it open. Close a pane to stop a running task.
4. **Result.** When a peer session ends, the extension reads its final reply and delivers it into your session as a single `swarm_result` message. The peer's system prompt tells it so and asks it to restate the whole result in its last reply, even after answering a later message. It starts a reply when you are idle, or enters at the next safe turn boundary while you are working; no separate `finished` notice is sent. Clearing the input queue does not discard results. A result already handed to pi may arrive on the branch you navigate to; Escape prevents its automatic reply, not its archival.

Your waits survive restarts: they are derived from your own session. A peer waits for its own helpers before exiting; start long-running monitors from a session that will remain available. A host extension that auto-exits can read the same pending count:

```typescript
const pending = (globalThis as any)[Symbol.for("pi-herdr-swarm/pending-count")]?.() ?? 0;
```

## Waiting and reports

`swarm_send({to: "peer-name", message: "question", wait: true})` sends an ordinary message via `herdr agent prompt` with a header such as `[swarm message] a → b (waiting for your reply)`, stops this turn and prevents automatic exit. It works in either direction between any named peers, not only between a peer and its spawner. Reply with ordinary `swarm_send`. With an array of recipients, the first submitted recipient to reply resumes the sender. Non-swarm user input also ends the wait so a human can take over; messages from unrelated swarm peers do not. If no submission succeeds, the sender does not wait.

The waiting state is derived from the sender's own active session branch: its last successful `wait:true` send and subsequent incoming swarm messages. It survives restart and is shared by the pending-count hook, automatic exit, result classification and running-peer status widget. There are no signal files or cross-process waiting records. A session closed while waiting reports an incomplete result, not a final reply. Messages retain ordinary herdr delivery semantics (not the durable result-delivery contract); clearing Pi's input queue can discard a queued message. Call `wait:true` directly, not inside another tool or codemode script.

For multiple recipients, pass their exact names as an array to `swarm_send`. Messages are at most 4000 characters; write detailed reports or persistent findings to ordinary files, then send a summary and path.

## Presets

Optional configuration in `~/.pi/agent/agents/*.md` or a trusted project's `.pi/agents/*.md`: `description`, `model`, `thinking`, `cwd`, `requires-tools`, `can-spawn`, and a body that is appended to the peer's system prompt (its role and rules). Trusted project presets override user presets of the same name. Pi loads tools, extensions and skills as usual. `can-spawn` is an extension-enforced boolean, default `true`: `false` forbids all `swarm_spawn` calls, including peers without a preset and resumes. `true` permits delegation to any preset or an ad-hoc peer. The policy is saved for resumed peers and also applied by `pi --swarm-agent <name>`; malformed policy fails closed. `requires-tools` lists already registered tools the role depends on (`[codemode]`; a single name or comma-separated string also works); the peer activates them, and reports a missing one rather than installing it. Without a preset, a peer inherits your current model and thinking. To start a session as a preset outside `swarm_spawn` (say, from a script), run `pi --swarm-agent <name>`; it applies the model, thinking, role and required tools, while `cwd` applies only when spawning.

For script-launched sessions that should finish without a host auto-exit extension:

```sh
pi --swarm-agent reviewer --swarm-exit "Review this change and report findings."
```

`--swarm-exit` opts this session into the same settled-task exit and pane closing as a spawned peer. It waits for its peers and outstanding `wait:true` before exiting; errors are also terminal, while aborted turns and editor drafts keep it open. Submitted input, including plain tasks pushed by `herdr agent prompt`, is more work: automatic exit still happens after it settles. Escape cancels the current exit candidate; an unsubmitted editor draft also keeps the pane open. A subsequent submitted task can complete and exit normally. Without the flag, starting a preset remains interactive; no spawner or result recipient is implied by the flag. Spawned peers retain their existing completion behavior.

```markdown
---
name: reviewer
description: Careful code review
thinking: high
can-spawn: false
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
4. **Permissions.** Roles grant nothing. `can-spawn` guards `swarm_spawn`, not arbitrary shell commands or manual sessions; security isolation belongs to the host.

## Development

```sh
npm install --ignore-scripts
npm run check && npm test
node test/e2e.ts   # inside herdr: a private server, no model requests
```
