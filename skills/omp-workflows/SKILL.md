---
name: omp-workflows
description: >-
  Operate and author OMP workflows. Use when the user starts, lists, pauses,
  resumes, cancels, answers, or inspects a workflow; says /workflow, /hitl, or
  /ompw; wants the live graph, snapshot CLI, or always-on host; or needs a durable
  multi-step supervisor. This plugin is that supervisor.
compatibility: Requires the omp-workflows extension. Herdr viewer needs ompw on PATH.
---

# omp-workflows

Natural-language intent is enough. Users do not need `/workflow`, `/hitl`,
`/ompw`, or `/skill`. When the tools can list, start, pause, resume, cancel,
present HITL, answer, or open the viewer, do those steps.

This session has **one supervisor**: the `workflow` tool plus the run bundle.
Herdr worker panes are not the supervisor. Do not add a second supervisor for
the same job.

Keep simple one-turn work outside a workflow. If a workflow step message is
already live, complete that step. Do not start another run.

The `workflow` tool schema is the authority for call shapes. A workflow step
message is the authority for its current step id, attempt id, and expected
output. Do not guess those values from an earlier attempt.

## Decide the surface

| User intent                      | Do this                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| What workflows exist?            | `workflow` `list`. `/workflow` with no args is the same.                                                                                 |
| Run this / keep going on a graph | `start` once. Trailing text is `{ task: "..." }`. Use `--input-json` or structured `input` when the shape is not a task string.          |
| How is it doing?                 | `status`. Prefer the known `runId`.                                                                                                      |
| I want the conversation back     | `pause`. Escape already pauses; say so and wait for `resume`.                                                                            |
| Continue                         | `resume`. Re-delivers the pending step.                                                                                                  |
| Stop / clear leftover widget     | `cancel`.                                                                                                                                |
| Protected decision is waiting    | Call `hitl` or use `/hitl` to present host-owned UI. Never send the answer through a model tool.                                         |
| Show the graph                   | In Herdr: widget `Ctrl+Shift+R ompw`, `/ompw`, or `/ompw right\|below\|left\|above\|tab\|workspace`. Outside: `ompw` or `ompw <runDir>`. |
| Snapshot / host / sync plugin    | CLI below.                                                                                                                               |

One active workflow per session. Do not start a second run until the first is
paused, cancelled, waiting at a checkpoint you will answer, or finished.
`list`, `pause`, `resume`, `cancel`, `status`, and `answer` are reserved names.

Built-ins: `monitor`, `autoplan`, `autodoc`, `autoimplement`. Monitoring
requests use the `monitor` skill and start `monitor` once. Do not hand-roll a
poll loop around a workflow that already waits.

## Worked calls

Start once:

```json
{ "action": "start", "workflow": "monitor", "input": { "task": "Watch PR 123" } }
```

Answer an ordinary checkpoint:

```json
{ "action": "answer", "input": { "approved": true } }
```

Submit the current agent step (ids come from **that** step message):

```json
{ "action": "submit", "step": "reply", "attempt": "try-1", "output": { "reply": "…" } }
```

Call `start` once for one requested run. A model-started run is saved before
the tool reports it queued; that `runId` works with `status` and `cancel`
immediately.

## Protected human decisions

Do not use `workflow answer` for a waiting `humanDecision()` node. Call `hitl`
or use `/hitl` to present the host-owned decision UI. The `hitl` tool accepts
only an optional `runId`; it cannot carry a choice, approval, or return text.
A verified person answers through the channel:

- Pi TUI uses its interactive decision view.
- OMP TUI uses the native custom decision component.
- OMP RPC clients handle `extension_ui_request` frames for `select` and, when
  requested, `input`, then return the matching `extension_ui_response`.
- JSON, print, and non-OMP RPC hosts have no local interactive channel. They
  wait for a configured external channel or a saved timeout policy, and do not
  claim a detached unresolved decision merely by scanning the project.

Plan approval presents **Approve**, **Return for changes**, and **Stop**. An
accepted OMP response is recorded as `source.channel: "omp"` and starts or is
adopted by the normal continuation run. No model-facing tool can forge it.

## Complete agent steps

When a workflow step message arrives:

1. Do the requested work with the available tools.
2. Match the expected output in that message.
3. Call `workflow` with `action: "submit"` exactly once, using the step and
   attempt ids from **that** message.
4. If validation rejects the output, correct it and submit again with the same
   current ids.
5. After acceptance, end the turn.

A node id can run more than once. Each visit has a new attempt id. Never reuse
an attempt id from history. Use `update` only while the named step attempt is
active; it does not complete the step. Progress updates use
`pi-workflows.progress.v1` with observed counts only.

## Watch, CLI, and parks

`ompw` is the live graph. In Herdr, open it from the widget or `/ompw`. If a
viewer for that run already exists, focus it.

Published CLI:

```text
omp-workflows herdr sync
omp-workflows runs
omp-workflows view [runId]
omp-workflows view [runId] --once
omp-workflows cancel <runId> --dir <runsDir>
omp-workflows host [foreground|install|start|stop|restart|status|uninstall] --project /path/to/project
omp-workflows host status --project /path/to/project --json
ompw
ompw ~/.pi/agent/workflows/runs/<runId>
```

From a clone, or if `omp-workflows` is not on `PATH`, run the same commands
through `node dist/viewer/cli.js`. `herdr setup` is an alias for `herdr sync`.

Runs live under `~/.pi/agent/workflows/runs/<runId>/`. Closing the session
**parks** active work and detaches durable waiting human decisions; it does not
cancel them. A later project session that can actually present or deliver a
waiting decision may atomically adopt it and continue once. A channel-less
headless session leaves it unowned. Use
`omp-workflows cancel <runId> --dir <runsDir>` to cancel a waiting human
decision without presenting UI. The command does not cancel ordinary
checkpoints or non-waiting runs. Ctrl-C stops the foreground host. Reports for
session-bound active work still return to the session that started it.

Controllers (`/controller`, CLI `controllers`) reconcile durable resources.
They are not a second workflow supervisor.

## Author workflows

A workflow is a `.workflow.ts`, `.workflow.js`, `.workflow.mts`, or
`.workflow.mjs` module whose default export comes from `defineWorkflow(...)`.
Project files live in `.pi/workflows/`. Global files live in
`~/.pi/agent/workflows/`. Compose existing node and edge primitives before
adding a new one. Start from [../../examples/workflows](../../examples/workflows).

Read [../../docs/workflows.md](../../docs/workflows.md) before creating or
changing a workflow. Read
[../../docs/WORKFLOW_COMPOSITION.md](../../docs/WORKFLOW_COMPOSITION.md) for
nested workflows. Read [../../docs/HUMAN_DECISIONS.md](../../docs/HUMAN_DECISIONS.md)
before adding a human gate. Read
[../../docs/WORKFLOW_UPDATES.md](../../docs/WORKFLOW_UPDATES.md) before adding
update producers. Read
[../../docs/DESIGN_PHILOSOPHY.md](../../docs/DESIGN_PHILOSOPHY.md) before
adding public primitives.
