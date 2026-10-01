# pi-herdr-swarm

Named pi peers inside [herdr](https://herdr.dev), an expiring Markdown board, and resumable sessions. Spawning creates an optional wait for one run—not management authority or a shared lifespan. Any agent can send or spawn.

## Install

Requires Node **22.19+**, herdr **0.9+**, and pi with `agent_before_settle` / `agent_settled`. Install herdr's pi integration first, then run pi inside herdr:

```sh
herdr integration install pi
herdr integration status
pi install git:github.com/fyang93/pi-herdr-swarm
# Or load this checkout:
pi -e ./src/index.ts
```

## Four tools

```typescript
swarm_spawn({ name: "review-1", task: "Review this change and report findings." });
swarm_send({ to: "review-1", message: "Also inspect input validation." });
swarm_list();
swarm_board({ from: "review-1", limit: 10 });

swarm_send({ message: "Notes are in reports/notes.md" }); // posted · board only
swarm_send({ to: "*review*", message: "The change is ready for review." });
swarm_spawn({ task: "Analyze the report.", detach: true });
swarm_spawn({ resume: "review-1", task: "Review the follow-up change." });
```

- **Spawn:** `{task, agent?, name?, model?, cwd?, detach?}`. Optional configuration preset; explicit values override presets, then current spawner model/thinking. Fresh tasks get a factual identity/spawner/completion preamble. Tools and extensions load normally; trust is entirely pi's responsibility. The extension never passes automatic approval.
- **Resume:** `{resume, task, detach?}` only. Reuse your ended run's session and saved configuration in a new pane, without repeating the preamble. Occupied names, live/uncertain bindings, missing snapshot/session/cwd, or unarchived previous results refuse resume.
- **Send:** `{message, to?}`. Persist first, then native `herdr agent prompt`; no recipient preflight, process startup, rerouting or retries. Omit to for board-only. Exact names can cross projects; `*` anywhere matches whole names only within the same project, excluding sender and unnamed agents. Consecutive stars merge; no other glob syntax. Results are submitted/rejected/unknown with error codes.
- **List:** no arguments; online names, states, panes and presets, without naming the caller.
- **Board:** `{from?, to?, limit?}`; original-field exact filters, not a personal inbox. Default 20, maximum 100, model-facing text capped at 30,000 characters. Reads reclaim expired files but do not publish, submit or name anyone.

Names match `[a-z][a-z0-9_-]{0,31}`. Automatic peer names are `<preset-or-peer>-N`, avoiding online and all historical spawn names. A fresh spawn cannot reuse your historical name: resume explicitly. Only send/spawn may name an unnamed caller from its pane ID, e.g. `swarm-w5-p1`, with a notification. Name collisions and uncertain renames are errors, not retried.

## Configuration and board

Optional presets: `~/.pi/agent/agents/*.md` (or `PI_CODING_AGENT_DIR/agents`) and trusted project `.pi/agents/*.md`; project values override global ones. Supported fields: model, thinking, cwd, system prompt append/replace, skills/skill. Prompt body and skill contents are saved in the resolved snapshot for resume; thinking is clamped to model capabilities.

```markdown
---
name: reviewer
description: Review configuration
thinking: low
system-prompt: append
---
Report actionable findings with file paths.
```

The board is fixed at `<canonical-project-root>/.pi/swarm/board/`. Each message is `<created-ms>-<from>.md`, with collision suffixes and quoted frontmatter: from/to strings, message/result kind, ISO created/expires. Exclusive temporary creation plus atomic hard-link publication never overwrites a message. Bodies are at most **4000 characters**; larger work belongs in a report file. Retention is fixed at **24 hours**; grep the directory for topics.

Reads are asynchronous and bounded to 64 KiB+1 per file. Oversized/non-regular files are skipped with paths, invalid messages are skipped, and other filesystem errors are reported. Ordinary reads/writes reclaim expired files; synchronous exit publication never scans or reclaims.

## Results and exit

Every spawn/resume, including detach, is recorded before requesting startup. Blocked or uncertain startup keeps its record and pane inspectable; only confirmed ready peers with matching native session identities receive the task.

Only internal **CLI launch flags**, bound to the current session path, grant automatic exit. They are not inherited by the pane shell: manually launching pi—even on the same session—does not auto-exit. Switching sessions loses qualification; same-session reload retains it.

Non-interrupted settled work exits only while idle, with no pending input, an empty editor and zero pending runs. Escape cancels the exit candidate until the next run; submitted input and arriving results invalidate it too. Provider errors are archived. The peer synchronously writes its final reply to the board, then shuts down and closes only its current pane after shutdown hooks. Write failure leaves it open without retry. Detach writes to `*` and neither waits nor sends a result to the spawner.

One herdr list snapshot supervises all waiting **session paths**, even after names disappear or change. Unknown identities keep waits open and block resume. Ended runs are read without modifying their session files; only the last new assistant reply after the recorded active-branch boundary is used. Empty, erroneous and unreadable results are reported honestly. Blocked transitions report once with the current pane.

The result is a structured `swarm_result` with `triggerTurn: false`; a separate body-free follow-up notice wakes the spawner. Results are never re-enqueued. Active-branch spawn/result entries restore waits after restart. Pending work remains until the result is appended **and a subsequent normal assistant reply finishes**, so Escape may cancel the notice but does not silently release unfinished result processing. Hosts and this extension use the same live counter:

```typescript
const pending = (globalThis as any)[Symbol.for("pi-herdr-swarm/pending-count")]?.() ?? 0;
```

## Three contracts

1. **Boundary:** one local herdr instance. Projects mean canonical Git roots; outside Git, canonical cwd. Worktrees, nested repositories and submodules are separate. Startup/supervision depend on herdr's pi integration reporting session identity. `PI_SWARM_MAX_AGENTS` defaults to **16**, a positive integer. Target-project admission counts unnamed/starting agents and refuses uncertain counts: a precheck, **not a strict concurrent limit**.
2. **Names, submission, TTL:** names are online addresses and may disappear while running. Submitted means terminal bytes written—not read or processed. A recipient's last exit window may miss processing; delivery is not guaranteed exactly once. TTL is retention, not a deadline, completion or cancellation.
3. **Permissions:** roles grant no permissions. Actions with side effects—writing the same file or calling an external system—should have one executor; research/analysis can run in parallel. This is a usage convention; hard guarantees belong to the host.

## Checks

```sh
npm install --ignore-scripts
npm run check
npm test
# Inside herdr: owns and cleans a private server; no external model requests:
node test/e2e.ts
```

Fake herdr checks outcome mapping and startup boundaries; real AgentSession checks lifecycle ordering and result persistence; the isolated demo checks native connections and delivery. The demo creates and cleans only its own workspace.
