import { describe, expect, it } from "vitest";
import { fitWidth, stripAnsi, visibleLength } from "../src/render/ansi.js";
import {
  formatDuration,
  maxDetailScroll,
  projectViewerRuns,
  renderDoctorFindings,
  renderQueueDetailLines,
  renderRunDetailLines,
  renderRunListLines,
  renderRunProjectionLines,
  runElapsedMs,
} from "../src/viewer/render.js";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import {
  choice,
  createHumanDecisionRequest,
  defineHumanChoices,
} from "../src/workflows/human-decision.js";
import { createDefinitionSnapshot } from "../src/workflows/store.js";
import type { LoadedRunBundle } from "../src/workflows/store.js";
import type { WorkflowRunState } from "../src/workflows/types.js";

const NOW = new Date("2026-07-19T00:01:00.000Z");

const workflow = defineWorkflow({
  name: "demo",
  startAt: "one",
  nodes: {
    one: compute({ run: () => 1 }),
    two: compute({ run: () => 2 }),
  },
  edges: [{ from: "one", to: "two" }],
});

function makeBundle(overrides: Partial<WorkflowRunState> = {}): LoadedRunBundle {
  const state: WorkflowRunState = {
    schema: "pi-workflows.run-state.v1",
    traceSeq: 1,
    runId: "run-1",
    workflowName: "demo",
    startedAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:30.000Z",
    status: "running",
    input: {},
    outputs: {},
    results: {},
    steps: [],
    ...overrides,
  };
  return {
    runDir: "/tmp/run-1",
    manifest: {
      schema: "pi-workflows.run-bundle.v1",
      runId: state.runId,
      workflowName: state.workflowName,
      startedAt: state.startedAt,
      status: state.status,
      traceSchema: "pi-workflows.trace-event.v1",
      paths: { workflow: "workflow.json", state: "state.json", trace: "trace.ndjson" },
    },
    state,
    snapshot: createDefinitionSnapshot(workflow),
    sessionBinding: null,
    sessionEntries: [],
    sessionEvents: [],
    sessionCapture: null,
    sessionIntegrity: { status: "unavailable", diagnostics: [] },
    sessionSegments: [],
  };
}

describe("formatDuration", () => {
  it("formats milliseconds, seconds, and minutes", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(2_500)).toBe("2.5s");
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(95_000)).toBe("1m35s");
  });
});

describe("runElapsedMs", () => {
  it("uses finishedAt when present, otherwise now", () => {
    const finished = makeBundle({ finishedAt: "2026-07-19T00:00:10.000Z" }).state;
    expect(runElapsedMs(finished, NOW)).toBe(10_000);
    expect(runElapsedMs(makeBundle().state, NOW)).toBe(60_000);
  });
});
describe("terminal rendering safety", () => {
  it("removes control sequences from queue and bundle metadata", () => {
    const hostile = "owned\u001b]52;c;payload\u0007\nforged-row";
    const bundle = makeBundle({
      runId: hostile,
      statusDetail: hostile,
      steps: [
        {
          attemptId: "a",
          nodeId: hostile,
          nodeType: "compute",
          outcome: "ok",
          startedAt: "2026-07-19T00:00:00.000Z",
          finishedAt: "2026-07-19T00:00:01.000Z",
          prompt: null,
          output: hostile,
        },
      ],
    });
    const rendered = [
      ...renderQueueDetailLines(
        {
          runId: hostile,
          workflowName: hostile,
          status: "queued",
          startedAt: hostile,
          warnings: [hostile],
        },
        { width: 500, height: 50 },
      ),
      ...renderRunDetailLines(bundle, { width: 500, height: 100 }, NOW),
    ].map(stripAnsi);

    for (const line of rendered) {
      expect(
        [...line].every((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint > 31 && codePoint !== 127;
        }),
      ).toBe(true);
    }
  });
});

