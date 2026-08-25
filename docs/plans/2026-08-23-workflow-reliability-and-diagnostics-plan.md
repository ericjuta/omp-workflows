---
title: Workflow reliability and diagnostics plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-23
---

# Workflow reliability and diagnostics plan

This is the implementation plan for the accepted workflow reliability and diagnostics work. It closes ten concrete failure modes without replacing the workflow engine, adding a second supervisor, or creating a new persisted run-bundle schema.

The minimal implementation extends current contracts: `ConversationStepExecutor` already tracks `pending.seenAgentStart`; custom step messages already carry the step contract; reviewer batches already persist before assessment; continuation runs already carry `parentRunId`; run bundles already contain definition snapshots, traces, and full session capture. The work should make those contracts reliable and observable rather than introduce parallel mechanisms.

## Outcome

- A delivered interactive step prompt that does not lead to `agent_start` is woken or re-delivered a bounded number of times, without stealing a user-interrupted conversation.
- Every initial, reminder, and resume step message shows the exact model call required to submit that attempt.
- Provider and transport failures are distinguished from a model that semantically completed a turn without submitting; a provider 404 does not spend the semantic nudge budget.
- An `assessReview` timeout reuses the completed persisted `runReview` batch and never reruns `omp-reviewer` only to recover assessment.
- Monitor observation remains read-only unless repair was explicitly authorized. Consecutive observation timeouts receive a bounded, truthful retry path, and cancellation remains immediate.
- A rejected blocker resumes from a validated origin stage and cannot jump over implementation, verification, publication, review, comments, CI, or delivery gates.
- Run list, status, duplicate-live matching, and viewer selection understand continuation families while leaving the waiting parent bundle immutable.
- Ordinary list and status calls remain fast. Rich diagnostics and integrity checks are explicit and report warnings instead of silently dropping unreadable or inconsistent runs.
- Changes to the canonical snapshot of a built-in workflow require the matching built-in revision and checked-in digest to change together.
- Model-facing context is bounded, while the existing run-bundle recorder retains the complete replay stream.

## Accepted item map

| Accepted item                                         | Minimal implementation                                                                                                       | Primary files                                                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Prompt-to-`agent_start` acknowledgement and retrigger | Track delivery activation for the current `PendingStep`; bounded wake/re-delivery through the existing natural-turn path     | `src/extension/executor.ts`, `src/extension/deferred-turn-coordinator.ts`, `src/extension/index.ts`     |
| Exact model-visible submit envelope                   | Append one shared exact envelope to initial, reminder, and resume content; retain the flat provider schema                   | `src/extension/executor.ts`, `src/workflows/tool-input.ts`, `src/host/rpc-bridge.ts`                    |
| Provider error classification                         | Classify turn/provider failure before deciding activation retry or semantic nudge; 404 is transport/provider failure         | `src/extension/index.ts`, `src/extension/executor.ts`                                                   |
| `assessReview` timeout recovery                       | One bounded reassessment from persisted `runReview` output, then normal review routing                                       | `src/builtins/autoimplement.workflow.ts`                                                                |
| Monitor observation/repair boundary and timeout retry | Outcome-aware `check` edge, deterministic timeout record, bounded consecutive retries through current `schedule` and `sleep` | `src/builtins/monitor.workflow.ts`                                                                      |
| Stage-aware `challengeBlocker` recovery               | Carry and validate blocker origin in current step output; route to an origin-specific safe re-entry node                     | `src/builtins/autoimplement.workflow.ts`                                                                |
| Continuation-aware list/status/live matching          | Derive a parent/child family overlay from existing `state.parentRunId`; do not rewrite parent state                          | `src/workflows/run-discovery.ts`, `src/extension/index.ts`, `src/viewer/cli.ts`                         |
| Rich fast diagnostics and integrity warnings          | Add a state-only list projection and a separate explicit deep diagnostic path                                                | `src/workflows/store.ts`, `src/workflows/run-discovery.ts`, `src/viewer/cli.ts`, `src/viewer/render.ts` |
| Built-in revision/digest enforcement                  | Hash `createDefinitionSnapshot`, pin digest by built-in ID and revision, and test the pair                                   | `src/workflows/store.ts`, `src/builtins/catalog.ts`, `test/catalog.test.ts`                             |
| Bounded model context and complete replay             | Bound prompt projections and use supported session compaction; do not trim recorder data                                     | `src/builtins/autoimplement.workflow.ts`, `src/extension/executor.ts`, `src/extension/recorder.ts`      |

## Scope

The implementation may change:

