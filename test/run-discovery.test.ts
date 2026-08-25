import { describe, expect, it } from "vitest";
import {
  findMatchingLiveRuns,
  isLiveWorkflowStatus,
  overlayContinuationFamilies,
  selectRecentRuns,
  summarizeRunBundle,
  workflowTaskFingerprint,
} from "../src/workflows/run-discovery.js";
import type { LoadedRunBundle } from "../src/workflows/store.js";

function runBundle(options: {
  runId: string;
  workflowName?: string;
  status?: string;
  startedAt?: string;
  input?: unknown;
  paused?: boolean;
  project?: string;
  parentRunId?: string;
}): LoadedRunBundle {
  const workflowName = options.workflowName ?? "monitor";
  const status = options.status ?? "completed";
  const startedAt = options.startedAt ?? "2026-08-22T00:00:00.000Z";
  return {
    runDir: `/runs/${options.runId}`,
    manifest: {
      schema: "pi-workflows.run-bundle.v1",
      runId: options.runId,
      workflowName,
      startedAt,
      status,
      traceSchema: "pi-workflows.trace-event.v1",
      paths: { workflow: "workflow.json", state: "state.json", trace: "trace.ndjson" },
    },
    state: {
      schema: "pi-workflows.run-state.v1",
      traceSeq: 0,
      runId: options.runId,
      workflowName,
      startedAt,
      updatedAt: startedAt,
      status,
      input: options.input ?? {},
      outputs: {},
      results: {},
      steps: [],
      ...(options.paused !== undefined ? { paused: options.paused } : {}),
      ...(options.parentRunId !== undefined ? { parentRunId: options.parentRunId } : {}),
    },
    snapshot: null,
    sessionBinding:
      options.project === undefined
        ? null
        : {
            schema: "pi-workflows.session-binding.v1",
            runId: options.runId,
            piSessionId: `session-${options.runId}`,
            cwd: options.project,
            boundAt: startedAt,
          },
    sessionEntries: [],
    sessionEvents: [],
    sessionCapture: null,
    sessionIntegrity: { status: "unavailable", diagnostics: [] },
    sessionSegments: [],
  } as LoadedRunBundle;
}

