# pi-herdr-swarm

Named peer agents for [pi](https://pi.dev) inside [herdr](https://herdr.dev). Four tools, an expiring shared board, no claim/lease/acknowledgement protocol. Spawning is a convention, not a permission hierarchy.

Requires Node **22.19+**, pi with `agent_settled` / `agent_before_settle`, and herdr **0.9+**. Install herdr's pi state integration (`herdr integration install pi`), then start pi inside herdr.

```sh
pi install git:github.com/fyang93/pi-herdr-swarm
# Or try this checkout without installing:
pi -e ./pi-extension/index.ts
```

## Tools

| Tool | What it does |
| --- | --- |
| `swarm_spawn({agent, task, name?, model?, cwd?})` | Start a peer from an agent definition. Returns once ready; the task identifies its spawner. |
| `swarm_send({to, message, tags?, ttl?})` | Commit a message to the board, then notify recipients through `herdr agent prompt`. Reports each actual recipient's submission or failure; never automatically retries. |
| `swarm_list()` | List herdr's current agents: name, status, pane; also list available definitions. Unlisted does **not** prove completion or a crash. |
| `swarm_board({from?, to?, tag?, limit?})` | Read all recent unexpired board messages, newest first. No notifications. Add `message`, optional `tags`, `ttl` and `to` to post without notifying anyone. |

```typescript
swarm_spawn({ agent: "worker", name: "auth-review", task: "Review auth; send findings." });
swarm_send({ to: "auth-review", message: "Also inspect token expiry.", tags: ["auth"] });
swarm_send({ to: "*news*", message: "Research update: see reports/news.md", tags: ["research"] });
swarm_board({ from: "auth-review", tag: "result", limit: 10 });
```

**Addressing:** an exact name may cross projects. A pattern containing `*` matches whole names in the current project subtree only (`news*`, `*news*`, `us-*-1`, `*`). Consecutive stars collapse; no `?`, brackets, or other glob syntax. Patterns exclude the sender and unnamed panes. Names do not imply roles or permissions; use message tags for topics. Group sends wake every recipient and consume their tokens.

**TUI:** action-labelled calls show a short preview; tool results use pi's own shell and collapse to at most eight display rows. Expand with your configured pi tool-output key. Board headers show sender, recipient, type, tags and relative lifetime; agent badges preserve herdr's real state, with unlisted/unknown shown as warnings.

**Submission is not acknowledgement.** Busy pi agents queue input; blocked dialogs or unavailable agents produce errors. A timeout may mean an uncertain delivery: inspect, don't blindly resend. A failed private message still remains on the board. The board is shared, **not confidential**.

## Board metabolism

Default file: `.pi/swarm/board.sqlite` in the spawning project. Set `PI_SWARM_BOARD` to choose another file; relative paths resolve from the root caller's cwd and peers inherit the absolute path. SQLite is Node's native implementation, with cross-process writes and a bounded busy timeout; no extra runtime dependency.

- Message body limit: **4000 characters**, shared by send and board posts. Longer work belongs in a report file; send a summary and its path.
- `ttl` is positive seconds, default **24 hours**, at most 365 days. `kind=result` expires identically.
- Reads return only valid messages (default 20, maximum 100). Model-facing text is capped at 30,000 characters; narrow filters if truncated.
- Expired rows are deleted on reads/writes, including idle spawner checks. A dormant file is cleaned on its next access; this is not a permanent archive. Expiry is neither success nor failure.
- No per-sender eviction: unread final results are not discarded merely because someone posts more messages. Save lasting deliverables in report files.

`PI_SWARM_PROJECT` sets the broadcast project subtree; otherwise the root caller's cwd is used and inherited by peers. A custom board path does not register members or change broadcast scope.

## Agent definitions

Bundled `agents/worker.md`; global `~/.pi/agent/agents/*.md` (or `PI_CODING_AGENT_DIR/agents`); trusted project `.pi/agents/*.md`. Project definitions override global, which override bundled.

```markdown
---
name: reviewer
description: Read-only review
model: openai-codex/gpt-5.6-luna
thinking: low
tools: read, grep, find, ls
system-prompt: append
auto-exit: true
---
Review the assigned code and report actionable findings.
```

Supports `name`, `description`, `model`, `thinking`, comma-separated `tools`, `skills`/`skill` from default skill directories, `cwd`, `system-prompt: append|replace`, `auto-exit`, and `disable-model-invocation`. Without a system-prompt mode the body prefixes the task. Relative cwd resolves from the caller. Swarm tools are always added to explicit tool allowlists. Extensions load normally; an allowlist is **not a security sandbox**. Trust is propagated only when the child uses the caller's exact trusted cwd; a different cwd may require user approval.

Sessions are fresh and standalone. `cli: claude` and fork/lineage modes are rejected. Old `subagent_agents` delegation restrictions do not apply: these are peers. Default auto-exit is true; `auto-exit: false` keeps a peer open for further messages.

## Completion and waiting

Normal completion runs at **`agent_settled`**, not `agent_end`: retries, recovery and pending input finish first. Esc/aborted tools leave the agent open. Autonomous agents also remain open while their own spawned peers are pending.

The final result is committed before notification and exit. An overlong final response becomes a bounded summary plus its existing pi session path. New input during notification prevents premature shutdown; the eventual final result is distinguished by its ordinary creation timestamp. Successful autonomous agents close **their own** pane after pi's shutdown hooks; error/unknown/interrupted panes remain inspectable. Spawner shutdown/reload does not kill peers.

Spawners persist their own pending-run references in the pi session. Exit markers/local process checks distinguish actual exits from a missing herdr listing. A terminal exit with no valid result is reported as **unknown outcome**, not success or proof of a crash. An unconsumed latest result is recovered from the board into the spawner's session once, without retrying terminal delivery. Expired results cannot be recovered. Name reuse clears the previous run's state; do not externally rename/reuse live peer identities mid-task.

An independent root auto-exit extension can query pending work:

```typescript
const pending = (globalThis as any)[Symbol.for("pi-herdr-swarm/pending-count")]?.() ?? 0;
// Suppress root exit while pending > 0, and also check ctx.hasPendingMessages().
```

## Limits

Local herdr server and local filesystem only; no distributed coordinator, name claims, task leases, receipts, automatic retries, or strategy-consistency checks. Pi retains its ordinary session transcripts and internal run artifacts; the message board itself expires.

For trading: parallelize **research**, but let **one agent place orders**. Multiple peers placing orders can duplicate positions or turn double-closes into unintended shorts. This is a caller convention, not enforced by the extension. This repository's demo performs no trading.

## Checks

```sh
npm install --ignore-scripts
npm run check
npm test

# Optional real, isolated herdr demo; requires configured pi model credentials:
herdr --session swarm-e2e server
# From another herdr pane; the named session must have no workspaces:
node test/e2e.ts swarm-e2e openai-codex/gpt-5.6-luna
herdr session stop swarm-e2e
```

The live demo spawns two peers, exercises private messages, broadcast, expiration, root waiting, final-result persistence despite an unavailable observer, and successful pane cleanup. It only controls its newly created isolated workspace. Do not run it against a trading session.