- interactive step delivery and lifecycle handling in `src/extension/`;
- the shared provider-visible submission schema only as needed to keep its current exact flat contract;
- autoimplement and monitor graph definitions in `src/builtins/`;
- read-only run discovery, status, viewer, and diagnostic projections;
- built-in catalog metadata and canonical definition digest helpers;
- focused tests for each changed contract;
- user documentation whose described behavior changes.

## Non-goals

- No new run-bundle schema, continuation schema, queue table, or migration.
- No persisted acknowledgement counter, provider-error ledger, blocker-origin field, diagnostic cache, context summary, or integrity report. These are attempt-local or derived values.
- No second workflow supervisor, background poller, detached retry process, alternate submission protocol, or provider-specific tool schema.
- No mutation from list, status, viewer, or diagnostic commands.
- No automatic repair from an observation-only monitor.
- No re-execution of `omp-reviewer` merely because its model assessment timed out.
- No route from `challengeBlocker` directly to delivery or completion.
- No AST or source-text hashing for built-in workflows.
- No isolated per-step model executor unless the supported OMP/Pi API is first proven to require it. It is not part of the minimal implementation.
- No truncation or deletion of trace, action, session-entry, session-event, or capture data in a run bundle.

## Invariants

1. `WorkflowRunState`, `WorkflowStepRecord`, the bundle manifest, trace, and session capture remain backward compatible.
2. The parent of a continuation remains a waiting historical bundle. Discovery may display the child's effective state but never rewrites the parent.
3. `ConversationStepExecutor.hold()` suppresses activation retry and semantic nudges. `release()` is the only wake after an Escape/user interruption.
4. Abort and cancellation clear activation timers, stop pending delivery, and reach the current `onAbort` and engine cancellation path immediately.
5. `WorkflowToolParameters` and `WorkflowSubmissionToolParameters` remain root `Type.Object` schemas with no provider-visible root union. `withoutHostInvocationIntent` remains the only host `i` removal boundary for the full tool.
6. A delivery/transport failure is not evidence that the model ignored a workflow contract. Only an acknowledged agent turn that settles without accepted submission consumes `nudgesSent`.
7. Monitor timeout text says only what is known: the check timed out, its attempt count, and whether another attempt will be scheduled. It never invents an observation, progress value, or ETA.
8. Any code-changing recovery re-enters verification before publication, and any new published head re-enters reviewer and CI gates.
9. Fast list/status paths do not load full trace or session replay files. Deep integrity checks are explicit.
10. Prompt bounds affect only what is sent to the model. Full replay remains in the existing recorder and bundle files.

## Design

### 1. Prompt delivery activation acknowledgement and bounded retrigger

#### Current boundary

`ConversationStepExecutor.runAgentStep` installs `PendingStep` and calls `sendPrompt`. `src/extension/index.ts` delivers the custom message through `DeferredTurnCoordinator.sendNatural`; `agent_start` calls `setStreaming(true)`, which sets `pending.seenAgentStart`. The durable deferred-turn resolution proves that a custom message was sent or found in the session branch, not that a model turn started. If delivery succeeds but no `agent_start` follows, `handleAgentSettled` deliberately does nothing because `seenAgentStart` is false, leaving the workflow until node timeout.

#### Minimal change

- Extend `PendingStep` in `src/extension/executor.ts` with attempt-local activation state: delivery generation, delivery timestamp, bounded activation retry count, and one cancellable wake timer. Do not persist it.
- Add a `ConversationStepExecutor` activation callback such as `handleActivationTimeout(generation)` rather than folding activation failures into `handleAgentSettled`.
- Arm the wake only after `sendPrompt` reports a natural delivery of `sent`; a `deferred` result remains owned by `DeferredTurnCoordinator.flushNatural` and is not timed from the earlier enqueue request.
- On `agent_start`, `setStreaming(true)` marks the pending generation acknowledged and cancels its wake.
- If the wake fires while the same step and attempt are pending, no `agent_start` was seen, the run is not held, and the session is idle, re-deliver the same attempt through `DeferredTurnCoordinator.sendNatural`. Re-delivery must use the same `nodeId` and `attemptId` and a deterministic message identity where the deferred-turn path supplies one.
- Bound activation re-delivery independently from `maxNudges`. After the small activation budget is exhausted, reject the step with a specific activation failure so the existing engine timeout/failure policy can act; do not wait for the full node timeout.
- `hold()`, `clearPending()`, abort, accepted submit, claim loss, and session shutdown clear the activation timer. `release()` begins a new delivery generation and re-arms acknowledgement.

#### Exact symbols