describe("renderRunListLines", () => {
  const size = { width: 100, height: 20 };

  it("renders an empty message when there are no runs", () => {
    const lines = renderRunListLines([], 0, size, NOW).map(stripAnsi);
    expect(lines.at(-1)).toContain("No workflow runs found");
  });

  it("renders one line per run with a selection marker", () => {
    const bundles = [makeBundle(), makeBundle({ runId: "run-2", status: "completed" })];
    const lines = renderRunListLines(bundles, 1, size, NOW).map(stripAnsi);
    const runLines = lines.filter((line) => line.includes("run-"));
    expect(runLines).toHaveLength(2);
    expect(runLines[0]).toMatch(/^ {2}running/);
    expect(runLines[1]).toMatch(/^› completed/);
  });

  it("renders a waiting parent and active child as one family picker row", () => {
    const parent = makeBundle({
      runId: "family-parent",
      status: "waiting",
      waitingOn: "review",
    });
    const child = makeBundle({
      runId: "family-child",
      parentRunId: "family-parent",
      status: "running",
    });
    const lines = renderRunListLines([parent, child], 0, size, NOW).map(stripAnsi);
    const runLines = lines.filter((line) => line.includes("demo"));
    expect(runLines).toHaveLength(1);
    expect(runLines[0]).toContain("family-child");
    expect(runLines[0]).toContain("continuation family-parent → family-child");
    expect(projectViewerRuns([parent, child])).toMatchObject([
      { run: { runId: "family-child", parentRunId: "family-parent" }, bundle: child },
    ]);
  });

  it("projects a queued continuation into the family picker row", () => {
    const parent = makeBundle({
      runId: "queued-parent",
      status: "waiting",
      waitingOn: "review",
    });
    const queueFacts = [
      {
        runId: "queued-child",
        parentRunId: "queued-parent",
        status: "starting",
        startedAt: "2026-07-19T00:00:45.000Z",
        workflowName: "demo",
      },
    ];
    const lines = renderRunListLines([parent], 0, size, NOW, queueFacts).map(stripAnsi);
    const runLines = lines.filter((line) => line.includes("demo"));
    expect(runLines).toHaveLength(1);
    expect(runLines[0]).toContain("queued");
    expect(runLines[0]).toContain("continuation queued-parent → queued-child");
    expect(projectViewerRuns([parent], queueFacts)).toEqual([
      expect.objectContaining({
        run: expect.objectContaining({ runId: "queued-child", parentRunId: "queued-parent" }),
      }),
    ]);
    expect(projectViewerRuns([parent], queueFacts)[0]).not.toHaveProperty("bundle");
  });
});

describe("renderRunListLines edges", () => {
  const size = { width: 60, height: 10 };

  it("renders titles, waiting, failed, and elapsed fallbacks", () => {
    const bundles = [
      makeBundle({
        runId: "run-titled",
        status: "waiting",
        waitingOn: "review",
        runTitle: "needs a decision",
      }),
      makeBundle({ runId: "run-failed", status: "failed", error: "boom" }),
    ];
    const lines = renderRunListLines(bundles, 0, size, NOW).map(stripAnsi).join("\n");
    expect(lines).toContain("needs a decision");
    expect(lines).toContain("waiting");
    expect(lines).toContain("failed");
  });

  it("clamps selection and scrolls long lists", () => {
    const bundles = Array.from({ length: 30 }, (_, index) =>
      makeBundle({ runId: `run-${index}`, status: "completed" }),
    );
    const lines = renderRunListLines(bundles, 25, size, NOW).map(stripAnsi).join("\n");
    expect(lines).toContain("run-25");
  });
});

