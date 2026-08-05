---
title: Add always-on workflow execution
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-05
updated: 2026-08-05
status: planned
---

# Always-on workflows plan

Pi Workflows should feel the same whether the user watches a run or walks away from it. In the user's words: "I might start a workflow locally in Pi then I wait for it to complete. All the while I am looking at the screen and I'm not closing the Pi window. When the workflow ends I just want to be able to continue the same Pi session like normal with a session up to date with what happened in the workflow." And: "I just want to interact by starting a workflow, closing it, and then coming back and then still being able to continue it when I open it up. It's syncing continuously or something."

These are not two modes. The user asked for "both in a single unified system." This plan makes the Pi window irrelevant to execution: closing or opening the window is a change in observation, not in the run. The work stays on one machine, uses the merged controller runtime as its foundation, and does not modify Pi core.

## Design

Three rules define the system:

1. **Durable state is the only source of truth.** Run bundles, the queue, and the event log live on disk. Nothing important lives in a session's memory.
2. **Runners are interchangeable.** Any live process running the engine claims work from the durable queue. The Pi extension hosts an embedded runner; a standalone host process runs the same code. Expiring claims hand work between them.
3. **The session is always a view.** It attaches to a run's event stream and renders it. An open window sees a live tail; a reopened window catches up from the same stream. Interaction such as approvals uses durable waiting states, never prompts tied to the window's lifetime.

The controller runtime already provides most of the machinery: a deduplicated queue with expiring claims, a structured event table, crash recovery through the trace tail, and guarded effect records. This plan extends that treatment to runs the user starts interactively and adds the view layer.

## Requirements

- Starting `/workflow run` in a Pi session creates a durable queued run and shows its progress live in that session.
- Closing Pi mid-run never loses the run. With the standalone host alive, the run continues without interruption. Without a host, the run waits and resumes when a runner returns.
- Reopening a session brings it up to date: a catch-up summary says what finished, failed, or waits for input, and the user continues the conversation normally.
- A run that needs human input enters a durable waiting state. The user answers with a command, which writes the decision to the store, and the holding runner resumes the run.
- Killing any process at any point produces recovery without duplicate trace sequences or duplicate external effects.
- Everything uses documented Pi public APIs. No Pi core changes.

## Work items

1. **Queue-routed starts.** `/workflow run` inserts the run into the existing claimable queue before executing. The embedded runner in the session claims and executes it, which keeps today's watch-it-live experience as the default observation path.
2. **Node-level resume.** The engine replays completed node results from `trace.ndjson` and continues at the interrupted node instead of restarting the attempt. Compute reruns only where no result is recorded; guarded effects still prevent duplicate external writes.
3. **Session sync.** The extension polls the event table every few seconds with a remembered watermark, refreshes the widget, and calls `sendUserMessage` for noteworthy events. On `session_start` it summarizes everything past the watermark. Live run watching reads `trace.ndjson` from a remembered byte offset, with `fs.watch` for low latency, reusing the TUI viewer's file-tail path.
4. **Standalone host.** A `pi-workflows` CLI subcommand loads controller definitions, opens the project store, and runs `ControllerManager` and workflow claiming in a loop. Conversation child nodes run in spawned headless `pi --mode rpc` sessions, the same mechanism the E2E tests use. The host takes an advisory lock with a heartbeat, drains on SIGTERM, and recovers on restart. It is a foreground process the user runs in a terminal; it is not a service.
5. **Handoff.** A runner's closing marks or expires its claims so another runner can reclaim them. When no host exists, reopening Pi lets the embedded runner reclaim and resume waiting runs through node-level resume.

## Non-goals

- Pi core changes of any kind. Every integration uses public APIs: commands, session events, widgets, `sendUserMessage`, and `pi --mode rpc`.
- Multi-machine execution, a remote store, or leader election. SQLite and one machine are in scope; the store contracts leave room for a remote implementation later.
- Installing or configuring a system or user service. The host is a process the user starts and stops.
- A push channel from an external process into a live session. Polling the shared store is the mechanism, and it is fast enough.
- Exactly-once external side effects beyond the existing guarded effect records.

## Assumptions

- One machine and one user, with the store and run bundles on the local filesystem.
- Spawning `pi --mode rpc` per conversation child run is acceptable at the expected cadence. If startup cost proves too high, the host keeps a small pool of persistent RPC sessions instead. Both options stay outside Pi core.
- A polling interval of a few seconds is responsive enough for the session view. File watching covers the live tail of a watched run.
- The user does not need machine-sleep or power-loss coverage beyond crash recovery. A stopped machine stops work until a runner returns.

## Open questions

- Whether an interactively started run should prefer staying on the session's embedded runner until the window closes, or whether any runner may claim it immediately.
- Where the catch-up watermark lives: per session, per project, or per store.
- Which events deserve a chat message and which belong only in the widget. The default should be quiet.
- The exact host command shape, for example `pi-workflows run --project <dir>` versus a subcommand under `controllers`.
- Graceful handoff behavior on window close: explicitly release claims for fast takeover, or let leases expire for simplicity.

## Acceptance criteria

- Start a run in Pi, then close Pi while a conversation node is mid-response and the host is running. The run finishes, and reopening Pi shows the catch-up summary and allows normal conversation about the result.
- The same flow without the host: the run resumes at the interrupted node when Pi reopens and completes.
- An open session reflects host-driven progress within a few seconds, with no duplicate or skipped notifications across close and reopen.
- A waiting-for-input run survives closing and reopening, and answering the prompt resumes it.
- `kill -9` on the host mid-run, followed by a restart, recovers without duplicate trace sequence numbers and without repeating an applied external effect.
- No changes to Pi core; the diff touches only this package.

## Verification

- `npm run check` and `npm run test:e2e`, including new real-Pi E2E tests that start a run, kill the host, restart it, and assert continuation.
- Extension tests with fake timers for the polling loop, watermark, and catch-up summary.
- Crash-fault tests for claim handoff and node-level resume mid-conversation.
- `npx slophammer-ts@latest dry .` and the dependency-boundary check.
- `npx -y @simpledoc/simpledoc check` for documentation changes.
- Manual pass through both usage patterns from the user's request with the host in a terminal.