- Existing: `PendingStep`, `ConversationStepExecutor.runAgentStep`, `setStreaming`, `hold`, `release`, `handleAgentSettled`, `clearPending` in `src/extension/executor.ts`.
- Existing: `DeferredTurnCoordinator.sendNatural`, `flushNatural`, `deliverNatural` in `src/extension/deferred-turn-coordinator.ts`.
- Existing wiring: the `sendPrompt` callback and `pi.on("agent_start")`, `pi.on("agent_settled")`, `pi.on("agent_end")`, `pi.on("session_shutdown")` handlers in `src/extension/index.ts`.
- Proposed small helper: `scheduleActivationWake` in `ConversationStepExecutor` or the equivalent private method. Keep the timer beside `PendingStep`; do not add an engine primitive.

### 2. Exact model-visible submit envelope

#### Current boundary

The exact runtime submission is already:

```json
{
  "action": "submit",
  "step": "<nodeId>",
  "attempt": "<attemptId>",
  "output": "<value matching expectedOutput>"
}
```

`WorkflowActionSchemas.submit` and `WorkflowSubmissionActionSchemas.submit` enforce it. `ConversationStepExecutor.handleAgentSettled` shows it in reminder content, but initial and resume messages rely on hidden message details and the tool description. A provider cannot be expected to infer the exact current IDs from a renderer-only contract.

#### Minimal change

- Add one pure formatter in `src/extension/executor.ts`, for example `submissionInstruction(contract)`, that renders the exact envelope and expected output.
- `delivery()` appends this instruction to the model-visible content for `step`, `reminder`, and `resume`. The formatter is the only copy of the envelope text.
- Preserve the structured `WorkflowAgentStepMessageDetails.contract` for UI and recorder linkage; the text is authoritative for the model and the details remain authoritative for the renderer.
- Keep `WorkflowToolParameters` and `WorkflowSubmissionToolParameters` flat. Keep exact action parsing through `WorkflowActionSchemas.submit`.
- Apply `withoutHostInvocationIntent` to `parseWorkflowSubmissionInput` as well as `parseWorkflowToolInput`, so an OMP-injected `i` field is removed before exact action validation in both interactive and RPC submission paths. Do not remove or rename any public action field.
- Keep `src/host/rpc-bridge.ts` on `WorkflowSubmissionToolParameters` and `parseWorkflowSubmissionInput`; it must not define a second envelope.

#### Exact symbols

- `ConversationStepExecutor.delivery`, `handleAgentSettled`, `release`.
- `WorkflowActionSchemas.submit`, `WorkflowSubmissionToolParameters`, `parseWorkflowSubmissionInput`, `withoutHostInvocationIntent` in `src/workflows/tool-input.ts`.
- Submission handling in `src/host/rpc-bridge.ts` and `src/extension/workflow-tool.ts`.

### 3. Provider error classification

#### Required distinction

The extension must distinguish:

- activation or delivery failure before `agent_start`;
- provider/transport failure after a turn starts, including HTTP 404, authentication, rate limit, context overflow, and transient service/network failure;
- an acknowledged semantic turn that settles normally without submitting;
- explicit user abort, cancellation, and claim loss.

A provider 404 is not a semantic omission and must not increment `PendingStep.nudgesSent`.

#### Minimal change

- Add a small, testable classifier at the extension lifecycle boundary. It may live in `src/extension/executor.ts` if it consumes a normalized turn-end input, or in `src/extension/index.ts` if OMP message shapes must first be normalized there.
- The classifier returns behavior, not a new persisted error schema: `user_abort`, `provider_retryable`, `provider_terminal`, `context_overflow`, or `semantic_settle`.
- `agent_end` captures the current turn classification for the following `agent_settled` event. `agent_settled` then:
  - keeps the current Escape/hold behavior for `user_abort`;
  - uses the activation wake path when no `agent_start` occurred;
  - performs a bounded transport/provider retry for retryable provider failures without incrementing `nudgesSent`;
  - fails promptly with the provider's concise diagnostic for terminal/auth/schema failures;
  - requests supported compaction before one bounded retry for context overflow, only if the current OMP/Pi API exposes that operation;
  - calls `handleAgentSettled` only for `semantic_settle`.
- Match structured status/code fields before bounded message fallbacks. HTTP 404, `not_found`, and equivalent provider-model-not-found responses are terminal or separately retryable by the supported provider contract, but never semantic nudges.
- Reset the captured classification at the next `agent_start` and after settlement so an earlier failure cannot affect a later attempt.

This remains an extension behavior. Do not add provider fields to run state or a provider retry loop to `WorkflowEngine`.

### 4. `assessReview` timeout recovery from the persisted reviewer batch

