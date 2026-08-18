# Workflow composition

This specification defines how one Pi Workflows graph can include another graph. An included workflow keeps one source definition and can still run on its own. The parent supplies its input and connects each named exit to the next parent node.

This specification is proposed and not yet implemented. Work is tracked in the [workflow composition plan](plans/2026-08-19-workflow-composition-plan.md).

## Minimal example

The included workflow starts at `startAt` and declares one or more named exits.

```typescript
import { agent, compute, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "autoimplement",
  startAt: "implement",
  exits: {
    fixed: { from: "finish" },
    blocked: { from: "blocked" },
  },
  nodes: {
    implement: agent({
      prompt: ({ input }) => `Implement ${(input as { task: string }).task}`,
      expectedOutput: `{ "route": "fixed" | "blocked", "summary": "result" }`,
    }),
    finish: compute({ run: ({ outputs }) => outputs.implement }),
    blocked: compute({ run: () => ({ reason: "repair could not continue" }) }),
  },
  edges: [
    {
      from: "implement",
      switch: {
        on: "$.route",
        cases: { fixed: "finish", blocked: "blocked" },
      },
    },
  ],
});
```

A parent includes it under the name `repair`. The input function maps parent state to the included workflow input each time the parent enters `repair`.

```typescript
import { agent, compute, defineWorkflow, includeWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "monitor-with-repair",
  startAt: "check",
  includes: {
    repair: includeWorkflow({
      workflow: "autoimplement",
      input: ({ outputs }) => ({
        task: (outputs.check as { issue: string }).issue,
      }),
    }),
  },
  nodes: {
    check: agent({
      prompt: () => "Check the target and report continue, repair, or stop.",
    }),
    wait: compute({ run: () => ({ route: "check" }) }),
    finish: compute({ run: ({ outputs }) => outputs.check }),
  },
  edges: [
    {
      from: "check",
      switch: {
        on: "$.route",
        cases: { continue: "wait", repair: "repair", stop: "finish" },
      },
    },
    { from: "wait", to: "check" },
    { from: "repair.fixed", to: "check" },
    { from: "repair.blocked", to: "finish" },
  ],
});
```

`repair` is the included workflow's only entry. `repair.fixed` and `repair.blocked` are its named exits. The parent cannot connect to internal nodes such as `implement` or `finish`.

## Goals

Workflow composition must provide these properties:

- A workflow has one implementation whether it runs alone or inside another workflow.
- Inclusion is visible in the parent definition.
- The parent maps input without changing the included workflow.
- The included workflow has one entry and multiple named exits.
- Included callbacks see only their current invocation and its local data.
- The parent sees only the included workflow's declared result.
- Pause, cancellation, and timeout behavior remain part of one run.
- Checkpoints and user-facing reports also remain in that run.
- A run records every source used to build its graph and refuses unsafe resume after a source change.
- Controllers remain the mechanism for independent, parallel, or indefinitely reconciled child runs.

## Public definition API

### Included workflows

`includeWorkflow()` creates an inclusion declaration. It does not run work and is not a workflow node.

```typescript
type WorkflowIncludeDefinition = {
  workflow: string;
  input?: (context: WorkflowNodeContext) => MaybePromise<unknown>;
};
```

`workflow` accepts the same stable references as `/workflow`:

- a discovered project, global, or built-in workflow name;
- an explicit built-in reference such as `builtin:monitor`;
- a workflow file path.

A relative path is resolved from the file that declares the inclusion. A built-in workflow cannot use a relative file path because it has no source directory. An absolute path keeps its existing meaning.

The `input` function is optional. Omission passes the parent workflow input unchanged. The function runs on every entry and can read the parent input plus prior node data and run state. It must be pure. Its JSON-serializable result becomes the included workflow input and is persisted before the included start node runs.

A workflow definition can declare several includes under different mount names:

```typescript
includes: {
  repair: includeWorkflow({ workflow: "autoimplement", input: mapRepair }),
  audit: includeWorkflow({ workflow: "review", input: mapAudit }),
}
```

The same workflow can be included more than once. Each mount has separate state.

### One entry

`startAt` remains the only workflow entry. Inclusion does not add alternate start nodes.

Several parent edges may target the same mount. Every entry starts at the included workflow's `startAt` node with a fresh invocation. A workflow that needs a reusable later phase should make that phase a smaller workflow and include it. This keeps earlier required work from being skipped.

### Named exits

A reusable workflow declares exits at the top level:

```typescript
exits: {
  fixed: { from: "finish" },
  unchanged: { from: "no_change" },
  blocked: { from: "blocked" },
}
```

An exit name follows the workflow node naming rules. `from` must name a node in that workflow. The node must have no outgoing edge. One node can define at most one exit.

When the workflow runs alone, its final output stays the terminal node output. The run state can also record the matching exit name. This preserves current standalone output behavior.

When the workflow is included, a named exit produces this parent-visible value:

```json
{
  "exit": "fixed",
  "output": {
    "summary": "repair completed"
  }
}
```

The value is stored at `outputs.<mount>`, such as `outputs.repair`. The parent routes from `<mount>.<exit>`, such as `repair.fixed`.