describe("workflow run discovery", () => {
  it("recognizes live, waiting, queued, and paused runs", () => {
    expect(isLiveWorkflowStatus("running")).toBe(true);
    expect(isLiveWorkflowStatus("waiting")).toBe(true);
    expect(isLiveWorkflowStatus("queued")).toBe(true);
    expect(isLiveWorkflowStatus("completed", true)).toBe(true);
    expect(isLiveWorkflowStatus("completed")).toBe(false);
  });

  it("normalizes task fingerprints and rejects missing tasks", () => {
    expect(workflowTaskFingerprint({ task: "  Watch\n PR   123  " })).toBe("watch pr 123");
    expect(workflowTaskFingerprint({ problem: " Fix   CI " })).toBe("fix ci");
    expect(workflowTaskFingerprint({ task: "x".repeat(300) })).toHaveLength(240);
    expect(workflowTaskFingerprint({ task: "   " })).toBeNull();
    expect(workflowTaskFingerprint({ task: 42 })).toBeNull();
    expect(workflowTaskFingerprint(null)).toBeNull();
  });

  it("summarizes optional run and project fields", () => {
    const bundle = runBundle({
      runId: "run-1",
      status: "waiting",
      paused: true,
      project: "/repo",
    });
    bundle.state.currentNode = "review";
    bundle.state.waitingOn = "human";
    bundle.state.runTitle = "Review changes";

    expect(summarizeRunBundle(bundle)).toEqual({
      runId: "run-1",
      workflowName: "monitor",
      status: "waiting",
      startedAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
      paused: true,
      currentNode: "review",
      waitingOn: "human",
      runTitle: "Review changes",
      project: "/repo",
    });
  });

  it("sorts, filters, and limits recent runs", () => {
    const bundles = [
      runBundle({
        runId: "older-live",
        status: "running",
        startedAt: "2026-08-20T00:00:00.000Z",
        project: "/repo/a",
      }),
      runBundle({
        runId: "newer-live",
        status: "waiting",
        startedAt: "2026-08-22T00:00:00.000Z",
        project: "/repo/a/../a",
      }),
      runBundle({
        runId: "completed",
        startedAt: "2026-08-23T00:00:00.000Z",
        project: "/repo/a",
      }),
      runBundle({
        runId: "other-project",
        status: "running",
        startedAt: "2026-08-24T00:00:00.000Z",
        project: "/repo/b",
      }),
      runBundle({
        runId: "nested-project",
        status: "running",
        startedAt: "2026-08-25T00:00:00.000Z",
        project: "/repo/a/worktree",
      }),
      runBundle({
        runId: "repo-input",
        status: "queued",
        startedAt: "2026-08-26T00:00:00.000Z",
        input: { task: "ship", repository: "/repo/a/extra" },
      }),
    ];

    expect(selectRecentRuns(bundles, { liveOnly: true, project: "/repo/a", limit: 2 })).toEqual([
      expect.objectContaining({ runId: "repo-input" }),
      expect.objectContaining({ runId: "nested-project" }),
    ]);
    expect(selectRecentRuns(bundles, { liveOnly: true, project: "/repo/a", limit: 1 })).toEqual([
      expect.objectContaining({ runId: "repo-input" }),
    ]);
    expect(selectRecentRuns(bundles).map((run) => run.runId)).toEqual([
      "repo-input",
      "nested-project",
      "other-project",
      "completed",
      "newer-live",
      "older-live",
    ]);
  });

  it("matches coordinator cwd and target repository as independent projects", () => {
    const coordinatorCwd = "/repos/coordinator";
    const targetRepository = "/repos/target";
    const bundle = runBundle({
      runId: "coordinated-target",
      status: "running",
      project: coordinatorCwd,
      input: { task: "ship", repository: targetRepository },
    });

    expect(selectRecentRuns([bundle], { project: coordinatorCwd })).toEqual([
      expect.objectContaining({ runId: "coordinated-target", project: coordinatorCwd }),
    ]);
    expect(selectRecentRuns([bundle], { project: targetRepository })).toEqual([
      expect.objectContaining({ runId: "coordinated-target", project: coordinatorCwd }),
    ]);
  });

  it("matches only live runs with the same workflow and non-null fingerprint", () => {
    const bundles = [
      runBundle({
        runId: "match",
        workflowName: "autoimplement",
        status: "running",
        input: { task: "Ship  feature" },
      }),
      runBundle({
        runId: "finished",
        workflowName: "autoimplement",
        input: { task: "ship feature" },
      }),
      runBundle({
        runId: "other",
        workflowName: "monitor",
        status: "running",
        input: { task: "ship feature" },
      }),
    ];

    expect(
      findMatchingLiveRuns(bundles, {
        workflowName: "autoimplement",
        fingerprint: workflowTaskFingerprint({ problem: " ship feature " }),
      }),
    ).toEqual([expect.objectContaining({ runId: "match" })]);
    expect(
      findMatchingLiveRuns(bundles, { workflowName: "autoimplement", fingerprint: null }),
    ).toEqual([]);
  });

  it("collapses waiting parents with running and completed continuation children", () => {
    const parent = runBundle({
      runId: "parent",
      workflowName: "autoimplement",
      status: "waiting",
      input: { task: "ship feature" },
    });
    const parentBefore = JSON.stringify(parent);
    const runningChild = runBundle({
      runId: "child-running",
      workflowName: "autoimplement",
      status: "running",
      startedAt: "2026-08-22T01:00:00.000Z",
      parentRunId: "parent",
      input: { answer: "continue" },
    });

    expect(overlayContinuationFamilies([parent, runningChild])).toEqual([
      expect.objectContaining({
        runId: "child-running",
        parentRunId: "parent",
        continuationRunId: "child-running",
        status: "running",
        effectiveStatus: "running",
        input: { task: "ship feature" },
      }),
    ]);
    expect(
      findMatchingLiveRuns([parent, runningChild], {
        workflowName: "autoimplement",
        fingerprint: workflowTaskFingerprint({ task: "ship feature" }),
      }),
    ).toEqual([
      expect.objectContaining({
        runId: "child-running",
        parentRunId: "parent",
        continuationRunId: "child-running",
      }),
    ]);
    expect(JSON.stringify(parent)).toBe(parentBefore);

    const completedChild = runBundle({
      runId: "child-completed",
      workflowName: "autoimplement",
      status: "completed",
      startedAt: "2026-08-22T02:00:00.000Z",
      parentRunId: "parent",
    });
    const completedFamily = selectRecentRuns([parent, completedChild]);
    expect(completedFamily).toEqual([
      expect.objectContaining({
        runId: "child-completed",
        parentRunId: "parent",
        continuationRunId: "child-completed",
        status: "completed",
      }),
    ]);
    expect(
      findMatchingLiveRuns([parent, completedChild], {
        workflowName: "autoimplement",
        fingerprint: workflowTaskFingerprint({ task: "ship feature" }),
      }),
    ).toEqual([]);
    expect(JSON.stringify(parent)).toBe(parentBefore);
  });

  it("uses queued continuation facts to suppress duplicate waiting-parent matches", () => {
    const parent = runBundle({
      runId: "parent",
      workflowName: "autoimplement",
      status: "waiting",
      input: { task: "ship feature" },
    });
    const queueFacts = [
      {
        runId: "queued-child",
        parentRunId: "parent",
        status: "starting",
        startedAt: "2026-08-22T03:00:00.000Z",
      },
    ];

    expect(
      findMatchingLiveRuns(
        [parent],
        {
          workflowName: "autoimplement",
          fingerprint: workflowTaskFingerprint({ task: "ship feature" }),
        },
        queueFacts,
      ),
    ).toEqual([
      expect.objectContaining({
        runId: "queued-child",
        status: "queued",
        parentRunId: "parent",
        continuationRunId: "queued-child",
      }),
    ]);
  });

  it("discovers queue-only root runs for listing and duplicate matching", () => {
    const queueFacts = [
      {
        runId: "queued-root",
        parentRunId: null,
        status: "starting",
        startedAt: "2026-08-22T04:00:00.000Z",
        workflowName: "autoimplement",
        input: { task: "ship feature" },
        project: "/repo",
      },
    ];

    expect(selectRecentRuns([], { liveOnly: true, project: "/repo" }, queueFacts)).toEqual([
      expect.objectContaining({
        runId: "queued-root",
        workflowName: "autoimplement",
        status: "queued",
        effectiveStatus: "queued",
      }),
    ]);
    expect(
      findMatchingLiveRuns(
        [],
        {
          workflowName: "autoimplement",
          fingerprint: workflowTaskFingerprint({ task: "ship feature" }),
        },
        queueFacts,
      ),
    ).toEqual([expect.objectContaining({ runId: "queued-root", status: "queued" })]);
  });

  it("projects queue-only parked, completed, and failed run facts", () => {
    const runs = selectRecentRuns([], undefined, [
      {
        runId: "parked-root",
        parentRunId: null,
        status: "parked",
      },
      {
        runId: "completed-root",
        parentRunId: null,
        status: "done",
        workflowName: "completed",
      },
      {
        runId: "failed-root",
        parentRunId: null,
        status: "failed",
        workflowName: "failed",
        errorCode: "activation_failed",
        errorSummary: "launch failed",
      },
    ]);

    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "parked-root",
          workflowName: "unknown",
          status: "waiting",
          startedAt: "",
        }),
        expect.objectContaining({
          runId: "completed-root",
          status: "completed",
        }),
        expect.objectContaining({
          runId: "failed-root",
          status: "failed",
          errorCode: "activation_failed",
          errorSummary: "launch failed",
        }),
      ]),
    );
  });
});