#### Current boundary

`runReview` is an action node. Its `BatchExecution` is persisted before `assessReview` starts. `assessReview` reads `selectReviewCommands` and `runReview` and validates with `parseReviewAssessment`. Its edge currently switches directly on `$.route`, so it has no explicit `timed_out` branch.

#### Graph change

1. Replace the direct `assessReview` route switch with an outcome switch:
   - `ok` -> a new compute router, `routeReviewAssessment`;
   - `timed_out` -> `recoverReviewAssessment`;
   - `failed` -> existing `propagateSupportedFailure` unless the failure is the same recoverable assessment transport class.
2. Add `recoverReviewAssessment` as one bounded agent assessment. Its prompt contains only:
   - exact selected repositories from the latest successful `selectReviewCommands` step;
   - the persisted successful `runReview.batch` from `context.state.steps`;
   - the existing expected output and severity rules.
3. Validate recovery output with the existing `parseReviewAssessment`.
4. Route successful recovery through the same `routeReviewAssessment` node as the normal result.
5. If recovery also times out, enter the existing supported timeout/blocker policy with a reason that review commands completed but assessment did not. Do not route to `runReview`.

`routeReviewAssessment` preserves the existing cases: `command_error` -> `repairReviewCommand`, `blocked` -> `challengeBlockerGuard`, `critical` -> `triageReview`, `p2` -> `addressP2`, and `clean` -> `inspectComments`.

The recovery is intentionally a reassessment, not a second reviewer execution and not a speculative parser for arbitrary `omp-reviewer` prose.

### 5. Monitor observation/repair boundary and truthful bounded timeout retry

#### Graph change

Replace `{ from: "check", to: "estimate" }` in `src/builtins/monitor.workflow.ts` with an outcome switch:

- `ok` -> `estimate`;
- `timed_out` -> new `recordCheckTimeout` compute node;
- `failed` -> new `recordCheckFailure` compute node or the same bounded failure router if tests prove identical policy is correct.

`recordCheckTimeout` derives the consecutive timeout count from `context.state.steps`; it does not add a persisted counter. Its output is deterministic:

- `route: "retry" | "stop"`;
- `consecutiveTimeouts`;
- `reason` that says the check timed out and whether it will retry.

It must not fabricate `MonitorCheck.observation`, `report`, `progress`, or `repair`. A timeout notification is generated from the deterministic output, not by a model.

A retry routes through the existing `schedule` -> `sleep` -> `check` path. `sleep` remains `timeoutMs: null` and continues calling `waitForMonitorInterval`; no external polling or second clock is introduced. A small fixed consecutive-timeout limit stops the run truthfully after the bound.

The observation/repair boundary remains:

- `validateMonitorCheck(output, false)` rejects `route: "repair"` without `input.repair`;
- only a valid `repair` route reaches `repairGuard`, `planChange`, and the included autoimplement workflow;
- timeout/failure recovery cannot enter `planChange` or `implementation`;
- signal abort during `check`, `schedule`, or `sleep` bypasses retry and remains immediately terminal/cancelled.

### 6. Stage-aware `challengeBlocker` recovery without gate skipping

#### Current boundary

Several nodes route `blocked` to one `challengeBlockerGuard`. `challengeBlocker` currently routes every `continue` result to `redesign`, losing the origin stage.

#### Minimal change

- Derive blocker origin from the latest successful/blocked step immediately before `challengeBlockerGuard`. Keep it in guard/challenge output for the current run; do not add it to `WorkflowRunState` schema.
- Define a closed `BlockerOrigin` union containing only supported origins, such as implementation classification, verification classification, reviewer execution/repair, comment inspection, CI classification, and delivery.
- `challengeBlockerGuard` validates that the origin is allowed, the challenge budget is not exhausted, and a safe re-entry route exists.
- `challengeBlocker` must return the same validated origin with `route: "continue" | "blocked"`. A mismatched or missing origin is rejected rather than guessed.
- Add `routeBlockerRecovery` compute node. Its switch maps each origin to a conservative existing node:
  - implementation or design uncertainty -> `redesign` or `fix` as the challenge explicitly selects;
  - verification -> `planVerification` or `fix`;
  - reviewer command availability -> `repairReviewCommand` or `selectReviewCommands`, never `assessReview` without a persisted batch;
  - comments -> `inspectComments` or `fix`;
  - CI -> `inspectCi` or `opportunisticTest`;
  - delivery -> `inspectComments` or `inspectCi` before another delivery attempt.
- No case maps directly to `finalizeDelivery`, `finalize`, or `blocked` except a validated challenge `blocked` result.

