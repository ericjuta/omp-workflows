# Controller runtime specification

Pi Workflows runs finite TypeScript graphs. A graph starts with an input, follows explicit edges, and ends with a result or checkpoint. This works well for one bounded task.

Long-running automation has a different job. It must keep comparing a requested state with the current state of another system. Events can arrive more than once, processes can stop between an external request and its local receipt, and the external state can change while work is running.

This specification adds a Kubernetes-style controller runtime to Pi Workflows. The controller runtime sits beside the graph engine. Controllers manage durable resources, while workflows remain finite jobs that a controller can start and observe.

The design follows the Kubernetes [controller pattern](https://kubernetes.io/docs/concepts/architecture/controller/), its [`spec` and `status` split](https://kubernetes.io/docs/concepts/overview/working-with-objects/), and the [idempotent reconciliation guidance](https://book.kubebuilder.io/reference/good-practices).

## Scope

The controller runtime provides:

- Durable desired and observed state.
- Level-based reconciliation from current facts.
- A deduplicated work queue with delayed retries.
- Compare-and-swap writes for concurrent workers.
- Recoverable records for external effects.
- Child workflow runs with stable request keys.
- Conditions and generations, with cleanup and structured events.
- Local interactive use through the Pi extension and headless use through the engine API.

The first production use case is pull request automation. A controller can observe a pull request, start a review or repair workflow, wait for checks, validate the current head, and apply an approved change through deterministic code.

## Boundaries

The graph engine remains the execution layer for finite work. It does not import the controller runtime. The controller runtime may start workflows through a narrow scheduler interface.

The Pi extension is a host. It discovers definitions, displays status, and supplies the conversation-backed agent executor while Pi is running. A headless host can use the same controller runtime with another `AgentStepExecutor`.

External events are wake-up hints. An event enqueues a resource key and carries no transition command. The reconciler reloads the resource and the external system before deciding what to do.

## Resource model

A resource is the durable record of one requested outcome. The controller owns `status`; callers own `spec`.

```ts
export type ControllerResource<TSpec, TStatus> = {
  metadata: {
    uid: string;
    key: string;
    resourceVersion: number;
    generation: number;
    deletionTimestamp?: string;
    finalizers?: string[];
  };
  spec: TSpec;
  status: {
    observedGeneration: number;
    conditions: ControllerCondition[];
    workflowRun?: {
      runId: string;
      inputFingerprint: string;
    };
    controllerStatus: TStatus;
  };
};

export type ControllerCondition = {
  type: string;
  status: true | false | "unknown";
  reason: string;
  message?: string;
  observedGeneration: number;
  lastTransitionTime: string;
};
```

`uid` stays stable for the life of the resource and is never reused. `resourceVersion` changes after every write and acts as the compare-and-swap token. `generation` changes only when `spec` changes. A condition describes the latest known state for one stable condition type.

`observedGeneration` shows which desired state produced the current status. A controller must not report a resource as ready when its conditions came from an older generation.

## Controller contract

A controller receives the latest resource, a cancellation signal, and runtime services. It returns after one bounded reconciliation pass.

```ts
export default defineController<PullRequestSpec, PullRequestStatus>({
  name: "pull-request",

  async reconcile(ctx, resource) {
    const pullRequest = await ctx.github.getPullRequest(resource.spec);

    if (pullRequest.merged) {
      return ctx.settled({
        conditions: [ctx.condition.true("Ready", "Merged")],
      });
    }

    if (pullRequest.headSha !== resource.spec.expectedHeadSha) {
      return ctx.settled({
        conditions: [ctx.condition.false("Ready", "HeadChanged")],
      });
    }

    const run = await ctx.workflows.ensure({
      key: `repair:${resource.uid}:${resource.generation}:${pullRequest.headSha}`,
      workflow: "repair-pull-request",
      input: { repository: resource.spec.repository, number: pullRequest.number },
    });

    if (run.state !== "succeeded") {
      return ctx.requeueAfter(30_000);
    }

    await ctx.effects.ensure({
      key: `merge:${resource.uid}:${resource.generation}:${pullRequest.headSha}`,
      request: {
        repository: resource.spec.repository,
        number: pullRequest.number,
        expectedHeadSha: pullRequest.headSha,
      },
      observe: () => ctx.github.observeMerge(resource.spec),
      apply: () => ctx.github.merge(resource.spec, pullRequest.headSha),
    });

    return ctx.requeue();
  },
});
```

The runtime supports three normal results. `settled` removes the key from the queue until another event arrives. `requeue` asks for another pass as soon as capacity is available. `requeueAfter` schedules a later pass.

A returned error receives exponential backoff with jitter. A controller records a durable condition and returns `settled` for a problem that requires new input. Reconciliation retries do not depend on the event that caused the first attempt.

## Work queue

The queue contains one row for each controller and resource key. Repeated enqueue calls update that row instead of adding copies. A worker claims a key with an opaque claim token and an expiry time. The runtime prevents concurrent reconciliation of the same key.

A claim that expires returns to the queue. A successful settled result removes the queue row. A requested delay updates its available time. Consecutive errors increase an internal retry counter used for backoff.

The first implementation uses SQLite in WAL mode. Transactions cover resource compare-and-swap writes, queue claims, and effect claims. `ControllerStore` and `ControllerQueue` remain interfaces so another host can supply a remote implementation.

The resource store is the source of truth. Queue rows only describe delivery. The queue can be rebuilt from resources and pending wake times when repair is needed.

## External effects

An external effect can succeed while the local process is unable to save the response. The runtime records each effect before calling the provider.

```ts
export type EffectRecord = {
  key: string;
  resourceUid: string;
  generation: number;
  requestFingerprint: string;
  state: "pending" | "applied" | "rejected" | "indeterminate";
  externalRef?: string;
  startedAt: string;
  completedAt?: string;
};
```

The key names one intended effect. Reusing the key with another request fingerprint is an error. A pending effect becomes indeterminate when its worker disappears before recording a result.

The next reconciliation observes the external system before retrying an indeterminate effect. The effect can be treated as effectively once when the provider offers an idempotency token, a conditional request, or a reliable way to observe the requested result. The runtime does not promise generic exactly-once execution.

Credentials and mutation policy stay in deterministic effect drivers. Agent workflows receive only the access they need to inspect and edit their work area. They return findings or artifacts for deterministic code to check and apply.

## Child workflows

`ctx.workflows.ensure()` creates or finds a workflow run by a stable request key and input fingerprint. Repeated reconciliations find the same active or completed request. A changed input must use a new key.

A child run is one immutable attempt. Its existing run bundle remains the execution record. The parent resource points to the current run, and workflow completion enqueues the parent key. A host restart can mark an abandoned run as interrupted and create another attempt for the same stable request.

Recovery rules depend on node type. Compute nodes can run again. External actions must use the effect API. An interrupted agent node returns an explicit interrupted outcome so the workflow can inspect its work area and continue safely.

## Deletion and cleanup

Setting `deletionTimestamp` requests deletion. A controller with a finalizer first removes external resources it owns, then removes its finalizer. The store deletes the resource after the finalizer list becomes empty.

Controllers should add finalizers only when they own something that needs cleanup, such as an isolated worktree or a remote action session. Ordinary completed resources can remain as history or be removed by a separate retention policy.

## Sources and workers

A source maps an external event to one or more resource keys. Sources include filesystem watches, webhooks, scheduled polling, and child workflow completion. They share the same enqueue API.

`ControllerManager` sets global and per-controller worker limits. The local store supports expiring claims from the start, while the first release can run one process. Leader election belongs in a remote store implementation if several hosts later share the same resources.

The Pi extension starts local sources during `session_start` and closes them during `session_shutdown`. It can reconcile only while Pi is running. A temporary CLI or CI process can run the manager independently; the package does not install a service.

## Observability

Every reconciliation emits structured records with the controller name, resource key, generation, reconcile ID, outcome and duration, plus the requeue reason. Effect state changes and child workflow links are also recorded. Logs and viewer projections remain secondary to the resource and effect stores.

The viewer should list resources by condition and show the active child run. Existing run views continue to read immutable bundles.

## Safety rules

A production controller must follow these rules:

- Read current external state on every reconciliation.
- Check authorization and target boundaries in deterministic code.
- Use provider-side preconditions for consequential writes when available.
- Save status with the resource version that was read.
- Reconcile again after each consequential external effect.
- Keep model output separate from mutation authority.
- Bound worker counts and retry rates. Also bound timeouts and stored payload sizes.
- Redact credentials and private provider responses from logs and run bundles.

## Package and Pi integration

The controller API should use a subpath export such as `@osolmaz/pi-workflows/controllers`. Controller definitions can use a `.controller.ts` suffix and project or global discovery directories that mirror workflow discovery.

The implementation uses documented Pi extension APIs only. Commands and tools use `registerCommand` and `registerTool`. Session lifecycle uses `session_start` and `session_shutdown`. Workflow prompts use `sendUserMessage`, while status uses `setWidget` and `setStatus`.

Normal workflow prompts, tool calls, and replies remain part of the Pi session. Controller resources, queue rows, and effects live in the controller store. No Pi internal type, private API, or persistent Pi schema changes.

## Exclusions

This specification does not add Kubernetes API compatibility, YAML resources, a cluster scheduler, or a general distributed database. GitHub policy and credentials belong in a provider adapter, leaving the controller core independent of GitHub. The first release also excludes automatic service installation and generic exactly-once claims.
