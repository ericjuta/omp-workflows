import { describe, expect, it } from "vitest";
import {
  findMatchingLiveRuns,
  isLiveWorkflowStatus,
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
});