Graph tests must prove that every continue path still traverses the necessary downstream gates and that a changed published head cannot reuse an assessment for an older head.

### 7. Continuation-aware list, status, and live matching

#### Current boundary

Continuation identity already exists as `WorkflowRunState.parentRunId`; queue rows also carry `parentRunId`. A continuation gets a fresh bundle, while the parent remains waiting. Current discovery lists both independently, and duplicate-live matching can treat the waiting parent and active continuation as unrelated runs.

#### Minimal change

- Extend the in-memory `WorkflowRunListItem` projection, not persisted state, with optional derived family fields: `parentRunId`, `continuationRunId`, and an effective status/current node where useful.
- In `src/workflows/run-discovery.ts`, build a child index from existing bundles. For one parent, choose the canonical child using the existing one-continuation invariant and deterministic started/run identity ordering; emit an integrity warning if disk contents violate it.
- `selectRecentRuns` should return one operator-facing family row by default, with explicit parent and current continuation IDs. A detail/diagnostic mode may still show every physical bundle.
- `statusWorkflowControl(ctx, runId)` in `src/extension/index.ts` keeps exact ID semantics. If the requested bundle is a waiting parent with a continuation, return the parent identity plus the continuation's current effective status. If the requested bundle is the child, return the child plus its parent link.
- `findMatchingLiveRuns` collapses continuation families before applying workflow/task fingerprint matching. The parent input remains the task identity when the continuation input is an answer or decision receipt.
- `isLiveWorkflowStatus` remains a pure status predicate. Host/queue ownership evidence may add a warning, but must not silently rewrite durable state.
- `src/viewer/cli.ts` and viewer selection show `parent -> continuation` clearly instead of making the operator guess which row is current.

Do not add a continuation token. Existing `parentRunId`, run IDs, queue one-child constraint, and decision continuation record are sufficient.

### 8. Rich fast run diagnostics and integrity warnings

#### Fast path

`listRunBundles` currently skips full trace but still reads session entry/event streams and segments through `readRunBundle`. Add a state-only reader in `src/workflows/store.ts`, for example `readRunProjection`, which reads only the manifest, state, definition snapshot metadata needed for display, and session binding if project filtering needs it. Add `listRunProjections` for list, duplicate-live matching, and ordinary status discovery.

The fast projection records bounded read warnings for:

- unreadable or incompatible manifest/state;
- missing canonical definition snapshot;
- impossible parent/self links;
- terminal status without terminal timestamp;
- waiting status without `waitingOn`;
- running status with a terminal trace tail when that tail is available cheaply.

Unlike current `listRunBundles`, a malformed bundle directory must be represented as a warning row or aggregate warning count rather than silently disappearing.

Update these callers to use the fast projection where they do not need replay:

- `selectRecentRuns` and `findMatchingLiveRuns` in `src/workflows/run-discovery.ts`;
- `listWorkflowControl` and no-ID `statusWorkflowControl` in `src/extension/index.ts`;
- `printRuns` in `src/viewer/cli.ts`.

#### Explicit deep path

Add one explicit CLI diagnostic command, named `doctor` unless the existing CLI naming review selects a better current convention:

```text
omp-workflows doctor <runId> [--dir <runsDir>]
```

It loads the full bundle with trace and session capture and reports, without mutation:

- manifest/state/snapshot consistency;
- definition snapshot digest and built-in revision identity;
- trace parse errors and state/last-event disagreement;
- existing `sessionIntegrity` and segment integrity;
- parent/continuation linkage and duplicate children;
- waiting human decision integrity;
- current queue/host evidence when available;
- last failed/timed-out step and bounded error text.

Reuse `assessSessionIntegrity`, `validateHumanDecisionRequestIntegrity`, `readLastTraceEvent`, and existing render sanitization. Do not create a diagnostic database, cache, or repair action.

### 9. Built-in revision and digest bump enforcement

#### Current boundary

`createDefinitionSnapshot(workflow)` is the canonical persisted graph/contract snapshot. `engine.ts` already computes a SHA-256 digest of that snapshot for composition drift. `BuiltinWorkflowCatalog` already requires revisions and rejects a run whose persisted built-in revision differs from the installed one.

#### Minimal change