describe("renderRunDetailLines", () => {
  const size = { width: 100, height: 50 };

  it("renders an exact continuation child with an explicit parent/effective link", () => {
    const child = makeBundle({
      runId: "detail-child",
      parentRunId: "detail-parent",
      status: "running",
    });
    const text = renderRunDetailLines(child, size, NOW).map(stripAnsi).join("\n");
    expect(text).toContain("run detail-child");
    expect(text).toContain("continuation detail-parent → effective detail-child");
  });

  it("renders progress history, measured ETA, sample count, and confidence", () => {
    const bundle = makeBundle();
    bundle.traceEvents = [
      progressEvent(2, "2026-07-19T00:00:00.000Z", 0),
      progressEvent(3, "2026-07-19T00:00:30.000Z", 25),
      progressEvent(4, "2026-07-19T00:01:00.000Z", 50),
    ];

    const lines = renderRunDetailLines(bundle, size, NOW).map(stripAnsi).join("\n");
    expect(lines).toContain("progress");
    expect(lines).toContain("Import  50/100 rows  ETA 1m");
    expect(lines).toContain("3 samples · medium confidence");
  });

  it("renders complete hierarchical agent progress", () => {
    const bundle = makeBundle();
    bundle.traceEvents = [
      agentProgressEvent(2, "agents/review", "Review agents", "review", 1, 4),
      agentProgressEvent(
        3,
        "agents/review/necessity",
        "Necessity · mock/model",
        "tool: read",
        0,
        1,
      ),
    ];

    const text = renderRunDetailLines(bundle, size, NOW).map(stripAnsi).join("\n");
    expect(text).toContain("Review agents  1/4 sessions  review");
    expect(text).toContain("  Necessity · mock/model  0/1 sessions  tool: read");
    expect(text).toContain("elapsed 1m");
  });

  it("renders header, nodes, steps, and final output", () => {
    const bundle = makeBundle({
      status: "completed",
      finishedAt: "2026-07-19T00:00:45.000Z",
      finalOutput: { done: true },
      results: {
        one: {
          attemptId: "a",
          nodeId: "one",
          nodeType: "compute",
          outcome: "ok",
          startedAt: "2026-07-19T00:00:00.000Z",
          finishedAt: "2026-07-19T00:00:01.000Z",
          durationMs: 1000,
        },
      },
      steps: [
        {
          attemptId: "a",
          nodeId: "one",
          nodeType: "compute",
          outcome: "ok",
          startedAt: "2026-07-19T00:00:00.000Z",
          finishedAt: "2026-07-19T00:00:01.000Z",
          prompt: null,
          output: { value: 1 },
        },
      ],
    });
    const text = renderRunDetailLines(bundle, size, NOW).map(stripAnsi).join("\n");
    expect(text).toContain("workflow demo");
    expect(text).toContain("completed · run run-1 · elapsed 45s");
    expect(text).toContain("ƒ compute");
    expect(text).toContain("✓ completed");
    expect(text).toContain("one");
    expect(text).toContain("↻ 1");
    expect(text).toContain("◷ 1.0s");
    expect(text).toContain("· queued");
    expect(text).toContain("two");
    expect(text).toContain(`{"value":1}`);
    expect(text).toContain(`output {"done":true}`);
  });

  it("renders running node elapsed time and errors", () => {
    const bundle = makeBundle({
      currentNode: "two",
      currentNodeStartedAt: "2026-07-19T00:00:50.000Z",
      error: "exploded",
    });
    const text = renderRunDetailLines(bundle, size, NOW).map(stripAnsi).join("\n");
    expect(text).toContain("ƒ compute");
    expect(text).toContain("◐ running");
    expect(text).toContain("two");
    expect(text).toContain("↻ 1");
    expect(text).toContain("◷ 10s");
    expect(text).toContain("error: exploded");
  });

  it("clips to the viewport height", () => {
    const lines = renderRunDetailLines(makeBundle(), { width: 100, height: 4 }, NOW);
    expect(lines).toHaveLength(4);
  });

  it("shows the running node's statusDetail", () => {
    const bundle = makeBundle({
      currentNode: "two",
      currentNodeStartedAt: "2026-07-19T00:00:50.000Z",
      statusDetail: "reviewing",
    });
    const text = renderRunDetailLines(bundle, size, NOW).map(stripAnsi).join("\n");
    expect(text).toContain("ƒ compute");
    expect(text).toContain("◐ running");
    expect(text).toContain("↻ 1");
    expect(text).toContain("◷ 10s");
    expect(text).toContain("… reviewing");
  });

  it("scrubs to a selected step with position and inspector", () => {
    const steps = [
      {
        attemptId: "a1",
        nodeId: "one",
        nodeType: "compute" as const,
        outcome: "ok" as const,
        startedAt: "2026-07-19T00:00:00.000Z",
        finishedAt: "2026-07-19T00:00:01.000Z",
        prompt: null,
        output: { value: 1 },
      },
      {
        attemptId: "a2",
        nodeId: "two",
        nodeType: "compute" as const,
        outcome: "failed" as const,
        startedAt: "2026-07-19T00:00:01.000Z",
        finishedAt: "2026-07-19T00:00:02.000Z",
        prompt: null,
        output: null,
        error: "two exploded",
        action: {
          actionType: "shell" as const,
          command: "false",
          args: ["--now"],
          exitCode: 1,
        },
      },
    ];
    const bundle = makeBundle({ status: "failed", steps, error: "two exploded" });

    const first = renderRunDetailLines(bundle, size, NOW, 0, 0).map(stripAnsi).join("\n");
    expect(first).toContain("step 1/2");
    expect(first).toContain("step output — one (ok)");
    expect(first).toContain(`"value": 1`);
    // Scrubbed to step 1: node two has no visible attempt yet.
    expect(first).toContain("ƒ compute");
    expect(first).toContain("· queued");
    expect(first).toContain("two");

    const second = renderRunDetailLines(bundle, size, NOW, 0, 1).map(stripAnsi).join("\n");
    expect(second).toContain("step 2/2");
    expect(second).toContain("step output — two (failed)");
    expect(second).toContain("two exploded");
    expect(second).toContain("shell false --now → exit 1");
    expect(second).toContain("ƒ compute");
    expect(second).toContain("✗ failed");
    expect(second).toContain("two");
  });

  it("falls back to a flat node list without a snapshot", () => {
    const bundle = makeBundle({
      status: "waiting",
      waitingOn: "one",
      results: {
        one: {
          attemptId: "a",
          nodeId: "one",
          nodeType: "compute",
          outcome: "ok",
          startedAt: "2026-07-19T00:00:00.000Z",
          finishedAt: "2026-07-19T00:00:01.000Z",
          durationMs: 1000,
        },
      },
    });
    const withoutSnapshot = { ...bundle, snapshot: null };
    const text = renderRunDetailLines(withoutSnapshot, size, NOW).map(stripAnsi).join("\n");
    expect(text).toContain("⏸ one");
    expect(text).toContain("waiting");
  });

  it("scrolls the detail view over long content", () => {
    const bundle = makeBundle();
    const viewport = { width: 100, height: 4 };
    const top = renderRunDetailLines(bundle, viewport, NOW, 0).map(stripAnsi);
    const scrolled = renderRunDetailLines(bundle, viewport, NOW, 2).map(stripAnsi);
    expect(scrolled[0]).toBe(top[2]);
    expect(maxDetailScroll(bundle, viewport)).toBeGreaterThan(0);
    // Scroll beyond the end clamps to the last full viewport.
    const clamped = renderRunDetailLines(bundle, viewport, NOW, 10_000).map(stripAnsi);
    expect(clamped).toHaveLength(4);
    expect(renderRunDetailLines(bundle, viewport, NOW, maxDetailScroll(bundle, viewport))).toEqual(
      renderRunDetailLines(bundle, viewport, NOW, 10_000),
    );
  });
});

