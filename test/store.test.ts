import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { agent, compute, defineWorkflow } from "../src/workflows/definition.js";
import { choice, defineHumanChoices, humanDecision } from "../src/workflows/human-decision.js";
import {
  WorkflowRunStore,
  createDefinitionSnapshot,
  createRunId,
  listRunBundles,
  listRunProjections,
  readRunBundle,
  readRunProjection,
  readRunState,
  workflowRunsBaseDir,
} from "../src/workflows/store.js";
import type { WorkflowRunState, WorkflowSessionEventRecord } from "../src/workflows/types.js";
import { decisionPrompt, makeTempDir } from "./helpers.js";

function makeState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  const now = new Date().toISOString();
  return {
    schema: "pi-workflows.run-state.v1",
    traceSeq: 0,
    runId: createRunId("demo"),
    workflowName: "demo",
    startedAt: now,
    updatedAt: now,
    status: "running",
    input: { task: "t" },
    outputs: {},
    results: {},
    steps: [],
    ...overrides,
  };
}

const workflow = defineWorkflow({
  name: "demo",
  startAt: "one",
  nodes: { one: compute({ run: () => 1 }) },
  edges: [],
});

describe("createRunId", () => {
  it("slugifies the workflow name with a timestamp and suffix", () => {
    const runId = createRunId("My Workflow!", new Date("2026-07-19T01:02:03.456Z"));
    expect(runId).toMatch(/^20260719T010203Z-my-workflow-[0-9a-f]{8}$/);
  });
});

describe("workflowRunsBaseDir", () => {
  it("lives under the pi agent directory", () => {
    expect(workflowRunsBaseDir("/home/x")).toBe(
      path.join("/home/x", ".pi", "agent", "workflows", "runs"),
    );
  });
});