- Move or expose the existing `definitionDigest` implementation as a shared helper beside `createDefinitionSnapshot` in `src/workflows/store.ts` or a small workflow identity module. It must hash `JSON.stringify(createDefinitionSnapshot(workflow))`; do not hash source text or ASTs.
- In `src/builtins/catalog.ts`, register a checked-in canonical digest with each `{ id, revision, definition }` entry, or export a digest table keyed by `id@revision` if that keeps `BuiltinWorkflowCatalog` generic.
- At catalog construction/test time, compute the definition digest and reject a mismatch with an instruction to bump both revision and digest.
- Pin the complete built-in ID -> revision -> digest matrix in `test/catalog.test.ts`. A graph, timeout, expected-output, status-detail, or composition change captured by the canonical snapshot then cannot land under an unchanged revision.
- Keep `legacySources` limited to actual legacy file-source migration. Do not append ordinary previous built-in revisions there, and do not claim that arbitrary old built-in revisions can resume.
- Retain `BuiltinWorkflowRevisionChangedError` for runtime resume refusal.

Prompt or implementation-body changes that are intentionally outside the current canonical snapshot still require a revision bump by release policy. Expanding the persisted snapshot to serialize executable functions is out of scope; the digest enforcement must not pretend to prove that.

### 10. Bounded model context while replay remains complete

#### Minimal change

- Inventory every built-in prompt that stringifies prior outputs, especially `latestIssue`, `currentPlan`, `reviewRoundsForOutput`, `assessReview`, `inspectComments`, CI assessment, blocker challenge, and timeout fallback in `src/builtins/autoimplement.workflow.ts`.
- Add pure bounded projection helpers that preserve identifiers, route-driving facts, latest evidence, truncation markers, and item counts. Older review rounds become compact summaries; the current round retains bounded finding details. Command outputs use their existing bounded batch records rather than raw process streams.
- Build initial, reminder, and resume step messages from the same bounded prompt plus exact submit envelope. A re-delivery must not append another copy of old transcript content.
- When the provider reports context overflow, use the existing supported OMP/Pi compaction or session mechanism before one bounded retry. If the installed API does not expose a safe compaction request, fail truthfully with a diagnostic rather than inventing a private session format or spawning an unproven isolated executor.
- Keep `WorkflowSessionRecorder` unchanged in purpose: it continues appending every observed branch entry and event, including capture segments after handoff or resume. Model prompt projection must not change `record`, `appendSessionEntry`, `appendSessionEvent`, trace writes, or artifact persistence.
- Deep replay continues reading full session entries/events/segments. No bounded prompt field becomes the source of truth for replay.

## Minimal implementation versus deferred ideas

The implementation described above is the accepted minimum. These ideas are explicitly deferred and must not appear in the first change unless new evidence and approval make them necessary:

- durable acknowledgement events or per-attempt provider retry records;
- a generalized engine-level provider error taxonomy;
- a new continuation token or mutable parent status;
- automatic repair from `doctor` output;
- AST/source hashing or serialization of workflow functions;
- a new summary database, vector store, replay index, or model-context schema;
- per-step isolated model processes or sessions;
- unbounded retry, exponential retry fleets, or provider-specific tool formats.

## Exact file and symbol plan

| File                                         | Existing symbols to change or reuse                                                                                                  | Planned change                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `src/extension/executor.ts`                  | `PendingStep`, `ConversationStepExecutor`, `setStreaming`, `runAgentStep`, `handleAgentSettled`, `delivery`, `clearPending`          | Activation wake state; exact submit instruction; provider-versus-semantic settle input; timer cleanup            |
| `src/extension/deferred-turn-coordinator.ts` | `sendNatural`, `flushNatural`, `deliverNatural`                                                                                      | Return/notify actual natural delivery so activation timing starts only after send; preserve branch deduplication |
| `src/extension/index.ts`                     | `sendPrompt` wiring; `agent_start`, `agent_end`, `agent_settled`, `session_shutdown`; `listWorkflowControl`; `statusWorkflowControl` | Lifecycle classification and wake wiring; continuation-aware projections; fast list/status diagnostics           |
| `src/workflows/tool-input.ts`                | `WorkflowActionSchemas.submit`, `WorkflowSubmissionToolParameters`, `parseWorkflowSubmissionInput`, `withoutHostInvocationIntent`    | Preserve exact flat envelope; strip host `i` on submission-only parser                                           |
| `src/host/rpc-bridge.ts`                     | workflow submission tool registration                                                                                                | Consume only the shared submission schema/parser                                                                 |
| `src/builtins/autoimplement.workflow.ts`     | `runReview`, `assessReview`, `parseReviewAssessment`, `challengeBlockerGuard`, `challengeBlocker`, edges; context helpers            | Persisted-batch reassessment; origin-aware blocker routing; bounded projections                                  |
| `src/builtins/monitor.workflow.ts`           | `check`, `validateMonitorCheck`, `schedule`, `sleep`, edges                                                                          | Outcome-aware check recovery; deterministic timeout notices; bounded consecutive retry                           |
| `src/workflows/run-discovery.ts`             | `WorkflowRunListItem`, `summarizeRunBundle`, `selectRecentRuns`, `findMatchingLiveRuns`, `workflowTaskFingerprint`                   | Derived continuation family overlay and warnings                                                                 |
| `src/workflows/store.ts`                     | `readRunBundle`, `listRunBundles`, `readLastTraceEvent`, `createDefinitionSnapshot`, session integrity helpers                       | Fast projection reader/list; shared canonical digest; deep diagnostic inputs                                     |
| `src/builtins/catalog.ts`                    | `builtinWorkflowCatalog`                                                                                                             | Checked-in digest paired with every built-in revision                                                            |
| `src/workflows/catalog.ts`                   | `BuiltinWorkflowEntry`, `BuiltinWorkflowCatalog`                                                                                     | Optional generic digest validation only if catalog-local validation is cleaner than a built-ins-only helper      |
| `src/viewer/cli.ts`                          | `USAGE`, `parseCliArgs`, `printRuns`, run detail command dispatch                                                                    | Fast warning display and explicit read-only `doctor` command                                                     |
| `src/viewer/render.ts`                       | run list/detail render helpers                                                                                                       | Continuation link and integrity warning rendering                                                                |
| `src/extension/recorder.ts`                  | `WorkflowSessionRecorder.record`, event/session append flow                                                                          | No truncation; add regression assertions rather than a new storage path                                          |