describe("human decision presentation rendering", () => {
  it("shows readable v2 content instead of the canonical subject JSON", () => {
    const request = createHumanDecisionRequest({
      runId: "run-1",
      workflowName: "demo",
      nodeId: "one",
      attemptId: "decision-attempt",
      contract: {
        audience: "operator",
        choices: defineHumanChoices({ continue: choice({ label: "Continue" }) }),
      },
      prompt: {
        title: "Approve readable output",
        subject: { hiddenMachineValue: "do-not-show" },
        presentation: {
          schema: "pi-workflows.decision-presentation.v1",
          summary: "Review the readable output.",
          blocks: [{ kind: "paragraph", text: "Apply the safe change." }],
        },
      },
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    const bundle = makeBundle({
      status: "waiting",
      waitingOn: "one",
      finalOutput: request,
      results: {
        one: {
          attemptId: "decision-attempt",
          nodeId: "one",
          nodeType: "checkpoint",
          outcome: "ok",
          startedAt: "2026-08-19T00:00:00.000Z",
          finishedAt: "2026-08-19T00:00:01.000Z",
          durationMs: 1_000,
          output: request,
        },
      },
      steps: [
        {
          attemptId: "decision-attempt",
          nodeId: "one",
          nodeType: "checkpoint",
          outcome: "ok",
          startedAt: "2026-08-19T00:00:00.000Z",
          finishedAt: "2026-08-19T00:00:01.000Z",
          prompt: null,
          output: request,
        },
      ],
    });
    const text = renderRunDetailLines(bundle, { width: 100, height: 100 }, NOW)
      .map(stripAnsi)
      .join("\n");
    expect(text).toContain("Review the readable output.");
    expect(text).toContain("Apply the safe change.");
    expect(text).not.toContain("hiddenMachineValue");
    expect(text).not.toContain("do-not-show");
  });

  it("renders malformed schema-tagged decision output as ordinary JSON", () => {
    const malformed = { schema: "pi-workflows.human-decision-request.v1" };
    const bundle = makeBundle({
      steps: [
        {
          attemptId: "malformed-decision-attempt",
          nodeId: "one",
          nodeType: "checkpoint",
          outcome: "ok",
          startedAt: "2026-08-19T00:00:00.000Z",
          finishedAt: "2026-08-19T00:00:01.000Z",
          prompt: null,
          output: malformed,
        },
      ],
    });

    expect(() => renderRunDetailLines(bundle, { width: 100, height: 100 }, NOW)).not.toThrow();
  });
});

function agentProgressEvent(
  seq: number,
  key: string,
  label: string,
  phase: string,
  completed: number,
  total: number,
) {
  return {
    seq,
    at: "2026-07-19T00:00:00.000Z",
    scope: "node" as const,
    type: "update_published",
    runId: "run-1",
    nodeId: "review",
    attemptId: "attempt-1",
    payload: {
      updateId: `agent-${seq}`,
      type: "progress",
      key,
      data: {
        schema: "pi-workflows.progress.v1",
        label,
        status: "running",
        phase,
        completed,
        total,
        unit: "sessions",
      },
    },
  };
}

function progressEvent(seq: number, at: string, completed: number) {
  return {
    seq,
    at,
    scope: "node" as const,
    type: "update_published",
    runId: "run-1",
    nodeId: "work",
    attemptId: "attempt-1",
    payload: {
      updateId: `u${seq}`,
      type: "progress",
      key: "overall",
      data: {
        schema: "pi-workflows.progress.v1",
        label: "Import",
        status: "running",
        completed,
        total: 100,
        unit: "rows",
      },
    },
  };
}

describe("projection and doctor rendering", () => {
  it("renders continuation identity, diagnostics, and bounded errors", () => {
    const [line] = renderRunProjectionLines([
      {
        runId: "child",
        workflowName: "demo",
        status: "failed",
        startedAt: NOW.toISOString(),
        durationMs: 2_000,
        parentRunId: "parent",
        continuationRunId: "child",
        paused: true,
        pausedAgeMs: 3_000,
        currentNode: "review",
        failingNode: "review",
        warnings: ["bad state"],
        errorSummary: "x".repeat(600),
      },
    ]);
    const plain = stripAnsi(line ?? "");
    expect(plain).toContain("continuation parent → child");
    expect(plain).toContain("paused 3.0s");
    expect(plain).toContain("failing review");
    expect(plain).toContain("1 warning(s)");
    expect(plain.length).toBeLessThan(500);
  });

  it("sanitizes model-controlled doctor finding fields", () => {
    const lines = renderDoctorFindings("run\u001b]8;;https://evil.test\u0007id", [
      {
        severity: "error",
        code: "bad\ncode",
        message: "unsafe\u001b]8;;https://evil.test\u0007link\nnext",
      },
    ]);
    const plain = stripAnsi(lines.join("\n"));
    expect(plain).toContain("bad code");
    expect(plain).toContain("unsafe");
    expect(plain).toContain("next");
    expect(plain).not.toContain("\u001b");
    expect(plain).not.toContain("\u0007");
  });
});

describe("ansi helpers", () => {
  it("strips ANSI and measures visible length", () => {
    const styled = "\u001b[32mgreen\u001b[0m";
    expect(stripAnsi(styled)).toBe("green");
    expect(visibleLength(styled)).toBe(5);
  });

  it("fits lines to a width", () => {
    expect(fitWidth("short", 10)).toBe("short");
    expect(stripAnsi(fitWidth("a".repeat(20), 10))).toBe(`${"a".repeat(9)}…`);
  });
});