describe("WorkflowRunStore", () => {
  it("persists fixed null timeouts in the portable definition snapshot", () => {
    const snapshot = createDefinitionSnapshot(
      defineWorkflow({
        name: "no-timeout",
        startAt: "one",
        nodes: { one: agent({ prompt: () => "?", timeoutMs: null }) },
        edges: [],
      }),
    );

    expect(snapshot.nodes.one?.timeoutMs).toBeNull();
  });

  it("omits computed timeouts from the portable definition snapshot", () => {
    const snapshot = createDefinitionSnapshot(
      defineWorkflow({
        name: "computed-timeout",
        startAt: "one",
        nodes: { one: agent({ prompt: () => "?", timeoutMs: () => 60_000 }) },
        edges: [],
      }),
    );

    expect(snapshot.nodes.one?.timeoutMs).toBeUndefined();
  });

  it("initializes and updates a run bundle", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();

    const runDir = await store.initializeRunBundle(workflow, state);
    expect(runDir).toBe(path.join(outputRoot, state.runId));

    state.status = "completed";
    state.finishedAt = new Date().toISOString();
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_completed", payload: {} });

    const bundle = await readRunBundle(runDir);
    expect(bundle?.manifest.status).toBe("completed");
    expect(bundle?.state.status).toBe("completed");
    expect(bundle?.snapshot?.schema).toBe("pi-workflows.definition-snapshot.v1");

    const trace = await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8");
    const events = trace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { seq: number; type: string });
    expect(events.map((event) => event.type)).toEqual(["run_completed"]);
  });

  it("rejects an update when its attempt was aborted before admission", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    const abort = new AbortController();
    abort.abort(new Error("attempt ended"));

    await expect(
      store.publishUpdate(
        runDir,
        state,
        "one",
        "attempt-1",
        { type: "test", key: "job", data: {} },
        { signal: abort.signal },
      ),
    ).rejects.toThrow("attempt ended");
    expect(state.updates).toBeUndefined();
    const detail = await readRunBundle(runDir, { includeTrace: true });
    expect(detail?.traceEvents).toEqual([]);
  });

  it("assigns monotonic trace sequence numbers", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);

    // The first event carries a payload large enough to externalize, which
    // makes its transition slow; physical order must still match seq order.
    await Promise.all([
      store.writeSnapshot(runDir, state, {
        scope: "node",
        type: "a",
        payload: { text: "z".repeat(50_000) },
      }),
      store.writeSnapshot(runDir, state, { scope: "node", type: "b", payload: {} }),
      store.writeSnapshot(runDir, state, { scope: "node", type: "c", payload: {} }),
    ]);

    const trace = await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8");
    const events = trace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { seq: number; type: string });
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ]);
    expect((await readRunBundle(runDir))?.state.traceSeq).toBe(3);
  });

  it("carries the reflected trace seq in state.json", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    expect((await readRunBundle(runDir))?.state.traceSeq).toBe(0);

    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_started", payload: {} });
    await store.writeSnapshot(runDir, state, { scope: "node", type: "node_started", payload: {} });

    expect((await readRunBundle(runDir))?.state.traceSeq).toBe(2);
  });

  it("declares the artifact directory before live payloads can reference it", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store-artifact-manifest");
    const store = new WorkflowRunStore(outputRoot);
    const runDir = await store.initializeRunBundle(workflow, makeState());
    expect((await readRunBundle(runDir))?.manifest.paths.artifacts).toBe("artifacts");
    await expect(fs.stat(path.join(runDir, "artifacts"))).rejects.toThrow();
  });

  it("externalizes large values into content-addressed artifacts", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store");
    const store = new WorkflowRunStore(outputRoot);
    const big = "x".repeat(10_000);
    const state = makeState({ outputs: { one: { text: big } } });
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_started", payload: {} });

    const bundle = await readRunBundle(runDir);
    const output = bundle?.state.outputs.one as { text: { $artifact: { path: string } } };
    expect(output.text.$artifact.path).toMatch(/^artifacts\/sha256-[0-9a-f]{64}\.txt$/);
    expect(bundle?.manifest.paths.artifacts).toBe("artifacts");
    const stored = await fs.readFile(path.join(runDir, output.text.$artifact.path), "utf8");
    expect(stored).toBe(big);

    const { resolveArtifacts } = await import("../src/workflows/artifacts.js");
    expect(await resolveArtifacts(bundle?.state.outputs, runDir)).toEqual({
      one: { text: big },
    });
  });

  it("records a session binding, entries, and the session_bound event", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_started", payload: {} });

    await store.writeSessionBinding(runDir, {
      schema: "pi-workflows.session-binding.v1",
      runId: state.runId,
      piSessionId: "session-1",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    expect(await store.appendSessionEntry(runDir, { id: "aa11bb22", type: "message" })).toBe(1);
    expect(await store.appendSessionEntry(runDir, { id: "cc33dd44", type: "message" })).toBe(2);

    const binding = JSON.parse(
      await fs.readFile(path.join(runDir, "session/binding.json"), "utf8"),
    ) as { piSessionId: string };
    expect(binding.piSessionId).toBe("session-1");

    const entries = (await fs.readFile(path.join(runDir, "session/entries.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { seq: number; entry: { id: string } });
    expect(entries.map((record) => [record.seq, record.entry.id])).toEqual([
      [1, "aa11bb22"],
      [2, "cc33dd44"],
    ]);

    const trace = (await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; scope: string });
    expect(trace.at(-1)).toMatchObject({ type: "session_bound", scope: "session" });

    // The next snapshot advertises the session directory in the manifest.
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_completed", payload: {} });
    expect((await readRunBundle(runDir))?.manifest.paths.session).toBe("session");
  });

  it("appends session event batches and writes verified capture counts", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store-events");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSessionBinding(runDir, {
      schema: "pi-workflows.session-binding.v1",
      runId: state.runId,
      piSessionId: "session-1",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    await store.writeSessionCapture(runDir, {
      schema: "pi-workflows.session-capture.v1",
      eventSchema: "pi-workflows.session-event.v1",
      status: "recording",
      eventCount: 0,
      entryCount: 0,
      lastEventSeq: 0,
    });
    const records: WorkflowSessionEventRecord[] = [
      {
        seq: 1,
        at: "2026-07-30T00:00:00.000Z",
        nodeId: "one",
        attemptId: "a1",
        turnId: "t1",
        type: "turn_started",
        payload: { turnIndex: 0 },
      },
      {
        seq: 2,
        at: "2026-07-30T00:00:00.001Z",
        nodeId: "one",
        attemptId: "a1",
        turnId: "t1",
        messageId: "m1",
        type: "message_started",
        payload: { role: "assistant" },
      },
    ];
    await store.appendSessionEventBatch(runDir, records);
    await store.appendSessionEntry(runDir, { id: "entry-1", type: "message" });
    const counts = await store.sessionCounts(runDir);
    expect(counts).toEqual({ eventCount: 2, entryCount: 1, lastEventSeq: 2 });
    await store.writeSessionCapture(runDir, {
      schema: "pi-workflows.session-capture.v1",
      eventSchema: "pi-workflows.session-event.v1",
      status: "complete",
      ...counts,
    });

    const lines = (await fs.readFile(path.join(runDir, "session/events.ndjson"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string)).toMatchObject({ seq: 2, type: "message_started" });
    const bundle = await readRunBundle(runDir);
    expect(bundle?.sessionEvents).toHaveLength(2);
    expect(bundle?.sessionEntries).toHaveLength(1);
    expect(bundle?.sessionIntegrity).toEqual({ status: "complete", diagnostics: [] });
    await expect(store.appendSessionEventBatch(runDir, [])).resolves.toBeUndefined();
    await expect(
      store.appendSessionEventBatch(runDir, [{ ...records[1]!, seq: 3 }]),
    ).rejects.toThrow("stopped");
  });

  it("reports invalid terminal capture counts", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store-event-integrity");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSessionBinding(runDir, {
      schema: "pi-workflows.session-binding.v1",
      runId: state.runId,
      piSessionId: "session-1",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    await store.writeSessionCapture(runDir, {
      schema: "pi-workflows.session-capture.v1",
      eventSchema: "pi-workflows.session-event.v1",
      status: "complete",
      eventCount: 1,
      entryCount: 0,
      lastEventSeq: 1,
    });
    expect((await readRunBundle(runDir))?.sessionIntegrity).toEqual({
      status: "invalid",
      diagnostics: ["session capture counts do not match durable files"],
    });
  });

  it("rejects recording capture after the workflow is terminal", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store-terminal-recording");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState({ status: "completed", finishedAt: new Date().toISOString() });
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSessionBinding(runDir, {
      schema: "pi-workflows.session-binding.v1",
      runId: state.runId,
      piSessionId: "session-1",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    await store.writeSessionCapture(runDir, {
      schema: "pi-workflows.session-capture.v1",
      eventSchema: "pi-workflows.session-event.v1",
      status: "recording",
      eventCount: 0,
      entryCount: 0,
      lastEventSeq: 0,
    });
    expect((await readRunBundle(runDir))?.sessionIntegrity).toEqual({
      status: "invalid",
      diagnostics: ["terminal run still reports recording capture"],
    });
  });

  it("rejects unknown session capture statuses", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store-invalid-capture-status");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSessionBinding(runDir, {
      schema: "pi-workflows.session-binding.v1",
      runId: state.runId,
      piSessionId: "session-1",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    await fs.writeFile(
      path.join(runDir, "session/capture.json"),
      JSON.stringify({
        schema: "pi-workflows.session-capture.v1",
        eventSchema: "pi-workflows.session-event.v1",
        status: "finished",
        eventCount: 0,
        entryCount: 0,
        lastEventSeq: 0,
      }),
    );
    expect((await readRunBundle(runDir))?.sessionIntegrity).toEqual({
      status: "invalid",
      diagnostics: ["Invalid session capture projection"],
    });
  });

  it("accepts unknown future event types without invented correlation requirements", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store-unknown-event");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSessionBinding(runDir, {
      schema: "pi-workflows.session-binding.v1",
      runId: state.runId,
      piSessionId: "session-1",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    await fs.writeFile(
      path.join(runDir, "session/events.ndjson"),
      `${JSON.stringify({
        seq: 1,
        at: new Date().toISOString(),
        nodeId: "one",
        attemptId: "a1",
        type: "future_event",
        payload: {},
      })}\n`,
    );
    await store.writeSessionCapture(runDir, {
      schema: "pi-workflows.session-capture.v1",
      eventSchema: "pi-workflows.session-event.v1",
      status: "complete",
      eventCount: 1,
      entryCount: 0,
      lastEventSeq: 1,
    });
    expect((await readRunBundle(runDir))?.sessionIntegrity).toEqual({
      status: "complete",
      diagnostics: [],
    });
  });

  it("rejects known events with missing starts or correlation ids", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store-invalid-event");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSessionBinding(runDir, {
      schema: "pi-workflows.session-binding.v1",
      runId: state.runId,
      piSessionId: "session-1",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    await fs.writeFile(
      path.join(runDir, "session/events.ndjson"),
      `${JSON.stringify({
        seq: 1,
        at: new Date().toISOString(),
        nodeId: "one",
        attemptId: "a1",
        type: "message_finished",
        payload: { settled: false },
      })}\n`,
    );
    await store.writeSessionCapture(runDir, {
      schema: "pi-workflows.session-capture.v1",
      eventSchema: "pi-workflows.session-event.v1",
      status: "complete",
      eventCount: 1,
      entryCount: 0,
      lastEventSeq: 1,
    });
    const integrity = (await readRunBundle(runDir))?.sessionIntegrity;
    expect(integrity?.status).toBe("invalid");
    expect(integrity?.diagnostics).toContain("message_finished requires turnId");
  });

  it("rejects sequence gaps and stops later temporal appends", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store-event-gaps");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    const event: WorkflowSessionEventRecord = {
      seq: 2,
      at: new Date().toISOString(),
      nodeId: "one",
      attemptId: "a1",
      turnId: "t1",
      type: "turn_started",
      payload: { turnIndex: 0 },
    };
    await expect(store.appendSessionEventBatch(runDir, [event])).rejects.toThrow(
      "Expected session event seq 1",
    );
    await expect(store.appendSessionEventBatch(runDir, [{ ...event, seq: 1 }])).rejects.toThrow(
      "stopped",
    );
  });

  it("keeps bundle files private", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);

    const dirMode = (await fs.stat(runDir)).mode & 0o777;
    const fileMode = (await fs.stat(path.join(runDir, "state.json"))).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });
});

