---
title: Add declarative workflow composition
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-19
---

# Add declarative workflow composition

Pi Workflows needs a direct way to reuse one workflow inside another without copying nodes, prompts, or routing logic. The first use case is a monitor that reports a fixable bug, runs the existing autoimplement workflow, and resumes checking after the repair. The same mechanism must work for other finite workflows.

The canonical behavior is specified in [Workflow composition](../WORKFLOW_COMPOSITION.md).

## Outcome

Workflow authors will be able to include a standalone workflow under a mount name, map parent state to its single input, and connect its named exits to parent nodes. Pi Workflows will resolve one immutable graph and execute it as one run.

The same workflow definition will work alone, as an include, or as a controller-started child run. Inclusion will handle same-run reuse. Controllers will keep handling independent and long-running work.

## Scope

- Add a general `includeWorkflow()` declaration.
- Add optional workflow input validation.
- Add named workflow exits.
- Resolve every supported workflow source before a run starts.
- Support nested includes and repeated mounts of one source.
- Give included callbacks a local view of their input and current node state.
- Preserve per-invocation state and step limits across loops and resume.
- Record every source and the resolved definition digest.
- Persist include entry and exit events in the existing run bundle.
- Add grouped include rendering while keeping flat replay valid.
- Update the autoimplement example with a named exit.
- Add a monitor-with-repair example that includes autoimplement instead of copying it.
- Document the authoring and persistence contracts.

## Non-goals

- Do not let a workflow start an independent workflow run.
- Do not replace controller child workflow scheduling.
- Do not add multiple workflow entries.
- Do not permit dynamic workflow references that change after a run starts.
- Do not expose included internal nodes as parent connection points.
- Do not add a Pi core API, private Pi integration, persistent service, or second run store.
- Do not rewrite existing workflow files or terminal run bundles.

## Public API

Add these compatible fields and helper:

```typescript
type WorkflowDefinition = {
  // existing fields
  input?: WorkflowInputDefinition;
  exits?: Record<string, WorkflowExitDefinition>;
  includes?: Record<string, WorkflowIncludeDefinition>;
};

function includeWorkflow(definition: {
  workflow: string;
  input?: (context: WorkflowNodeContext) => MaybePromise<unknown>;
}): WorkflowIncludeDefinition;
```

The parent enters an include by its mount name and leaves through `<mount>.<exit>`. One workflow keeps one `startAt`. Exit declarations name successful terminal nodes.

The workflow layer should remain independent of Pi. The resolver receives the existing search paths and built-in catalog through public workflow-layer interfaces.

## Implementation order

### Definition and graph validation

1. Add the new public definition types to `src/workflows/types.ts`.
2. Add `includeWorkflow()` to `src/workflows/definition.ts` and export it.
3. Extend shape checks for mount and exit names, unknown fields, and callback types.
4. Extend graph validation for terminal exits, node and mount collisions, entry targets, and exit edge sources.
5. Add table-driven tests for valid and invalid definitions.

### Source resolution

1. Add an asynchronous composition resolver beside the existing loader.
2. Resolve names with the current source precedence.
3. Resolve relative paths from the including file.
4. Build a stable source list keyed by mount path.
5. Detect recursive source chains before graph execution.
6. Reject missing includes and invalid source contexts before `run_started`.
7. Expose the resolver for hosts that use `WorkflowEngine` outside Pi.

### Execution

1. Build qualified internal node identities from mount paths.
2. Run and persist the input mapping before the included start node.
3. Give included callbacks a local view with unqualified node names.
4. Start each re-entry with empty included outputs and results.
5. Preserve the parent run ID and cancellation signal.
6. Emit the parent-visible `{ exit, output }` value at a named exit.
7. Apply both the parent run step limit and the included workflow's per-invocation limit.
8. Preserve all current control and reporting behavior.
9. Use only the root workflow's presentation prompt.

### Persistence and resume

1. Add the sorted included source set and resolved definition digest to run metadata.
2. Add mount metadata to the definition snapshot.
3. Add `include_entered` and `include_exited` trace events.
4. Keep qualified node identities in steps and node events.
5. Rebuild the current included invocation from the trace after interruption.
6. Refuse resume when any included source or resolved definition differs.
7. Verify that existing readers can ignore the additive fields and events.
8. Bump a schema identifier only if implementation changes an existing field's meaning.

### Viewer and examples

1. Keep the current flat graph renderer correct for resolved graphs.
2. Add optional grouped rendering for mount paths.
3. Show the mount name, workflow name, invocation, active internal node, and latest exit.
4. Update the autoimplement example so `finalize` is a named successful exit.
5. Add a monitor-with-repair example that reports the issue, enters autoimplement, and resumes monitoring after repair.
6. Update `docs/workflows.md`, `docs/run-bundles.md`, README examples, and the bundled authoring skill after behavior ships.

## Data and compatibility review

The implementation must keep one trace as the source of truth. State and viewer data remain projections. Include input and output values use the existing artifact externalization rules.

Run bundle version 1 permits additive fields and event types. The source set and definition digest can therefore remain optional for old runs. New composed runs require them. New code must not add a fallback that resumes a composed run without checking every source.

The public API addition should use the repository's pre-1.0 minor-release convention. The planned release is `0.10.0` if no earlier release changes the next version.

## Acceptance criteria

- A workflow with declared exits behaves exactly as before when run alone.
- A parent can include the global autoimplement workflow with one input mapping and no copied autoimplement nodes.
- Named exits route to different parent nodes.
- Two mounts of one workflow do not share current outputs or results.
- Re-entering one mount cannot read values from its prior invocation.
- Nested composition resolves and resumes from an immutable source set.
- Included workflows preserve ordinary failure and timeout behavior.
- Cancellation, checkpoints, and reports also keep their current behavior.
- Parent and included step limits both apply.
- The definition snapshot can replay without loading source files.
- Changing any included source prevents normal resume.
- Existing workflows, controller child runs, and old terminal bundles remain valid.
- Pi Workflows adds no Pi internal dependency or new persistent service.

## Verification

Run focused tests while implementing:

```bash
npx vitest run test/graph.test.ts test/loader.test.ts test/engine.test.ts test/run-resume.test.ts
npx vitest run test/graph-verify.test.ts test/examples.test.ts test/e2e/workflow.e2e.test.ts
```

Run the repository gates before merge:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
git diff --check
```

The real-Pi test must load a parent and included workflow from their intended scopes, run the repair branch, return through a named exit, resume the parent graph, inspect the stored source set and trace, and verify that only the parent creates final presentation output.

## Contract impact

- **Session state:** normal workflow agent messages and tool results only.
- **Other persistent data:** additive source and composition metadata plus new trace events.
- **Pi internals:** none.
- **Public Pi API:** existing documented extension APIs only.
- **Public Pi Workflows API:** workflow input and exits plus `includeWorkflow()` and workflow `includes`.