An unconnected included exit completes the parent successfully with the parent-visible value. Graph validation and viewers must show the exit as terminal so an omitted edge is visible.

An unhandled node failure, timeout, or cancellation does not become a successful named exit. It keeps the existing run outcome unless the included graph routes that node result to a declared terminal exit. This lets an included workflow make expected blocked states explicit without hiding unexpected failures.

### Input and exit validation

Workflow definitions may declare input validation that applies both to standalone runs and included invocations:

```typescript
input: {
  expected: `{ "task": "work to complete" }`,
  validate: (value) => validateAutoimplementInput(value),
}
```

An exit may validate or normalize the terminal output:

```typescript
exits: {
  fixed: {
    from: "finish",
    expectedOutput: `{ "summary": "completed work" }`,
    validate: (value) => validateFixedResult(value),
  },
}
```

Validation runs before the normalized value is persisted. Validation failure stops the invocation and records a bounded error. Pi Workflows does not require a schema library. Authors can use TypeBox, another validator, or a plain function.

Existing workflows without an `input` declaration keep accepting JSON-serializable input. A workflow must declare `exits` before another workflow can include it.

## Parent graph syntax

Mount names share the workflow node naming rules and must not collide with parent node names. Dots remain invalid in node and mount names because the parent syntax reserves one dot between a mount and an exit.

An authored edge can use these references:

- `to: "repair"` enters the included workflow.
- `from: "repair.fixed"` leaves its `fixed` exit.
- `from: "repair.blocked"` leaves its `blocked` exit.

No authored edge may name an included internal node. Nested includes use their own local mount names. Internal qualified names appear only in the resolved graph and run records.

Every ordinary parent node still has at most one outgoing edge. Every included exit also has at most one outgoing parent edge.

## Resolution and graph construction

Composition is resolved before a run starts.

1. Resolve the root workflow source.
2. Resolve every included workflow through the existing project, global, built-in, or path lookup rules.
3. Repeat for nested includes.
4. Reject a source cycle and report the full mount chain.
5. Validate every root and included graph on its own.
6. Validate mount names, input declarations, exit declarations, and parent edge references.
7. Build one executable graph with qualified internal node identities and inclusion metadata.
8. Freeze the source list and resolved graph before writing `run_started`.

Resolution is eager. Every declared include must exist even when the current input will not take that branch. Dynamic workflow references are excluded because they would make the graph and source set change during a run.

Including the same source at two different mount paths is allowed. Including an ancestor source beneath itself is a cycle and is rejected.

Internal node identities use the mount path, for example `repair/implement` and `outer/repair/verify`. The slash form cannot collide with an authored node ID. Author callbacks continue to use local names such as `outputs.implement`.

## Runtime behavior

### Scoped callback context

A callback inside an included workflow receives a local view:

- `input` is the mapped and validated included input.
- `outputs` contains outputs from the current invocation under local node names.
- `results` contains results from the current invocation under local node names.
- `state.steps` contains the current invocation's steps with local node names.
- `state.currentNode` uses the local node name while the included workflow runs.
- `signal` is the parent run's active cancellation and timeout signal.
- `runId` remains the parent run ID wherever it is present in state or step contracts.

The included workflow cannot read parent outputs except through its mapped input. The parent cannot read internal included outputs. This keeps a workflow reusable and prevents accidental coupling to one parent graph.

### Re-entry

Each entry increments a mount-local invocation number and starts with empty local outputs and results. Prior invocation data cannot satisfy a callback in the new invocation.

The ordered step history and trace retain every invocation. The parent-visible `outputs.<mount>` value is replaced when the latest invocation reaches a named exit.

### Step limits

The parent `maxSteps` limits all real node attempts in the complete run. An included workflow's own `maxSteps` also limits each invocation of that workflow. The smaller applicable limit stops execution first.

Input and exit boundary transitions are persisted but do not count as model, compute, action, notify, or checkpoint steps.

### Timeouts and failures

Included nodes keep their declared node timeouts. Parent cancellation aborts the active included node. A checkpoint inside an included workflow creates the same continuation run used by an ordinary checkpoint and resumes at the qualified included location.

Unhandled included failures preserve `failed`, `timed_out`, or `cancelled`. The parent cannot convert them to success by wiring an exit because named exits are reached only through successful terminal nodes.

### Reports and presentation

Notify nodes and workflow updates keep their current behavior. Their persisted node identity includes the mount path, which prevents duplicate identities when the same workflow is mounted twice.

Only the root workflow can produce a final presentation. An included workflow's `presentationPrompt` is ignored during inclusion and remains active when that workflow runs alone. Its title is retained as viewer metadata but does not replace the parent run title.

## Persistence and resume

Composition extends the current run bundle without adding another run or store.

### Source set

The manifest records the root source and every included source:

```json
{
  "workflowSource": {
    "kind": "file",
    "path": "/path/to/monitor.workflow.ts",
    "hash": "1111111111111111111111111111111111111111111111111111111111111111"
  },
  "workflowSources": [
    {
      "mountPath": ["repair"],
      "workflowName": "autoimplement",
      "source": {
        "kind": "file",
        "path": "/path/to/autoimplement.workflow.ts",
        "hash": "2222222222222222222222222222222222222222222222222222222222222222"
      }
    }
  ],
  "definitionDigest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

`workflowSources` is sorted by mount path. Nested paths contain one array item per mount level. `definitionDigest` uses `sha256:` followed by 64 lowercase hexadecimal characters. No credential or source file content is copied into this record.

Resume resolves the root and full included source set again. A missing source, changed file hash, changed built-in revision, changed mount path, or changed resolved definition digest refuses resume with a source-change error. A force-resume option keeps its existing explicit meaning and must name the mismatch in the resulting audit evidence.

### Definition snapshot

`workflow.json` stores the resolved nodes and edges used by the engine. It also stores mount metadata with the workflow name, mount path, start node, and named exits. Existing readers can continue to render the resolved flat graph. Updated viewers can group nodes by mount.

The definition snapshot remains the graph authority for replay. Source files are required only to execute or resume callbacks.

### Trace and state

The trace adds `include_entered` and `include_exited` event types. Their payloads contain the mount path, invocation number, included workflow name, and declared exit when applicable. The entered event contains the mapped input, subject to normal artifact externalization. The exited event contains the parent-visible output.

Qualified node IDs identify included attempts in trace and step records. The state projection keeps the latest parent-visible mount output and enough entry data to rebuild a local callback view after restart. The trace remains the source of truth.

These are additive version 1 fields and event types. Existing readers must continue to ignore fields and event types they do not understand. If implementation requires changing the meaning of an existing field instead of adding data, the affected schema identifier must change.

## Validation errors

Resolution fails before `run_started` for these conditions:

- an included reference cannot be resolved;
- a relative include path is declared by a source without a directory;
- an include cycle exists;
- a mount collides with a node or another mount;
- an included workflow declares no exits;
- an exit name is invalid or duplicated;
- an exit references an unknown or nonterminal node;
- two exits reference the same node;
- a parent edge references an unknown mount or exit;
- a parent edge attempts to reference an included internal node;
- a composed node identity collides after qualification;
- a source set or resolved definition differs during resume.

Runtime input or exit validation errors are recorded as invocation failures because their values depend on runtime data.

## Viewer behavior

Viewers should show an included workflow as a group labeled with its mount and workflow name. Expanded views show internal nodes. Collapsed views show the active internal node, invocation count, latest exit, and outcome.

Replay uses the resolved definition snapshot and trace. It does not load source files. Older viewers may show the qualified nodes as a flat graph and remain correct.

## Controller boundary

Same-run composition and controller child workflows solve different problems.

Use inclusion when work should share one run, one conversation, one pause and cancellation state, and one final result. Use a controller child workflow when work needs independent retries, parallel execution, a separate run bundle, a stable request key, or an indefinite resource lifecycle.

A workflow cannot start another independent workflow recursively through the model tool. This specification does not change that rule.

## Monitor repair example

A repair-capable monitor can report a detected bug, route to an included `autoimplement` workflow, and return to checking after the `fixed` exit. The monitor detects the issue, contains unsafe work, and decides whether the repair stays within the approved objective. Autoimplement owns the repair, its checks and review, the merge, and deployment.

The parent passes the issue, evidence, repository, allowed scope, and success criteria through the include input. It does not copy autoimplement prompts or graph nodes. A change to model choice, benchmark method, credentials, hardware, spending authorization, or another protected decision must route to a blocked exit or stop before repair.

## Compatibility

Existing workflows without `includes`, `input`, or `exits` run unchanged. Existing controller child workflows also remain unchanged.

This feature is a compatible public API addition for the current pre-1.0 package and should ship in the next minor release. A workflow that wants to be included opts into the exit contract. No migration rewrites existing workflow files or terminal run bundles.

## Contract impact

- **Session state:** included agent nodes create the same normal Pi messages and tool results as ordinary workflow nodes. No new Pi session entry type is required.
- **Other persistent data:** run manifests, definition snapshots, state projections, and traces gain the additive composition data defined above.
- **Pi internals:** none.
- **Public Pi API:** existing documented extension hooks only.
- **Public Pi Workflows API:** `includeWorkflow()`, workflow `includes`, workflow `input`, and workflow `exits`.

## Conformance tests

An implementation must verify:

- standalone behavior of a workflow that declares exits;
- one include with one exit and one include with several exits;
- input mapping and input normalization;
- exit output validation and parent-visible output;
- two mounts of the same workflow with isolated state;
- nested includes;
- re-entry with no stale local outputs or results;
- parent and per-invocation step limits;
- failure and timeout propagation, plus cancellation;
- checkpoint continuation from inside an include;
- notify and update identity under two mounts;
- top-level presentation with included presentation suppressed;
- project and global source resolution;
- built-in, absolute-path, and relative-path resolution;
- eager rejection of missing references and source cycles;
- resume with identical sources and rejection after any included source changes;
- definition snapshot replay without source files;
- flat rendering by existing viewers and grouped rendering by updated viewers;
- real-Pi execution of a monitor that repairs through the existing autoimplement workflow and then resumes checking.