describe("listRunBundles", () => {
  it("lists bundles most recent first and skips junk", async () => {
    const outputRoot = await makeTempDir("pi-workflows-list");
    const store = new WorkflowRunStore(outputRoot);
    const older = makeState({ startedAt: "2026-01-01T00:00:00.000Z" });
    const newer = makeState({ startedAt: "2026-06-01T00:00:00.000Z" });
    await store.initializeRunBundle(workflow, older);
    await store.initializeRunBundle(workflow, newer);
    await fs.mkdir(path.join(outputRoot, "not-a-bundle"));

    const bundles = await listRunBundles(outputRoot);

    expect(bundles.map((bundle) => bundle.state.runId)).toEqual([newer.runId, older.runId]);
    expect(bundles.every((bundle) => bundle.traceEvents === undefined)).toBe(true);
    const projected = await readRunBundle(bundles[0]!.runDir);
    expect(projected?.traceEvents).toBeUndefined();
    const detail = await readRunBundle(bundles[0]!.runDir, { includeTrace: true });
    expect(detail?.traceEvents).toEqual([]);
  });

  it("returns empty for a missing directory", async () => {
    expect(await listRunBundles("/nonexistent/definitely/missing")).toEqual([]);
  });

  it("skips schema-tagged bundles with malformed manifests instead of throwing", async () => {
    const outputRoot = await makeTempDir("pi-workflows-list");
    const store = new WorkflowRunStore(outputRoot);
    const good = makeState();
    await store.initializeRunBundle(workflow, good);

    const badDir = path.join(outputRoot, "bad-bundle");
    await fs.mkdir(badDir);
    await fs.writeFile(
      path.join(badDir, "manifest.json"),
      JSON.stringify({ schema: "pi-workflows.run-bundle.v1", paths: { state: 42 } }),
    );

    const bundles = await listRunBundles(outputRoot);
    expect(bundles.map((bundle) => bundle.state.runId)).toEqual([good.runId]);
  });

  it("isolates malformed bundle metadata and journal records", async () => {
    const outputRoot = await makeTempDir("pi-workflows-malformed-segment-binding");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    const segmentDir = path.join(runDir, "session", "segments", "attempt-invalid-binding");
    await fs.mkdir(segmentDir, { recursive: true });
    await fs.writeFile(
      path.join(segmentDir, "binding.json"),
      JSON.stringify({
        schema: "pi-workflows.session-binding.v1",
        runId: state.runId,
        piSessionId: "session-invalid-binding",
        cwd: "/tmp",
        boundAt: { invalid: true },
      }),
    );

    const bundle = await readRunBundle(runDir);
    expect(bundle?.sessionSegments).toHaveLength(1);
    expect(bundle?.sessionSegments[0]?.binding).toBeNull();
    expect(bundle?.sessionSegments[0]?.integrity.status).toBe("unavailable");
    await fs.writeFile(
      path.join(runDir, "workflow.json"),
      JSON.stringify({
        schema: "pi-workflows.definition-snapshot.v1",
        name: "demo",
        startAt: "one",
        nodes: null,
        edges: [],
      }),
    );
    await fs.writeFile(path.join(runDir, "trace.ndjson"), "null\n");
    const malformedBundle = await readRunBundle(runDir, { includeTrace: true });
    expect(malformedBundle?.snapshot).toBeNull();
    expect(malformedBundle?.traceEvents).toEqual([]);
    expect(malformedBundle?.traceIntegrity?.malformed).toBe(true);
  });
});