## Tests

### Interactive activation and submit contract

Add focused tests in `test/executor.test.ts`, `test/deferred-turn.test.ts`, `test/extension.test.ts`, and `test/step-message.test.ts`:

- sent prompt with no `agent_start` receives only the bounded activation re-delivery;
- a deferred natural message does not start its activation clock until `flushNatural` sends it;
- `agent_start` cancels activation retry;
- Escape/aborted `agent_end` holds the step and no timer or nudge steals the conversation;
- `release()` re-delivers once and establishes a fresh activation generation;
- abort/cancel/accepted submit/session shutdown clears every timer;
- initial, reminder, and resume content each contain exactly one current submit envelope;
- stale attempt IDs remain rejected;
- `parseWorkflowSubmissionInput` strips `i` but rejects unrelated extra fields;
- provider-visible schemas remain flat root objects.

### Provider classification

Add lifecycle fixtures for structured 404/not-found, 401/403, 429, transient 5xx/network, context overflow, normal settle, and user abort:

- 404 never increments `nudgesSent`;
- retryable transport failures consume only the transport retry bound;
- a normal acknowledged settle consumes the semantic nudge budget;
- terminal provider failures fail promptly with sanitized evidence;
- classification state resets between turns.

### Autoimplement graph

Add graph and behavior tests in `test/builtin-autoimplement.test.ts`, `test/autoimplement-command-batches.test.ts`, and `test/review-fixes.test.ts`:

- `assessReview` timeout enters one `recoverReviewAssessment` attempt using the already persisted batch;
- no recovery edge reaches `runReview`;
- recovered clean, P2, critical, command-error, and blocked assessments take the existing routes;
- second assessment timeout terminates through the supported policy without reviewer rerun;
- every blocker origin round-trips through validation;
- missing/mismatched origins are rejected;
- no blocker continuation edge reaches delivery/finalize directly;
- code-changing recoveries re-enter verification, and changed heads re-enter review/CI.

### Monitor graph

Add tests in `test/monitor-workflow.test.ts` and `test/monitor-repair.test.ts`:

- one and two consecutive check timeouts schedule later checks through `schedule` and in-process `sleep`;
- the configured bound stops truthfully;
- a successful check resets the consecutive count derived from steps;
- timeout notifications contain no fabricated observation/progress/ETA;
- observation-only input cannot reach repair after timeout or failure;
- cancellation during check, schedule, and sleep is immediate and does not retry.

### Discovery and diagnostics

Add tests in `test/run-discovery.test.ts`, `test/store.test.ts`, `test/cli.test.ts`, and `test/render.test.ts`:

- waiting parent plus running/completed child is one family row with both IDs;
- exact parent and child status queries identify both sides correctly;
- duplicate-live matching uses the parent's task fingerprint for a continuation;
- parent state file is byte-for-byte unchanged by discovery;
- malformed bundles produce warnings rather than disappearing;
- fast list projection does not read trace/session streams;
- `doctor` identifies trace, session, decision, snapshot, and parent-child integrity problems without writing files;
- warnings and paths are sanitized and bounded.

