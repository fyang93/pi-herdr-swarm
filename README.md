# pi-herdr-swarm

Named pi peers inside [herdr](https://herdr.dev): four tools and an expiring shared board. No claims, leases, receipts or membership registry. Names describe roles, not permissions.

Requires Node **22.19+**, pi with `agent_settled` / `agent_before_settle`, and herdr **0.9+**. Start pi inside herdr. This extension does **not** install herdr's pi state integration; install and verify it first:

```sh
herdr integration install pi
herdr integration status
pi install git:github.com/fyang93/pi-herdr-swarm
# Or load this checkout:
pi -e ./src/index.ts
```

## Four tools

| Tool | Responsibility |
| --- | --- |
| `swarm_spawn({task, agent?, name?, model?, cwd?, detach?})` | Start a fresh peer; role goes in task. Optional agent selects a preset. Default waits for this run's binding to end; detach does not wait and its result is board-only. |
| `swarm_send({message, to?, tags?, ttl?})` | The only write tool. Omit to: **posted · board only**, no wakeup. Explicit to: commit, then native herdr steer (text + Enter). |
| `swarm_list()` | Read current agents and available presets. No automatic naming. |
| `swarm_board({from?, to?, tag?, limit?})` | Read unexpired messages; no writes, wakeups or naming. |

```typescript
swarm_spawn({ name: "auth-review", task: "You are a reviewer. Inspect auth and report findings." });
swarm_send({ to: "auth-review", message: "Also inspect token expiry.", tags: ["auth"] });
swarm_send({ message: "Research update: see reports/news.md", tags: ["research"] }); // board only
swarm_send({ to: "*news*", message: "Please inspect the research update." }); // explicit group steer
swarm_spawn({ name: "research", task: "Write findings to reports/research.md.", detach: true });
swarm_board({ from: "auth-review", tag: "result", limit: 10 });
```

Names must match `[a-z][a-z0-9_-]{0,31}`. Only send/spawn may automatically name an unnamed caller; existing names are never overwritten. The confirmed name is shown to the user. Ambiguous naming failures recheck the caller pane rather than blindly retrying.

**Addressing:** exact names are best-effort, including across projects on the same herdr instance. `*` anywhere matches the whole name (`news*`, `*news*`, `us-*-1`, `*`); repeated stars collapse, no other glob syntax. Group sends select only named agents in the same canonical project and exclude the sender. Each actual recipient is reported individually; no automatic replies, rebroadcasts or delivery retries.

**Delivery states:** `submitted` means text and Enter were written to the terminal, **not** that the peer processed or read them. `rejected` is an explicit refusal (for example `agent_blocked`); `unknown` covers timeouts, disconnected connections, server errors and malformed replies. Error codes and the source board path are retained. Busy pi agents receive native steer; this extension does not swallow input or requeue it as follow-up. If no interruption is needed, omit to.

The board is shared, **not confidential**. A message's validated envelope identifies its source; neither header nor body grants authorization or clears a waiting run.

## Projects and board retention

Project root is the real path returned by `git rev-parse --show-toplevel` from the canonical cwd. Outside Git, it is the canonical cwd itself. Missing Git, timeouts and other resolution failures are errors, not a fallback to “not Git.” Each nested repository, submodule and worktree has its own root; common Git directories do not merge projects. Own root is resolved at session startup; peers' roots are cached by canonical cwd for that session.

Default board: `<project-root>/.pi/swarm/board.sqlite`. SQLite provides concurrent local writes and a bounded busy timeout, without an added dependency or file-lock protocol. `PI_SWARM_BOARD` overrides storage (relative paths resolve from project root) and can be inherited explicitly; it does **not** alter broadcast membership. Cross-project spawn does not inherit the parent's default board.

An exact cross-project send remains on its **source** board. The envelope includes that absolute path, also shown in failure results. The recipient's ordinary `swarm_board()` does not automatically see it; inspect the source SQLite file or agree on an explicit shared `PI_SWARM_BOARD`.

- Bodies: **4000 characters**. Larger work belongs in a file; send a summary and path.
- Retention: positive seconds, default **24 hours**, maximum 365 days; automatic results expire too.
- TTL is **not** a task deadline. Expiry neither cancels work nor implies completion.
- Reads: newest first, default 20, maximum 100; model-facing text capped at 30,000 characters. Expired rows are deleted on reads/writes; dormant boards are cleaned on their next access.
- Filters are exact. In particular `to` matches the **original target field**, not a personal inbox or expanded group membership.

**TUI:** explicit action titles and short call previews; pi's native tool shell; collapsed results bounded to eight display rows with the configured expansion key. Each tool owns its result renderer. Board/send show relative retention; the one-line waiting widget does not duplicate herdr's sidebar.

## Optional presets

No bundled worker is required. Presets come from `~/.pi/agent/agents/*.md` (or `PI_CODING_AGENT_DIR/agents`) and trusted project `.pi/agents/*.md`; project presets override global ones.

```markdown
---
name: read-only
description: Read-only configuration
model: openai-codex/gpt-5.6-luna
thinking: low
tools: read, grep, find, ls
system-prompt: append
---
Report actionable findings with file paths.
```

Explicit parameters override presets; preset values override the caller's current model, thinking and selected tools. Without a preset, only these **configuration values** are inherited, not the caller's prompt or conversation history. Pi clamps thinking to the selected model. A child's unavailable requested tools are explicitly reported and task input is rejected, never silently replaced by default tools. Temporary parent extensions and their tool implementations are not copied.

Supports model, thinking, comma-separated tools, skills/skill from default skill directories, cwd, `system-prompt: append|replace`, auto-exit and disable-model-invocation. Without a system-prompt mode, the preset body prefixes task. Relative cwd resolves from the caller. No swarm tools are forced into an explicit tool selection. Fresh standalone sessions only; other CLIs and fork/lineage modes are rejected.

Trust is propagated only for the caller's exact trusted cwd; other directories may need user approval. **`--tools` controls call scope, not an OS sandbox.** Skills and prompts are instructions; real permission isolation belongs to the host or operating system.

## Waiting and limits

A waiting run means “this invocation is still bound,” not “its result has not been consumed.” Ordinary result messages never remove it. Polling uses `herdr agent get <name>` and compares its native session path with the launch file. Not-found or a different binding ends the wait; unknown, connection failures and timeouts keep it pending. Entering blocked is reported once with a pane inspection target; code never answers the dialog. Loss of binding is **not success**; the board and existing session remain evidence to inspect.

Only the **same local herdr instance** is supported. During a bound run, do not externally rename, clear or replace its name, or use `/new` or resume another session. These change the session-path binding. Cross-machine coordination and worktree orchestration are unsupported in this first version; worktree project roots remain independent. Spawner shutdown does not kill peers. For a generator/evaluator pipeline, let the evaluator spawn the generator rather than relying on an unregistered third-party result recipient.

Board commit and terminal submission are **not one transaction**. Bytes submitted in a recipient's final exit window may never be processed. With no receipt protocol there is no exactly-once or reliable-processing guarantee. Unknown submission must be inspected, not automatically retried.

An independent root exit extension can query local pending work:

```typescript
const pending = (globalThis as any)[Symbol.for("pi-herdr-swarm/pending-count")]?.() ?? 0;
// Also check ctx.hasPendingMessages() before exiting.
```

For trading: parallelize **research**, but let **one agent place orders**. This is a caller convention, not an enforced security boundary. Tests perform no trading.

## Checks

```sh
npm install --ignore-scripts
npm run check
npm test
```

Tests include SQLite concurrency, tool boundaries, Git roots, naming, delivery states, pi's native tool shell and actual AgentSession configuration. The isolated herdr demo is being updated with the lifecycle model; do not run it against a trading session.