describe("fast run projections", () => {
  it("reads state without loading trace or session streams", async () => {
    const outputRoot = await makeTempDir("pi-workflows-read-state");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    const readFile = vi.spyOn(fs, "readFile");

    expect(await readRunState(runDir)).toEqual(state);
    const readPaths = readFile.mock.calls.map(([file]) => String(file));
    readFile.mockRestore();

    expect(readPaths.map((file) => path.basename(file))).toEqual(["manifest.json", "state.json"]);

    const storedState = JSON.parse(
      await fs.readFile(path.join(runDir, "state.json"), "utf8"),
    ) as Record<string, unknown>;
    await fs.writeFile(
      path.join(runDir, "state.json"),
      JSON.stringify({ ...storedState, schema: "pi-workflows.run-state.v0" }),
    );
    expect(await readRunState(runDir)).toBeNull();

    await fs.writeFile(
      path.join(runDir, "state.json"),
      JSON.stringify({ ...storedState, steps: { length: 1e100 } }),
    );
    expect(await readRunState(runDir)).toBeNull();
    expect(await readRunBundle(runDir)).toBeNull();

    await fs.writeFile(path.join(runDir, "state.json"), JSON.stringify(storedState));
    const manifestPath = path.join(runDir, "manifest.json");
    const storedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ ...storedManifest, schema: "pi-workflows.run-bundle.v0" }),
    );
    expect(await readRunState(runDir)).toBeNull();
  });

  it("lists state-only projections without reading trace or session streams", async () => {
    const outputRoot = await makeTempDir("pi-workflows-projections");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState({
      workflowSource: { kind: "builtin", id: "demo", revision: "7" },
      currentNode: "one",
    });
    await store.initializeRunBundle(workflow, state);
    const readFile = vi.spyOn(fs, "readFile");

    const listed = await listRunProjections(outputRoot);
    const readPaths = readFile.mock.calls.map(([file]) => String(file));
    readFile.mockRestore();

    expect(listed.items).toEqual([
      expect.objectContaining({
        runId: state.runId,
        workflowName: "demo",
        workflowId: "demo",
        revision: "7",
        currentNode: "one",
        warnings: [],
      }),
    ]);
    expect(readPaths.some((file) => file.endsWith("trace.ndjson"))).toBe(false);
    expect(readPaths.some((file) => file.endsWith("entries.ndjson"))).toBe(false);
    expect(readPaths.some((file) => file.endsWith("events.ndjson"))).toBe(false);
    expect(readPaths.some((file) => file.endsWith("capture.json"))).toBe(false);
  });

  it("projects incompatible running schemas as bounded non-live reset warnings", async () => {
    const outputRoot = await makeTempDir("pi-workflows-incompatible-projections");
    const store = new WorkflowRunStore(outputRoot);
    const stateSchemaRunDir = await store.initializeRunBundle(
      workflow,
      makeState({ paused: true }),
    );
    const manifestSchemaRunDir = await store.initializeRunBundle(
      workflow,
      makeState({ paused: true }),
    );

    const statePath = path.join(stateSchemaRunDir, "state.json");
    const storedState = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(
      statePath,
      JSON.stringify({ ...storedState, schema: "pi-workflows.run-state.v0" }),
    );
    const manifestPath = path.join(manifestSchemaRunDir, "manifest.json");
    const storedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ ...storedManifest, schema: "pi-workflows.run-bundle.v0" }),
    );

    for (const runDir of [stateSchemaRunDir, manifestSchemaRunDir]) {
      const projection = await readRunProjection(runDir);
      expect(projection).toMatchObject({
        runId: path.basename(runDir),
        workflowName: "unknown",
        status: "unreadable",
        startedAt: "",
        errorSummary: expect.stringMatching(/deleting its local run directory.*start a new run/i),
      });
      expect(projection).not.toHaveProperty("paused");
      expect(projection?.warnings).toHaveLength(1);
      expect(projection?.warnings[0]).toMatch(
        /incompatible_.*_schema.*deleting its local run directory/i,
      );
      expect(projection?.warnings[0]?.length).toBeLessThanOrEqual(500);
    }
    expect((await listRunProjections(outputRoot, { liveOnly: true })).items).toEqual([]);
  });

  it("matches coordinator cwd and target repository independently in fast projections", async () => {
    const outputRoot = await makeTempDir("pi-workflows-project-projections");
    const store = new WorkflowRunStore(outputRoot);
    const coordinatorCwd = path.join(outputRoot, "coordinator");
    const targetRepository = path.join(outputRoot, "target-repository");
    const state = makeState({ input: { task: "ship", repository: targetRepository } });
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSessionBinding(runDir, {
      schema: "pi-workflows.session-binding.v1",
      runId: state.runId,
      piSessionId: "session-project-filter",
      cwd: coordinatorCwd,
      boundAt: new Date().toISOString(),
    });

    const coordinatorMatches = await listRunProjections(outputRoot, { project: coordinatorCwd });
    const repositoryMatches = await listRunProjections(outputRoot, { project: targetRepository });

    expect(coordinatorMatches.items.map((item) => item.runId)).toEqual([state.runId]);
    expect(repositoryMatches.items.map((item) => item.runId)).toEqual([state.runId]);
    expect(coordinatorMatches.items[0]?.project).toBe(coordinatorCwd);
    expect(repositoryMatches.items[0]?.project).toBe(coordinatorCwd);
  });

  it("preserves malformed bundle rows and bounds inconsistency warnings", async () => {
    const outputRoot = await makeTempDir("pi-workflows-projection-warnings");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState({ currentNode: "missing-node" });
    const runDir = await store.initializeRunBundle(workflow, state);
    const manifestPath = path.join(runDir, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, workflowName: "wrong" }));

    const badDir = path.join(outputRoot, "broken-run");
    await fs.mkdir(badDir);
    await fs.writeFile(path.join(badDir, "manifest.json"), "{not-json");

    const listed = await listRunProjections(outputRoot);
    const goodProjection = await readRunProjection(runDir);
    const brokenProjection = listed.items.find((item) => item.runId === "broken-run");

    expect(goodProjection?.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("manifest_state_workflow_name_mismatch"),
        "current_node_not_in_snapshot: missing-node",
      ]),
    );
    expect(brokenProjection).toMatchObject({
      status: "unreadable",
      warnings: ["unreadable_bundle: missing or unreadable manifest and state"],
    });
    expect(listed.warnings.length).toBeLessThanOrEqual(100);
    expect(listed.items.every((item) => item.warnings.length <= 8)).toBe(true);
    expect(
      listed.items.every((item) => item.warnings.every((warning) => warning.length <= 500)),
    ).toBe(true);
  });
});
describe("malformed and sensitive run projections", () => {
  it("isolates schema-tagged states with malformed projection fields", async () => {
    const outputRoot = await makeTempDir("pi-workflows-malformed-state-projections");
    const store = new WorkflowRunStore(outputRoot);
    const good = makeState({ startedAt: "2026-08-01T00:00:00.000Z" });
    await store.initializeRunBundle(workflow, good);
    const malformedCases: Array<{
      field: string;
      mutate: (state: Record<string, unknown>) => void;
    }> = [
      { field: "startedAt", mutate: (state) => (state.startedAt = 42) },
      { field: "status", mutate: (state) => (state.status = { invalid: true }) },
      { field: "runId", mutate: (state) => (state.runId = 42) },
      { field: "workflowName", mutate: (state) => (state.workflowName = false) },
      { field: "traceSeq", mutate: (state) => (state.traceSeq = {}) },
      { field: "outputs", mutate: (state) => (state.outputs = null) },
      { field: "results", mutate: (state) => (state.results = null) },
      { field: "steps", mutate: (state) => (state.steps = { length: 1e100 }) },
      {
        field: "steps",
        mutate: (state) =>
          (state.steps = [
            {
              attemptId: "attempt-1",
              nodeId: "one",
              nodeType: {},
              outcome: "failed",
              startedAt: "2026-08-01T00:00:00.000Z",
              finishedAt: "2026-08-01T00:00:01.000Z",
              prompt: null,
              output: null,
              error: {},
            },
          ]),
      },
      { field: "runTitle", mutate: (state) => (state.runTitle = { invalid: true }) },
      { field: "currentNode", mutate: (state) => (state.currentNode = 42) },
      { field: "parentRunId", mutate: (state) => (state.parentRunId = false) },
      { field: "paused", mutate: (state) => (state.paused = "yes") },
      { field: "updates", mutate: (state) => (state.updates = { length: 1 }) },
      {
        field: "finishedAt",
        mutate: (state) => {
          state.status = "failed";
          delete state.finishedAt;
        },
      },
      {
        field: "waitingOn",
        mutate: (state) => {
          state.status = "waiting";
          delete state.waitingOn;
        },
      },
    ];
    const malformedRunIds: string[] = [];

    for (const malformedCase of malformedCases) {
      const runDir = await store.initializeRunBundle(workflow, makeState());
      malformedRunIds.push(path.basename(runDir));
      const statePath = path.join(runDir, "state.json");
      const storedState = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<
        string,
        unknown
      >;
      malformedCase.mutate(storedState);
      await fs.writeFile(statePath, JSON.stringify(storedState));

      const projection = await readRunProjection(runDir);
      expect(projection).toMatchObject({
        runId: path.basename(runDir),
        workflowName: "unknown",
        status: "unreadable",
        startedAt: "",
      });
      expect(projection?.warnings).toHaveLength(1);
      expect(projection?.warnings[0]).toContain(`malformed_state: ${malformedCase.field}`);
      expect(projection?.warnings[0]?.length).toBeLessThanOrEqual(500);
    }

    const listed = await listRunProjections(outputRoot);
    expect(listed.items).toHaveLength(malformedCases.length + 1);
    expect(listed.items.find((item) => item.runId === good.runId)).toMatchObject({
      runId: good.runId,
      status: "running",
    });
    for (const runId of malformedRunIds) {
      expect(listed.items.find((item) => item.runId === runId)?.status).toBe("unreadable");
    }
    expect((await listRunProjections(outputRoot, { liveOnly: true })).items).toEqual([
      expect.objectContaining({ runId: good.runId }),
    ]);
  });
  it("isolates malformed session bindings from project filters", async () => {
    const outputRoot = await makeTempDir("pi-workflows-malformed-session-binding");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState({ input: { task: "demo" } });
    const runDir = await store.initializeRunBundle(workflow, state);
    const sessionDir = path.join(runDir, "session");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "binding.json"),
      JSON.stringify({
        schema: "pi-workflows.session-binding.v1",
        runId: state.runId,
        piSessionId: "session-1",
        cwd: {},
        boundAt: state.startedAt,
      }),
    );

    const listed = await listRunProjections(outputRoot, { project: "/repo" });
    expect(listed.items).toEqual([]);
    const projection = await readRunProjection(runDir);
    expect(projection?.sessionBinding).toBeNull();
    expect(projection?.warnings).toContain(
      "malformed_session_binding: cwd must be a non-empty string",
    );
  });

  it("keeps malformed manifest fallback fields sortable when state is unreadable", async () => {
    const outputRoot = await makeTempDir("pi-workflows-manifest-fallback-projections");
    const store = new WorkflowRunStore(outputRoot);
    const good = makeState({ startedAt: "2026-08-01T00:00:00.000Z" });
    const malformed = makeState();
    await store.initializeRunBundle(workflow, good);
    const malformedRunDir = await store.initializeRunBundle(workflow, malformed);
    await fs.writeFile(path.join(malformedRunDir, "state.json"), "{not-json");
    const manifestPath = path.join(malformedRunDir, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        runId: 42,
        workflowName: false,
        runTitle: { invalid: true },
        startedAt: 42,
      }),
    );

    const listed = await listRunProjections(outputRoot);
    const malformedProjection = listed.items.find(
      (projection) => projection.runDir === malformedRunDir,
    );

    expect(listed.items).toHaveLength(2);
    expect(malformedProjection).toMatchObject({
      runId: path.basename(malformedRunDir),
      workflowName: "unknown",
      startedAt: "",
      warnings: ["unreadable_or_missing_state"],
    });
    expect(malformedProjection).not.toHaveProperty("runTitle");
  });

  it("redacts step and state errors before projecting summaries", async () => {
    const outputRoot = await makeTempDir("pi-workflows-redacted-projections");
    const store = new WorkflowRunStore(outputRoot);
    const finishedAt = new Date().toISOString();
    const stepState = makeState({
      status: "failed",
      finishedAt,
      error: "state fallback password=state-fallback-secret",
      steps: [
        {
          attemptId: "attempt-1",
          nodeId: "one",
          nodeType: "compute",
          outcome: "failed",
          startedAt: finishedAt,
          finishedAt,
          prompt: null,
          output: null,
          error: "step failed with Bearer step-bearer-secret",
        },
      ],
    });
    const stateErrorState = makeState({
      status: "failed",
      finishedAt,
      error: 'request failed with {"password":"state-json-secret"}',
    });
    const stepRunDir = await store.initializeRunBundle(workflow, stepState);
    const stateRunDir = await store.initializeRunBundle(workflow, stateErrorState);

    const stepProjection = await readRunProjection(stepRunDir);
    const stateProjection = await readRunProjection(stateRunDir);

    expect(stepProjection?.errorSummary).toBe("step failed with Bearer [redacted]");
    expect(stateProjection?.errorSummary).toBe('request failed with {"password":"[redacted]"}');
    expect(JSON.stringify([stepProjection, stateProjection])).not.toMatch(
      /step-bearer-secret|state-json-secret|state-fallback-secret/,
    );
  });
});