### Built-in digest and context bounds

Add tests in `test/catalog.test.ts`, relevant built-in tests, and recorder tests:

- every built-in revision has exactly one expected canonical definition digest;
- changing a snapshot fixture under the same revision fails digest validation;
- changing both revision and expected digest passes;
- unsupported old revision still throws `BuiltinWorkflowRevisionChangedError`;
- worst-case prompt fixtures remain below explicit per-projection and total bounds while retaining route-driving IDs and truncation counts;
- full recorder entries/events and replay segments remain complete even when the corresponding model prompt is bounded;
- context-overflow recovery uses only a proven supported compaction hook and otherwise fails truthfully.

## Verification

Run focused checks while implementing each slice, then the repository gates once at the end:

1. `npx vitest run test/executor.test.ts test/deferred-turn.test.ts test/step-message.test.ts test/workflow-tool-input.test.ts test/workflow-tool-provider.test.ts`
2. `npx vitest run test/builtin-autoimplement.test.ts test/autoimplement-command-batches.test.ts test/review-fixes.test.ts`
3. `npx vitest run test/monitor-workflow.test.ts test/monitor-repair.test.ts`
4. `npx vitest run test/run-discovery.test.ts test/store.test.ts test/cli.test.ts test/render.test.ts test/catalog.test.ts`
5. Run the affected real CLI surfaces against temporary fixture bundles: `omp-workflows runs`, exact parent/child status, and `omp-workflows doctor <runId>`.
6. Run one interactive OMP smoke: start a one-step workflow, observe exact envelope, simulate one unactivated delivery, resume after Escape, and submit successfully.
7. Run one monitor smoke: force an observation timeout, verify the truthful retry notice and in-process scheduled wait, then cancel and verify immediate exit.
8. Run the repository's normal final type, test, package, and compatibility gates.
9. Run `npx -y @simpledoc/simpledoc check` after documentation updates.

No implementation claim is complete from unit tests alone: activation/hold behavior needs the interactive smoke, CLI diagnostics need the actual CLI, and monitor retry/cancel needs the monitor runtime.

## Rollout

1. Land the shared submit instruction and activation/provider lifecycle tests first; preserve current tool schema and hold semantics.
2. Land autoimplement review and blocker graph changes together with the built-in revision and digest bump required by their canonical definition changes.
3. Land monitor graph recovery with its own monitor revision and digest bump.
4. Land fast discovery and read-only diagnostics without changing persisted data.
5. Land bounded prompt projections and prove recorder completeness before enabling context-overflow retry.
6. Release as one package version after all built-in revision pins, upgrade fixtures, focused tests, CLI smokes, and interactive smokes pass.
7. On rollback, older code may read all existing bundles because no schema changed. Runs started under unavailable newer built-in revisions fail closed with the existing restart guidance rather than resuming under a different graph.

## Acceptance criteria

1. A sent interactive step message with no `agent_start` is retriggered within a bounded local window, never duplicates an acknowledged turn, and never wakes while held after Escape.
2. Initial, reminder, and resume messages each expose the exact current `{ action, step, attempt, output }` submit envelope once. Interactive and RPC parsers use the same exact action schema; flat provider schemas and host `i` stripping remain intact.
3. Structured provider failures are classified before settlement handling. Provider 404 does not consume semantic nudge budget; retryable and terminal failures follow separate bounded paths.
4. `assessReview` timeout reuses the persisted successful `runReview` batch for one reassessment and cannot rerun `omp-reviewer` only for assessment recovery.
5. Consecutive monitor observation timeouts retry only through the existing schedule/sleep loop, stop at a fixed bound, report only known timeout facts, never enter repair without authorization, and remain immediately cancellable.
6. Every `challengeBlocker` continuation carries a validated origin and returns through a safe stage-specific re-entry. No path skips required verification, publication, reviewer, comment, CI, or delivery gates.
7. List, status, viewer, and duplicate-live matching derive continuation family state from existing `parentRunId` while leaving the parent bundle unchanged.
8. Normal list/status use the fast projection and show bounded integrity warnings. Deep diagnostics are explicit, read-only, and cover bundle, trace, session, decision, and continuation consistency.
9. Every built-in catalog revision is paired with the canonical `createDefinitionSnapshot` digest, and a snapshot change under an unchanged revision fails tests.
10. Model-facing prompt projections have tested bounds, context-overflow recovery uses only supported OMP/Pi compaction behavior, and full trace/session run-bundle replay remains complete.
11. No new persisted schema, database, alternate supervisor, or speculative executor is introduced.
12. The documentation-specific SimpleDoc check passes for this file.