describe("createDefinitionSnapshot", () => {
  it("captures node metadata without functions", () => {
    const snapshot = createDefinitionSnapshot(workflow);
    expect(snapshot.name).toBe("demo");
    expect(snapshot.nodes.one).toEqual({ nodeType: "compute" });
    expect(JSON.stringify(snapshot)).not.toContain("=>");
  });

  it("records fixed timeout defaults and marks dynamic policies", () => {
    const choices = defineHumanChoices({ continue: choice({ label: "Continue" }) });
    const definition = defineWorkflow({
      name: "decision-snapshot",
      startAt: "fixed",
      nodes: {
        fixed: humanDecision({
          audience: "operator",
          choices,
          request: () => decisionPrompt(),
          onTimeout: { afterMs: 600_000, response: { choice: "continue" } },
        }),
        dynamic: humanDecision({
          audience: "operator",
          choices,
          request: () => decisionPrompt(),
          onTimeout: () => ({ afterMs: 60_000, response: { choice: "continue" } }),
        }),
      },
      edges: [{ from: "fixed", to: "dynamic" }],
    });
    const snapshot = createDefinitionSnapshot(definition);
    expect(snapshot.nodes.fixed?.humanDecision?.onTimeout).toEqual({
      afterMs: 600_000,
      response: { choice: "continue" },
    });
    expect(snapshot.nodes.dynamic?.humanDecision).toMatchObject({ dynamicTimeout: true });
    expect(snapshot.nodes.dynamic?.humanDecision?.onTimeout).toBeUndefined();
  });
});
