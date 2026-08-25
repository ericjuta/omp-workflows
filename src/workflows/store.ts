import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArtifactWriter, encodeValue } from "./artifacts.js";
import { compositionMetadata } from "./composition.js";
import { redactSensitiveText } from "./text.js";
import type {
  WorkflowDefinition,
  WorkflowDefinitionSnapshot,
  WorkflowNodeDefinition,
  WorkflowNodeSnapshot,
  WorkflowRunManifest,
  WorkflowRunState,
  WorkflowSessionBinding,
  WorkflowSessionCapture,
  WorkflowSessionEntryRecord,
  WorkflowSessionEventRecord,
  WorkflowTraceEvent,
  WorkflowTraceEventDraft,
  WorkflowUpdateInput,
  WorkflowUpdateRecord,
} from "./types.js";
import { MAX_CURRENT_UPDATES, createUpdateId, updateProjection } from "./updates.js";

export const RUN_BUNDLE_SCHEMA = "pi-workflows.run-bundle.v1" as const;
export const RUN_STATE_SCHEMA = "pi-workflows.run-state.v1" as const;
export const TRACE_EVENT_SCHEMA = "pi-workflows.trace-event.v1" as const;
export const DEFINITION_SNAPSHOT_SCHEMA = "pi-workflows.definition-snapshot.v1" as const;
export const SESSION_BINDING_SCHEMA = "pi-workflows.session-binding.v1" as const;
export const SESSION_EVENT_SCHEMA = "pi-workflows.session-event.v1" as const;
export const SESSION_CAPTURE_SCHEMA = "pi-workflows.session-capture.v1" as const;
export const SESSION_EVENT_MAX_BYTES = 1024 * 1024;

const MANIFEST_PATH = "manifest.json";
const WORKFLOW_SNAPSHOT_PATH = "workflow.json";
const STATE_PATH = "state.json";
const TRACE_PATH = "trace.ndjson";
const SESSION_DIR = "session";
const SESSION_BINDING_PATH = `${SESSION_DIR}/binding.json`;
const SESSION_ENTRIES_PATH = `${SESSION_DIR}/entries.ndjson`;
const SESSION_EVENTS_PATH = `${SESSION_DIR}/events.ndjson`;
const SESSION_CAPTURE_PATH = `${SESSION_DIR}/capture.json`;
const SESSION_SEGMENTS_DIR = `${SESSION_DIR}/segments`;

/** Capture file layout for one recorder attempt; "" is the legacy flat stream. */
function sessionStreamPaths(attemptId?: string): {
  dir: string;
  binding: string;
  entries: string;
  events: string;
  capture: string;
} {
  if (attemptId === undefined) {
    return {
      dir: SESSION_DIR,
      binding: SESSION_BINDING_PATH,
      entries: SESSION_ENTRIES_PATH,
      events: SESSION_EVENTS_PATH,
      capture: SESSION_CAPTURE_PATH,
    };
  }
  assertValidRunId(attemptId);
  const dir = `${SESSION_SEGMENTS_DIR}/${attemptId}`;
  return {
    dir,
    binding: `${dir}/binding.json`,
    entries: `${dir}/entries.ndjson`,
    events: `${dir}/events.ndjson`,
    capture: `${dir}/capture.json`,
  };
}

/** Runs directory: `$PI_WORKFLOWS_RUNS_DIR` or `~/.pi/agent/workflows/runs`. */
export function workflowRunsBaseDir(homeDir: string = os.homedir()): string {
  const override = process.env.PI_WORKFLOWS_RUNS_DIR;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return path.join(homeDir, ".pi", "agent", "workflows", "runs");
}

export function createRunId(workflowName: string, now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const slug = workflowName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-|-$)/g, "")
    .slice(0, 40);
  return `${stamp}-${slug || "workflow"}-${randomUUID().slice(0, 8)}`;
}

/** Per-attempt capture stream state; the "" key is the legacy flat stream. */
type SessionStreamState = {
  sessionSeq: number;
  sessionEventSeq: number;
  sessionBound: boolean;
  sessionEventsStopped: boolean;
  /** Session events have a separate append chain so token traffic cannot
   * queue ahead of workflow transitions. */
  lock: Promise<unknown>;
};

type RunBundleContext = {
  traceSeq: number;
  artifacts: ArtifactWriter;
  /**
   * Serializes complete transitions (encode, trace append, projections) so
   * concurrent writers cannot interleave sequence assignment with physical
   * append order.
   */
  lock: Promise<unknown>;
  streams: Map<string, SessionStreamState>;
};

/**
 * Persists run bundles (see docs/run-bundles.md). `trace.ndjson` is the
 * append-only source of truth; every transition appends the trace event
 * first, then atomically replaces `state.json` (carrying `traceSeq`) and
 * `manifest.json`. Large string leaves in persisted values are externalized
 * into content-addressed `artifacts/`. Bundles are private: directories are
 * 0700 and files 0600.
 */
/**
 * A fence proves the writer still owns the run. It is checked before every
 * locked write; it throws (ClaimLostError) when the queue claim was lost, so
 * a stalled runner can never interleave writes with the new claim holder.
 */
export type RunFence = () => void;

export type WorkflowRunStoreOptions = {
  fenceProvider?: (runDir: string) => RunFence | undefined;
};

export class WorkflowRunStore {
  readonly outputRoot: string;
  private readonly fenceProvider: ((runDir: string) => RunFence | undefined) | undefined;
  private readonly contexts = new Map<string, RunBundleContext>();

  constructor(outputRoot: string = workflowRunsBaseDir(), options: WorkflowRunStoreOptions = {}) {
    this.outputRoot = outputRoot;
    this.fenceProvider = options.fenceProvider;
  }

  runDirFor(runId: string): string {
    assertValidRunId(runId);
    return path.join(this.outputRoot, runId);
  }

  async quarantineIncompleteRun(runId: string): Promise<string | undefined> {
    const runDir = this.runDirFor(runId);
    let runStat;
    try {
      runStat = await fs.lstat(runDir);
    } catch (error) {
      if (isMissingPath(error)) {
        return undefined;
      }
      throw error;
    }
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
      throw new Error(`Reserved workflow run path is not a directory: ${runDir}`);
    }
    try {
      await fs.lstat(path.join(runDir, MANIFEST_PATH));
      throw new Error(`Reserved workflow run has an unreadable manifest: ${runId}`);
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
    }
    const quarantineDir = path.join(
      this.outputRoot,
      `.${runId}.incomplete-${randomUUID().slice(0, 8)}`,
    );
    await fs.rename(runDir, quarantineDir);
    this.contexts.delete(runDir);
    return quarantineDir;
  }

  private contextFor(runDir: string): RunBundleContext {
    let context = this.contexts.get(runDir);
    if (!context) {
      context = {
        traceSeq: 0,
        artifacts: new ArtifactWriter(runDir),
        lock: Promise.resolve(),
        streams: new Map(),
      };
      this.contexts.set(runDir, context);
    }
    return context;
  }

  private streamFor(runDir: string, attemptId?: string): SessionStreamState {
    const context = this.contextFor(runDir);
    const key = attemptId ?? "";
    let stream = context.streams.get(key);
    if (!stream) {
      stream = {
        sessionSeq: 0,
        sessionEventSeq: 0,
        sessionBound: false,
        sessionEventsStopped: false,
        lock: Promise.resolve(),
      };
      context.streams.set(key, stream);
    }
    return stream;
  }

  /**
   * Run `task` exclusively for this bundle. Sequence numbers are assigned
   * inside the lock, so physical file order always matches logical order.
   */
  private withRunLock<T>(runDir: string, task: () => Promise<T>): Promise<T> {
    const context = this.contextFor(runDir);
    const result = context.lock.then(async () => {
      this.fenceProvider?.(runDir)?.();
      return await task();
    });
    context.lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private withSessionEventLock<T>(
    runDir: string,
    attemptId: string | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    const stream = this.streamFor(runDir, attemptId);
    const result = stream.lock.then(async () => {
      this.fenceProvider?.(runDir)?.();
      return await task();
    });
    stream.lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async initializeRunBundle(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
  ): Promise<string> {
    const runDir = this.runDirFor(state.runId);
    return await this.withRunLock(runDir, async () => {
      await fs.mkdir(this.outputRoot, { recursive: true, mode: 0o700 });
      await fs.mkdir(runDir, { recursive: false, mode: 0o700 });
      await writeJsonAtomic(
        path.join(runDir, WORKFLOW_SNAPSHOT_PATH),
        createDefinitionSnapshot(workflow),
      );
      await appendLine(path.join(runDir, TRACE_PATH), null);
      await this.writeProjections(runDir, state);
      return runDir;
    });
  }

  /**
   * Prepare an interrupted bundle for resume. Repairs a torn trace tail,
   * drops trace events the state projection never recorded, and seeds the
   * in-process context so new events continue the sequence. The caller must
   * hold the run's queue claim; the fence is verified before any write.
   */
  async prepareRunResume(runId: string): Promise<LoadedRunBundle> {
    const runDir = this.runDirFor(runId);
    this.fenceProvider?.(runDir)?.();
    const bundle = await readRunBundle(runDir);
    if (bundle === null) {
      throw new Error(`Cannot resume unreadable workflow run: ${runId}`);
    }
    if (bundle.state.status !== "running") {
      throw new Error(`Cannot resume workflow run ${runId} with status ${bundle.state.status}`);
    }
    const tracePath = resolveBundlePath(runDir, bundle.manifest.paths.trace, TRACE_PATH);
    await repairTraceFile(tracePath, bundle.state.traceSeq, () => {
      // The repair rewrites the trace; re-verify ownership immediately
      // before the rename so a stalled runner cannot truncate a new claim
      // holder's appended events.
      this.fenceProvider?.(runDir)?.();
    });

    // A crashed session never finalizes its capture, and resuming recorders
    // always write new segments — so dangling "recording" captures end here
    // instead of reporting the run capture-corrupt forever.
    await this.finalizeRecordingCaptures(runDir, "Workflow host stopped before the run finished");

    const counts = await this.sessionCounts(runDir);
    const captureFinished =
      bundle.sessionCapture?.status === "complete" || bundle.sessionCapture?.status === "failed";
    this.contexts.set(runDir, {
      traceSeq: bundle.state.traceSeq,
      artifacts: new ArtifactWriter(runDir),
      lock: Promise.resolve(),
      streams: seededStreams({
        sessionSeq: counts.entryCount,
        sessionEventSeq: counts.lastEventSeq,
        sessionBound: bundle.manifest.paths.session !== undefined,
        sessionEventsStopped: captureFinished,
      }),
    });
    const prepared = await readRunBundle(runDir);
    if (prepared === null) {
      throw new Error(`Workflow run ${runId} became unreadable during resume preparation`);
    }
    return prepared;
  }

  /**
   * Finalize captures left "recording" by a session that is gone, so they
   * report failed with the reason instead of dangling forever.
   */
  private async finalizeRecordingCaptures(
    runDir: string,
    reason: string,
    options: { skipFlat?: boolean } = {},
  ): Promise<void> {
    if (options.skipFlat !== true) {
      const flatCapture = await readJsonFile<WorkflowSessionCapture>(
        path.join(runDir, SESSION_CAPTURE_PATH),
      );
      if (flatCapture?.status === "recording") {
        const counts = await this.sessionCounts(runDir);
        await this.writeSessionCapture(runDir, {
          schema: SESSION_CAPTURE_SCHEMA,
          eventSchema: SESSION_EVENT_SCHEMA,
          status: "failed",
          ...counts,
          failure: {
            failedAt: new Date().toISOString(),
            code: "host_interrupted",
            message: reason,
          },
        });
      }
    }
    for (const segmentId of await this.listSessionSegments(runDir)) {
      const segmentCapture = await readJsonFile<WorkflowSessionCapture>(
        path.join(runDir, sessionStreamPaths(segmentId).capture),
      );
      if (segmentCapture?.status !== "recording") {
        continue;
      }
      const segmentCounts = await this.sessionCounts(runDir, segmentId);
      await this.writeSessionCapture(
        runDir,
        {
          schema: SESSION_CAPTURE_SCHEMA,
          eventSchema: SESSION_EVENT_SCHEMA,
          status: "failed",
          ...segmentCounts,
          failure: {
            failedAt: new Date().toISOString(),
            code: "host_interrupted",
            message: reason,
          },
        },
        segmentId,
      );
    }
  }

  /** Mark a nonterminal bundle failed and append an interruption event. */
  async markRunInterrupted(
    runId: string,
    reason = "Workflow host stopped before the run finished",
  ): Promise<LoadedRunBundle | null> {
    const runDir = this.runDirFor(runId);
    const bundle = await readRunBundle(runDir);
    if (bundle === null || bundle.state.status !== "running") {
      return bundle;
    }
    const lastTraceEvent = await readLastTraceEvent(runDir, bundle.manifest.paths.trace);
    const counts = await this.sessionCounts(runDir);
    const sessionBound = bundle.manifest.paths.session !== undefined;
    const captureFinished =
      bundle.sessionCapture?.status === "complete" || bundle.sessionCapture?.status === "failed";
    this.contexts.set(runDir, {
      traceSeq: Math.max(bundle.state.traceSeq, lastTraceEvent?.seq ?? 0),
      artifacts: new ArtifactWriter(runDir),
      lock: Promise.resolve(),
      streams: seededStreams({
        sessionSeq: counts.entryCount,
        sessionEventSeq: counts.lastEventSeq,
        sessionBound,
        sessionEventsStopped: captureFinished,
      }),
    });
    const state = bundle.state;
    if (lastTraceEvent !== null && recoverTerminalProjection(state, lastTraceEvent)) {
      await this.writeLoadedProjections(runDir, state);
      return await readRunBundle(runDir);
    }
    if (sessionBound && !captureFinished) {
      await this.writeSessionCapture(runDir, {
        schema: SESSION_CAPTURE_SCHEMA,
        eventSchema: SESSION_EVENT_SCHEMA,
        status: "failed",
        ...counts,
        failure: {
          failedAt: new Date().toISOString(),
          code: "host_interrupted",
          message: reason,
        },
      });
    }
    await this.finalizeRecordingCaptures(runDir, reason, { skipFlat: true });
    state.status = "failed";
    state.finishedAt = new Date().toISOString();
    state.error = reason;
    delete state.currentNode;
    delete state.currentAttemptId;
    delete state.currentNodeStartedAt;
    delete state.statusDetail;
    delete state.paused;
    await this.withRunLock(runDir, async () => {
      const traceEvent = await this.appendTraceEvent(runDir, state.runId, {
        scope: "run",
        type: "run_interrupted",
        payload: { error: reason },
      });
      state.traceSeq = traceEvent.seq;
      state.updatedAt = traceEvent.at;
      await this.writeLoadedProjections(runDir, state);
    });
    return await readRunBundle(runDir);
  }

  /** Publish one durable update under the run's serialized claim-fenced writer. */
  async publishUpdate(
    runDir: string,
    state: WorkflowRunState,
    nodeId: string,
    attemptId: string,
    update: WorkflowUpdateInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ event: WorkflowTraceEvent; record: WorkflowUpdateRecord }> {
    return await this.withRunLock(runDir, async () => {
      if (options.signal?.aborted === true) {
        throw options.signal.reason ?? new Error("workflow update attempt is no longer active");
      }
      const exists = (state.updates ?? []).some(
        (record) => record.type === update.type && record.key === update.key,
      );
      if (!exists && (state.updates?.length ?? 0) >= MAX_CURRENT_UPDATES) {
        throw new Error(`workflow run supports at most ${MAX_CURRENT_UPDATES} current updates`);
      }
      const updateId = createUpdateId();
      const data = JSON.parse(JSON.stringify(update.data)) as Record<string, unknown>;
      const event = await this.appendTraceEvent(runDir, state.runId, {
        scope: "node",
        type: "update_published",
        nodeId,
        attemptId,
        payload: { updateId, type: update.type, key: update.key, data },
      });
      const record: WorkflowUpdateRecord = {
        updateId,
        seq: event.seq,
        at: event.at,
        runId: state.runId,
        nodeId,
        attemptId,
        type: update.type,
        key: update.key,
        data,
      };
      state.updates = updateProjection(state.updates, record);
      state.traceSeq = event.seq;
      state.updatedAt = event.at;
      await this.writeProjections(runDir, state);
      return { event, record };
    });
  }

  /**
   * Persist one transition: append the trace event, then rewrite the
   * projections reflecting it.
   */
  async writeSnapshot(
    runDir: string,
    state: WorkflowRunState,
    event: WorkflowTraceEventDraft,
  ): Promise<WorkflowTraceEvent> {
    return await this.withRunLock(runDir, async () => {
      const traceEvent = await this.appendTraceEvent(runDir, state.runId, event);
      state.traceSeq = traceEvent.seq;
      state.updatedAt = new Date().toISOString();
      await this.writeProjections(runDir, state);
      return traceEvent;
    });
  }

  /**
   * Bind the run to a Pi conversation: write `session/binding.json` once and
   * append a `session_bound` trace event. Projections catch up on the next
   * snapshot.
   */
  /** True when a session binding already exists for this bundle. */
  async hasSessionBinding(runDir: string): Promise<boolean> {
    try {
      await fs.lstat(path.join(runDir, SESSION_BINDING_PATH));
      return true;
    } catch {
      return false;
    }
  }

  /** List capture segment attempt ids under `session/segments/`. */
  async listSessionSegments(runDir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(path.join(runDir, SESSION_SEGMENTS_DIR), {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  async writeSessionBinding(
    runDir: string,
    binding: WorkflowSessionBinding,
    attemptId?: string,
  ): Promise<void> {
    await this.withRunLock(runDir, async () => {
      const stream = this.streamFor(runDir, attemptId);
      if (stream.sessionBound) {
        return;
      }
      stream.sessionBound = true;
      const paths = sessionStreamPaths(attemptId);
      await fs.mkdir(path.join(runDir, paths.dir), { recursive: true, mode: 0o700 });
      await writeJsonAtomic(path.join(runDir, paths.binding), binding);
      await this.appendTraceEvent(runDir, binding.runId, {
        scope: "session",
        type: "session_bound",
        payload: {
          piSessionId: binding.piSessionId,
          ...(attemptId !== undefined ? { captureAttemptId: attemptId } : {}),
        },
      });
    });
  }

  /** Append one verbatim Pi session entry to `session/entries.ndjson`. */
  async appendSessionEntry(
    runDir: string,
    entry: Record<string, unknown>,
    attemptId?: string,
  ): Promise<number> {
    return await this.withRunLock(runDir, async () => {
      const stream = this.streamFor(runDir, attemptId);
      stream.sessionSeq += 1;
      const record: WorkflowSessionEntryRecord = {
        seq: stream.sessionSeq,
        at: new Date().toISOString(),
        entry,
      };
      await appendLine(path.join(runDir, sessionStreamPaths(attemptId).entries), record);
      return record.seq;
    });
  }

  /** Append a fully stamped ordered batch to `session/events.ndjson`. */
  async appendSessionEventBatch(
    runDir: string,
    records: WorkflowSessionEventRecord[],
    attemptId?: string,
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }
    await this.withSessionEventLock(runDir, attemptId, async () => {
      const stream = this.streamFor(runDir, attemptId);
      if (stream.sessionEventsStopped) {
        throw new Error("Session event capture has stopped");
      }
      try {
        let expected = stream.sessionEventSeq + 1;
        for (const record of records) {
          validateSessionEventRecord(record);
          if (record.seq !== expected) {
            throw new Error(`Expected session event seq ${expected}, got ${record.seq}`);
          }
          expected += 1;
        }
        const encoded = await Promise.all(
          records.map(async (record) => ({
            ...record,
            payload:
              record.type === "tool_execution_started" ||
              record.type === "tool_execution_finished" ||
              (record.type === "assistant_event" && record.payload.type === "toolcall_end")
                ? ((await encodeValue(record.payload, this.contextFor(runDir).artifacts)) as Record<
                    string,
                    unknown
                  >)
                : record.payload,
          })),
        );
        for (const record of encoded) {
          if (Buffer.byteLength(JSON.stringify(record), "utf8") + 1 > SESSION_EVENT_MAX_BYTES) {
            throw new Error(`session event exceeded ${SESSION_EVENT_MAX_BYTES} bytes`);
          }
        }
        await appendLines(path.join(runDir, sessionStreamPaths(attemptId).events), encoded);
        stream.sessionEventSeq = records.at(-1)?.seq ?? stream.sessionEventSeq;
      } catch (error) {
        stream.sessionEventsStopped = true;
        throw error;
      }
    });
  }

  /** Atomically replace the temporal capture integrity projection. */
  async writeSessionCapture(
    runDir: string,
    capture: WorkflowSessionCapture,
    attemptId?: string,
  ): Promise<void> {
    validateSessionCapture(capture);
    await this.withSessionEventLock(runDir, attemptId, async () => {
      const stream = this.streamFor(runDir, attemptId);
      if (capture.status !== "recording") {
        stream.sessionEventsStopped = true;
      }
      await writeJsonAtomic(path.join(runDir, sessionStreamPaths(attemptId).capture), capture);
    });
  }

  /** Count complete durable session records after both writers have drained. */
  async sessionCounts(
    runDir: string,
    attemptId?: string,
  ): Promise<{ eventCount: number; entryCount: number; lastEventSeq: number }> {
    const paths = sessionStreamPaths(attemptId);
    const events = await readCompleteNdjson(path.join(runDir, paths.events));
    const entries = await readCompleteNdjson(path.join(runDir, paths.entries));
    return {
      eventCount: events.length,
      entryCount: entries.length,
      lastEventSeq: events.at(-1)?.seq ?? 0,
    };
  }

  private async appendTraceEvent(
    runDir: string,
    runId: string,
    event: WorkflowTraceEventDraft,
  ): Promise<WorkflowTraceEvent> {
    const context = this.contextFor(runDir);
    const traceEvent: WorkflowTraceEvent = {
      seq: context.traceSeq + 1,
      at: new Date().toISOString(),
      runId,
      ...event,
      payload: (await encodeValue(event.payload, context.artifacts)) as Record<string, unknown>,
    };
    await appendLine(path.join(runDir, TRACE_PATH), traceEvent);
    context.traceSeq = traceEvent.seq;
    return traceEvent;
  }

  private async writeProjections(runDir: string, state: WorkflowRunState): Promise<void> {
    const context = this.contextFor(runDir);
    const encoded = await encodeRunState(state, context.artifacts);
    await writeJsonAtomic(path.join(runDir, STATE_PATH), encoded);
    await writeJsonAtomic(
      path.join(runDir, MANIFEST_PATH),
      createManifest(state, {
        session: [...context.streams.values()].some((stream) => stream.sessionBound),
      }),
    );
  }

  private async writeLoadedProjections(runDir: string, state: WorkflowRunState): Promise<void> {
    const context = this.contextFor(runDir);
    await writeJsonAtomic(path.join(runDir, STATE_PATH), state);
    await writeJsonAtomic(
      path.join(runDir, MANIFEST_PATH),
      createManifest(state, {
        session: [...context.streams.values()].some((stream) => stream.sessionBound),
      }),
    );
  }
}

/**
 * Truncate a trace file to the longest contiguous valid prefix, then to the
 * event count the state projection recorded. A crash can leave a partial
 * final line or one event appended before its projection write; the repair
 * keeps state and trace consistent so resume can continue the sequence. The
 * rewrite is atomic: a stale writer appending to the old inode cannot
 * interleave with the repaired file.
 */
async function repairTraceFile(
  tracePath: string,
  keepSeq: number,
  beforeWrite?: () => void,
): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(tracePath, "utf8");
  } catch {
    return;
  }
  const lines = raw.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const good: string[] = [];
  let expectedSeq = 1;
  for (const line of lines) {
    if (line.trim().length === 0) {
      break;
    }
    try {
      const event = JSON.parse(line) as { seq?: unknown };
      if (event.seq !== expectedSeq) {
        break;
      }
      good.push(line);
      expectedSeq += 1;
    } catch {
      break;
    }
  }
  const kept = good.slice(0, keepSeq);
  if (kept.length === lines.length) {
    return;
  }
  beforeWrite?.();
  const tempPath = `${tracePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, kept.length === 0 ? "" : `${kept.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, tracePath);
}

function seededStreams(flat: Omit<SessionStreamState, "lock">): Map<string, SessionStreamState> {
  return new Map([["", { ...flat, lock: Promise.resolve() }]]);
}

function recoverTerminalProjection(state: WorkflowRunState, event: WorkflowTraceEvent): boolean {
  const status = terminalStatusForEvent(event.type);
  if (status === undefined) {
    return false;
  }
  state.traceSeq = event.seq;
  state.status = status;
  state.updatedAt = event.at;
  state.finishedAt = event.at;
  if (typeof event.payload.error === "string") {
    state.error = event.payload.error;
  }
  if (typeof event.payload.waitingOn === "string") {
    state.waitingOn = event.payload.waitingOn;
  }
  if (Object.hasOwn(event.payload, "finalOutput")) {
    state.finalOutput = event.payload.finalOutput;
  }
  delete state.currentNode;
  delete state.currentAttemptId;
  delete state.currentNodeStartedAt;
  return true;
}

function terminalStatusForEvent(type: string): WorkflowRunState["status"] | undefined {
  switch (type) {
    case "run_waiting":
      return "waiting";
    case "run_completed":
      return "completed";
    case "run_failed":
    case "run_interrupted":
      return "failed";
    case "run_timed_out":
      return "timed_out";
    case "run_cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

function assertValidRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(runId)) {
    throw new Error(`Invalid workflow run id: ${JSON.stringify(runId)}`);
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function appendLine(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.appendFile(filePath, value === null ? "" : `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function appendLines(filePath: string, values: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const text = values.map((value) => `${JSON.stringify(value)}\n`).join("");
  await fs.appendFile(filePath, text, { encoding: "utf8", mode: 0o600 });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const WORKFLOW_NODE_TYPES: Record<string, true> = {
  agent: true,
  compute: true,
  notify: true,
  action: true,
  checkpoint: true,
};

const WORKFLOW_NODE_OUTCOMES: Record<string, true> = {
  ok: true,
  timed_out: true,
  failed: true,
  cancelled: true,
};

function isWorkflowSourceShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "builtin") {
    return isNonEmptyString(value.id) && isNonEmptyString(value.revision);
  }
  if (value.kind === "file") {
    return isNonEmptyString(value.path) && isNonEmptyString(value.hash);
  }
  return false;
}

function isActionReceiptShape(value: unknown): boolean {
  if (!isRecord(value) || (value.actionType !== "shell" && value.actionType !== "function")) {
    return false;
  }
  if (value.command !== undefined && typeof value.command !== "string") return false;
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) || value.args.some((argument) => typeof argument !== "string"))
  ) {
    return false;
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") return false;
  if (
    value.exitCode !== undefined &&
    value.exitCode !== null &&
    !Number.isSafeInteger(value.exitCode)
  ) {
    return false;
  }
  if (value.signal !== undefined && value.signal !== null && typeof value.signal !== "string") {
    return false;
  }
  return (
    value.durationMs === undefined ||
    (typeof value.durationMs === "number" && Number.isFinite(value.durationMs))
  );
}

function isProjectionStep(value: unknown): value is { nodeId: string; outcome: string } {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.attemptId) &&
    isNonEmptyString(value.nodeId) &&
    isNonEmptyString(value.nodeType) &&
    WORKFLOW_NODE_TYPES[value.nodeType] === true &&
    isNonEmptyString(value.outcome) &&
    WORKFLOW_NODE_OUTCOMES[value.outcome] === true &&
    isValidTimestamp(value.startedAt) &&
    isValidTimestamp(value.finishedAt) &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.action === undefined || isActionReceiptShape(value.action))
  );
}

function isNodeResultShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.attemptId) &&
    isNonEmptyString(value.nodeId) &&
    isNonEmptyString(value.nodeType) &&
    WORKFLOW_NODE_TYPES[value.nodeType] === true &&
    isNonEmptyString(value.outcome) &&
    WORKFLOW_NODE_OUTCOMES[value.outcome] === true &&
    isValidTimestamp(value.startedAt) &&
    isValidTimestamp(value.finishedAt) &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    (value.error === undefined || typeof value.error === "string")
  );
}

function isUpdateRecordShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.updateId) &&
    Number.isSafeInteger(value.seq) &&
    (value.seq as number) >= 1 &&
    isValidTimestamp(value.at) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.nodeId) &&
    isNonEmptyString(value.attemptId) &&
    isNonEmptyString(value.type) &&
    isNonEmptyString(value.key) &&
    isRecord(value.data)
  );
}

function isHumanDecisionReceiptShape(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.response)) return false;
  return isNonEmptyString(value.nodeId) && isNonEmptyString(value.response.choice);
}

function validateRunManifestShape(manifest: WorkflowRunManifest): string | undefined {
  const record = manifest as unknown as Record<string, unknown>;
  if (!isNonEmptyString(record.runId)) return "malformed_manifest: runId must be a string";
  if (!isNonEmptyString(record.workflowName)) {
    return "malformed_manifest: workflowName must be a string";
  }
  if (record.runTitle !== undefined && typeof record.runTitle !== "string") {
    return "malformed_manifest: runTitle must be a string when present";
  }
  if (!isValidTimestamp(record.startedAt)) {
    return "malformed_manifest: startedAt must be a valid timestamp string";
  }
  if (record.finishedAt !== undefined && !isValidTimestamp(record.finishedAt)) {
    return "malformed_manifest: finishedAt must be a valid timestamp string when present";
  }
  if (!isNonEmptyString(record.status) || WORKFLOW_RUN_STATUSES[record.status] !== true) {
    return "malformed_manifest: status is invalid";
  }
  if (record.traceSchema !== TRACE_EVENT_SCHEMA) {
    return "malformed_manifest: traceSchema is invalid";
  }
  if (!isRecord(record.paths)) return "malformed_manifest: paths must be a record";
  for (const field of ["workflow", "state", "trace"] as const) {
    if (!isNonEmptyString(record.paths[field])) {
      return `malformed_manifest: paths.${field} must be a non-empty string`;
    }
  }
  for (const field of ["session", "artifacts"] as const) {
    if (record.paths[field] !== undefined && !isNonEmptyString(record.paths[field])) {
      return `malformed_manifest: paths.${field} must be a non-empty string when present`;
    }
  }
  if (record.workflowSource !== undefined && !isWorkflowSourceShape(record.workflowSource)) {
    return "malformed_manifest: workflowSource is invalid";
  }
  if (record.definitionDigest !== undefined && typeof record.definitionDigest !== "string") {
    return "malformed_manifest: definitionDigest must be a string when present";
  }
  return undefined;
}
function isDefinitionSnapshotShape(value: unknown): value is WorkflowDefinitionSnapshot {
  if (!isRecord(value) || value.schema !== DEFINITION_SNAPSHOT_SCHEMA) return false;
  if (!isNonEmptyString(value.name) || !isNonEmptyString(value.startAt)) return false;
  if (!isRecord(value.nodes) || !Array.isArray(value.edges)) return false;
  for (const node of Object.values(value.nodes)) {
    if (!isRecord(node) || !isNonEmptyString(node.nodeType)) return false;
    if (WORKFLOW_NODE_TYPES[node.nodeType] !== true) return false;
    for (const field of ["statusDetail", "summary", "localNodeId"] as const) {
      if (node[field] !== undefined && typeof node[field] !== "string") return false;
    }
    if (
      node.toolPolicy !== undefined &&
      (node.nodeType !== "agent" || node.toolPolicy !== "observation-only")
    ) {
      return false;
    }
    if (
      node.mountPath !== undefined &&
      (!Array.isArray(node.mountPath) || node.mountPath.some((part) => typeof part !== "string"))
    ) {
      return false;
    }
    if (
      node.includeTransition !== undefined &&
      node.includeTransition !== "entry" &&
      node.includeTransition !== "exit"
    ) {
      return false;
    }
    if (node.humanDecision !== undefined) {
      if (!isRecord(node.humanDecision) || !isNonEmptyString(node.humanDecision.audience)) {
        return false;
      }
      if (
        !isRecord(node.humanDecision.choices) ||
        Object.values(node.humanDecision.choices).some(
          (choice) => !isRecord(choice) || !isNonEmptyString(choice.label),
        )
      ) {
        return false;
      }
    }
  }
  for (const edge of value.edges) {
    if (!isRecord(edge) || !isNonEmptyString(edge.from)) return false;
    if ("to" in edge) {
      if (!isNonEmptyString(edge.to)) return false;
      continue;
    }
    if (!isRecord(edge.switch) || !isNonEmptyString(edge.switch.on)) return false;
    if (
      !isRecord(edge.switch.cases) ||
      Object.values(edge.switch.cases).some((target) => !isNonEmptyString(target))
    ) {
      return false;
    }
  }
  if (value.composition !== undefined) {
    if (!isRecord(value.composition) || !Array.isArray(value.composition.mounts)) return false;
    for (const mount of value.composition.mounts) {
      if (
        !isRecord(mount) ||
        !Array.isArray(mount.mountPath) ||
        mount.mountPath.some((part) => typeof part !== "string") ||
        !isNonEmptyString(mount.workflowName) ||
        !isNonEmptyString(mount.entryNode) ||
        !isRecord(mount.exits) ||
        Object.values(mount.exits).some((target) => !isNonEmptyString(target))
      ) {
        return false;
      }
    }
  }
  return true;
}

function validateSessionEventRecord(record: WorkflowSessionEventRecord): void {
  if (!Number.isSafeInteger(record.seq) || record.seq < 1) {
    throw new Error("Session event seq must be a positive safe integer");
  }
  if (
    !isNonEmptyString(record.at) ||
    !isNonEmptyString(record.nodeId) ||
    !isNonEmptyString(record.attemptId) ||
    !isNonEmptyString(record.type) ||
    typeof record.payload !== "object" ||
    record.payload === null ||
    Array.isArray(record.payload)
  ) {
    throw new Error("Session event is missing required envelope fields");
  }
  const knownType = [
    "turn_started",
    "turn_finished",
    "message_started",
    "assistant_event",
    "message_finished",
    "tool_execution_started",
    "tool_execution_updated",
    "tool_execution_finished",
  ].includes(record.type);
  if (!knownType) {
    return;
  }
  if (!isNonEmptyString(record.turnId)) {
    throw new Error(`${record.type} requires turnId`);
  }
  if (
    !["turn_started", "turn_finished"].includes(record.type) &&
    !isNonEmptyString(record.messageId)
  ) {
    throw new Error(`${record.type} requires messageId`);
  }
  if (record.type.startsWith("tool_execution_") && !isNonEmptyString(record.toolCallId)) {
    throw new Error(`${record.type} requires toolCallId`);
  }
}

function isSessionEntryRecordShape(value: unknown): value is WorkflowSessionEntryRecord {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.seq) &&
    (value.seq as number) >= 1 &&
    isValidTimestamp(value.at) &&
    isRecord(value.entry)
  );
}

function isTraceEventShape(value: unknown): value is WorkflowTraceEvent {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.seq) &&
    (value.seq as number) >= 1 &&
    isValidTimestamp(value.at) &&
    isNonEmptyString(value.scope) &&
    ["run", "node", "agent", "action", "session"].includes(value.scope) &&
    isNonEmptyString(value.type) &&
    isNonEmptyString(value.runId) &&
    (value.nodeId === undefined || isNonEmptyString(value.nodeId)) &&
    (value.attemptId === undefined || isNonEmptyString(value.attemptId)) &&
    isRecord(value.payload)
  );
}

function sessionRelationshipDiagnostics(
  entries: WorkflowSessionEntryRecord[],
  events: WorkflowSessionEventRecord[],
): string[] {
  const entryIds = new Set(
    entries.flatMap((record) => (isNonEmptyString(record.entry.id) ? [record.entry.id] : [])),
  );
  const turns = new Set<string>();
  const messages = new Set<string>();
  const tools = new Set<string>();
  const diagnostics: string[] = [];
  for (const event of events) {
    switch (event.type) {
      case "turn_started":
        if (event.turnId) turns.add(event.turnId);
        break;
      case "turn_finished":
        if (!event.turnId || !turns.has(event.turnId)) {
          diagnostics.push(`turn_finished ${event.seq} precedes turn_started`);
        }
        break;
      case "message_started":
        if (!event.turnId || !turns.has(event.turnId)) {
          diagnostics.push(`message_started ${event.seq} precedes turn_started`);
        }
        if (event.messageId) messages.add(event.messageId);
        break;
      case "assistant_event":
        if (!event.messageId || !messages.has(event.messageId)) {
          diagnostics.push(`assistant_event ${event.seq} precedes message_started`);
        }
        break;
      case "message_finished": {
        if (!event.messageId || !messages.has(event.messageId)) {
          diagnostics.push(`message_finished ${event.seq} precedes message_started`);
        }
        const settled = event.payload.settled;
        const entryId = event.payload.entryId;
        if (settled === true && (!isNonEmptyString(entryId) || !entryIds.has(entryId))) {
          diagnostics.push(`message_finished ${event.seq} references a missing entry`);
        } else if (settled !== true && entryId !== undefined) {
          diagnostics.push(`message_finished ${event.seq} has entryId while unsettled`);
        }
        break;
      }
      case "tool_execution_started":
        if (!event.messageId || !messages.has(event.messageId)) {
          diagnostics.push(`tool_execution_started ${event.seq} precedes message_started`);
        }
        if (event.toolCallId) tools.add(event.toolCallId);
        break;
      case "tool_execution_updated":
      case "tool_execution_finished":
        if (!event.toolCallId || !tools.has(event.toolCallId)) {
          diagnostics.push(`${event.type} ${event.seq} precedes tool_execution_started`);
        }
        break;
      default:
        break;
    }
  }
  return diagnostics;
}

function validateSessionCapture(capture: WorkflowSessionCapture): void {
  if (
    capture.schema !== SESSION_CAPTURE_SCHEMA ||
    capture.eventSchema !== SESSION_EVENT_SCHEMA ||
    !["recording", "complete", "failed"].includes(capture.status) ||
    !Number.isSafeInteger(capture.eventCount) ||
    capture.eventCount < 0 ||
    !Number.isSafeInteger(capture.entryCount) ||
    capture.entryCount < 0 ||
    !Number.isSafeInteger(capture.lastEventSeq) ||
    capture.lastEventSeq < 0
  ) {
    throw new Error("Invalid session capture projection");
  }
  if (capture.status === "failed" && capture.failure === undefined) {
    throw new Error("Failed session capture requires failure details");
  }
  if (capture.status !== "failed" && capture.failure !== undefined) {
    throw new Error("Only failed session capture may contain failure details");
  }
}

async function readCompleteNdjson(filePath: string): Promise<Array<{ seq: number }>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  if (!raw.endsWith("\n")) {
    lines.pop();
  }
  const records: Array<{ seq: number }> = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const value = JSON.parse(line) as { seq?: unknown };
      if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1) {
        break;
      }
      records.push({ seq: value.seq as number });
    } catch {
      break;
    }
  }
  return records;
}

/**
 * Encode the externalizable value positions of the state document. The
 * in-memory state always holds raw values; the persisted copy may carry
 * `$artifact` references instead of large strings.
 */
async function encodeRunState(
  state: WorkflowRunState,
  artifacts: ArtifactWriter,
): Promise<WorkflowRunState> {
  const results = Object.fromEntries(
    await Promise.all(
      Object.entries(state.results).map(async ([nodeId, result]) => [
        nodeId,
        "output" in result
          ? { ...result, output: await encodeValue(result.output, artifacts) }
          : result,
      ]),
    ),
  ) as WorkflowRunState["results"];
  return {
    ...state,
    input: await encodeValue(state.input, artifacts),
    outputs: Object.fromEntries(
      await Promise.all(
        Object.entries(state.outputs).map(async ([nodeId, output]) => [
          nodeId,
          await encodeValue(output, artifacts),
        ]),
      ),
    ),
    results,
    steps: await Promise.all(
      state.steps.map(async (step) => ({
        ...step,
        prompt: (await encodeValue(
          step.prompt,
          artifacts,
        )) as WorkflowRunState["steps"][number]["prompt"],
        output: await encodeValue(step.output, artifacts),
      })),
    ),
    ...(state.finalOutput !== undefined
      ? { finalOutput: await encodeValue(state.finalOutput, artifacts) }
      : {}),
  };
}

export type SessionCaptureIntegrity = {
  status: "unavailable" | "recording" | "complete" | "failed" | "invalid";
  diagnostics: string[];
};

/** One capture attempt: the session data a single recorder wrote. */
export type SessionCaptureSegment = {
  attemptId: string;
  binding: WorkflowSessionBinding | null;
  entries: WorkflowSessionEntryRecord[];
  events: WorkflowSessionEventRecord[];
  capture: WorkflowSessionCapture | null;
  integrity: SessionCaptureIntegrity;
};

export type LoadedRunBundle = {
  runDir: string;
  manifest: WorkflowRunManifest;
  state: WorkflowRunState;
  snapshot: WorkflowDefinitionSnapshot | null;
  /** Full durable trace when loaded by the current reader. */
  traceEvents?: WorkflowTraceEvent[];
  /** Parse health for the loaded trace stream. */
  traceIntegrity?: Pick<NdjsonRead<WorkflowTraceEvent>, "exists" | "tornTail" | "malformed">;
  sessionBinding: WorkflowSessionBinding | null;
  sessionEntries: WorkflowSessionEntryRecord[];
  sessionEvents: WorkflowSessionEventRecord[];
  sessionCapture: WorkflowSessionCapture | null;
  sessionIntegrity: SessionCaptureIntegrity;
  /** Per-attempt captures written after a handoff or resume. */
  sessionSegments: SessionCaptureSegment[];
};

export type WorkflowRunProjection = {
  runDir: string;
  runId: string;
  workflowName: string;
  workflowId?: string;
  revision?: string;
  status: string;
  effectiveStatus?: string;
  startedAt: string;
  updatedAt?: string;
  durationMs?: number;
  paused?: boolean;
  pausedAgeMs?: number;
  currentNode?: string;
  failedNodeId?: string;
  errorSummary?: string;
  errorCode?: string;
  parentRunId?: string;
  continuationRunId?: string;
  waitingOn?: unknown;
  runTitle?: string;
  project?: string;
  sessionBinding?: WorkflowSessionBinding | null;
  input?: unknown;
  warnings: string[];
};

/** Read a fast run projection from disk without loading traces or session streams. */
export async function readRunProjection(runDir: string): Promise<WorkflowRunProjection | null> {
  try {
    return await readRunProjectionUnchecked(runDir);
  } catch (error) {
    return {
      runDir,
      runId: path.basename(runDir),
      workflowName: "unknown",
      status: "unreadable",
      startedAt: "",
      warnings: [
        redactSensitiveText(
          `unreadable_bundle: ${failureMessageForDiagnostic(error).replace(/\s+/g, " ")}`,
          500,
        ),
      ],
    };
  }
}

function incompatibleRunProjection(runDir: string, schemaWarning: string): WorkflowRunProjection {
  const resetInstruction =
    "Reset this workflow run by deleting its local run directory, then start a new run.";
  return {
    runDir,
    runId: path.basename(runDir),
    workflowName: "unknown",
    status: "unreadable",
    startedAt: "",
    errorSummary: resetInstruction,
    warnings: [redactSensitiveText(`${schemaWarning}; ${resetInstruction}`, 500)],
  };
}
const WORKFLOW_RUN_STATUSES: Record<string, true> = {
  running: true,
  waiting: true,
  completed: true,
  failed: true,
  timed_out: true,
  cancelled: true,
};
const TERMINAL_WORKFLOW_RUN_STATUSES: Record<string, true> = {
  completed: true,
  failed: true,
  timed_out: true,
  cancelled: true,
};

function validateRunStateShape(state: WorkflowRunState): string | undefined {
  const record = state as unknown as Record<string, unknown>;
  if (!Number.isSafeInteger(record.traceSeq) || (record.traceSeq as number) < 0) {
    return "malformed_state: traceSeq must be a non-negative safe integer";
  }
  if (!isRecord(record.outputs)) {
    return "malformed_state: outputs must be a record";
  }
  if (
    !isRecord(record.results) ||
    Object.values(record.results).some((result) => !isNodeResultShape(result))
  ) {
    return "malformed_state: results must be a record of node results";
  }
  if (!Array.isArray(record.steps)) {
    return "malformed_state: steps must be an array";
  }
  if (record.steps.some((step) => !isProjectionStep(step))) {
    return "malformed_state: steps must contain valid step records";
  }
  if (
    record.updates !== undefined &&
    (!Array.isArray(record.updates) ||
      record.updates.some((update) => !isUpdateRecordShape(update)))
  ) {
    return "malformed_state: updates must be an array of update records when present";
  }
  if (!isNonEmptyString(record.runId)) {
    return "malformed_state: runId must be a non-empty string";
  }
  if (!isNonEmptyString(record.workflowName)) {
    return "malformed_state: workflowName must be a non-empty string";
  }
  if (!isNonEmptyString(record.status) || WORKFLOW_RUN_STATUSES[record.status] !== true) {
    return "malformed_state: status is invalid";
  }
  if (!isValidTimestamp(record.startedAt)) {
    return "malformed_state: startedAt must be a valid timestamp string";
  }
  if (!isValidTimestamp(record.updatedAt)) {
    return "malformed_state: updatedAt must be a valid timestamp string";
  }
  if (record.finishedAt !== undefined && !isValidTimestamp(record.finishedAt)) {
    return "malformed_state: finishedAt must be a valid timestamp string when present";
  }
  for (const field of [
    "parentRunId",
    "runTitle",
    "currentNode",
    "waitingOn",
    "error",
    "currentAttemptId",
    "statusDetail",
    "definitionDigest",
  ] as const) {
    if (record[field] !== undefined && typeof record[field] !== "string") {
      return `malformed_state: ${field} must be a string when present`;
    }
  }
  if (record.currentNodeStartedAt !== undefined && !isValidTimestamp(record.currentNodeStartedAt)) {
    return "malformed_state: currentNodeStartedAt must be a valid timestamp string when present";
  }
  if (record.paused !== undefined && typeof record.paused !== "boolean") {
    return "malformed_state: paused must be a boolean when present";
  }
  if (record.workflowSource !== undefined && !isWorkflowSourceShape(record.workflowSource)) {
    return "malformed_state: workflowSource is invalid";
  }
  if (record.humanDecision !== undefined && !isHumanDecisionReceiptShape(record.humanDecision)) {
    return "malformed_state: humanDecision is invalid";
  }
  return undefined;
}

function validateProjectionState(state: WorkflowRunState): string | undefined {
  const malformedShape = validateRunStateShape(state);
  if (malformedShape !== undefined) return malformedShape;
  const record = state as unknown as Record<string, unknown>;
  if (
    TERMINAL_WORKFLOW_RUN_STATUSES[record.status as string] === true &&
    !isValidTimestamp(record.finishedAt)
  ) {
    return "malformed_state: finishedAt must be a valid timestamp for a terminal run";
  }
  if (record.status === "waiting" && !isNonEmptyString(record.waitingOn)) {
    return "malformed_state: waitingOn must be a non-empty string for a waiting run";
  }
  return undefined;
}

function validateSessionBinding(binding: WorkflowSessionBinding): string | undefined {
  const record = binding as unknown as Record<string, unknown>;
  if (!isNonEmptyString(record.runId)) {
    return "malformed_session_binding: runId must be a non-empty string";
  }
  if (!isNonEmptyString(record.piSessionId)) {
    return "malformed_session_binding: piSessionId must be a non-empty string";
  }
  if (!isNonEmptyString(record.cwd)) {
    return "malformed_session_binding: cwd must be a non-empty string";
  }
  if (!isValidTimestamp(record.boundAt)) {
    return "malformed_session_binding: boundAt must be a valid timestamp string";
  }
  if (record.piSessionFile !== undefined && !isNonEmptyString(record.piSessionFile)) {
    return "malformed_session_binding: piSessionFile must be a non-empty string when present";
  }
  return undefined;
}

function isValidTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

async function readRunProjectionUnchecked(runDir: string): Promise<WorkflowRunProjection | null> {
  const warnings: string[] = [];
  const manifest = await readJsonFile<WorkflowRunManifest>(path.join(runDir, MANIFEST_PATH));
  if (!manifest) {
    warnings.push("unreadable_or_missing_manifest");
  } else if (manifest.schema !== RUN_BUNDLE_SCHEMA) {
    return incompatibleRunProjection(
      runDir,
      `incompatible_manifest_schema: ${String(manifest.schema)}`,
    );
  }

  const paths: Partial<WorkflowRunManifest["paths"]> =
    typeof manifest?.paths === "object" && manifest.paths !== null ? manifest.paths : {};
  const statePath = resolveBundlePath(runDir, paths.state, STATE_PATH);
  const state = await readJsonFile<WorkflowRunState>(statePath);

  if (!state) {
    warnings.push("unreadable_or_missing_state");
  } else if (state.schema !== RUN_STATE_SCHEMA) {
    return incompatibleRunProjection(runDir, `incompatible_state_schema: ${String(state.schema)}`);
  }
  if (state) {
    const malformedStateWarning = validateProjectionState(state);
    if (malformedStateWarning !== undefined) {
      return incompatibleRunProjection(runDir, malformedStateWarning);
    }
  }

  if (!manifest && !state) {
    return {
      runDir,
      runId: path.basename(runDir),
      workflowName: "unknown",
      status: "unreadable",
      startedAt: "",
      warnings: ["unreadable_bundle: missing or unreadable manifest and state"],
    };
  }

  const manifestRunId = manifest?.runId;
  const manifestWorkflowName = manifest?.workflowName;
  const manifestStatus = manifest?.status;
  const manifestStartedAt = manifest?.startedAt;
  const runId =
    state?.runId ?? (isNonEmptyString(manifestRunId) ? manifestRunId : path.basename(runDir));
  const workflowName =
    state?.workflowName ??
    (isNonEmptyString(manifestWorkflowName) ? manifestWorkflowName : "unknown");
  const status = state?.status ?? (isNonEmptyString(manifestStatus) ? manifestStatus : "unknown");
  const startedAt =
    state?.startedAt ?? (isValidTimestamp(manifestStartedAt) ? manifestStartedAt : "");
  const updatedAtCandidate = state?.updatedAt ?? state?.finishedAt ?? manifest?.finishedAt;
  const updatedAt =
    typeof updatedAtCandidate === "string" && updatedAtCandidate.length > 0
      ? updatedAtCandidate
      : undefined;
  const paused = state?.paused;
  const currentNode = state?.currentNode;
  const waitingOn = state?.waitingOn;
  const runTitle =
    state?.runTitle ?? (typeof manifest?.runTitle === "string" ? manifest.runTitle : undefined);
  const parentRunId = state?.parentRunId;
  const input = state?.input;

  let revision: string | undefined;
  let workflowId: string | undefined;
  const workflowSourceCandidate = state?.workflowSource ?? manifest?.workflowSource;
  const workflowSource = isWorkflowSourceShape(workflowSourceCandidate)
    ? (workflowSourceCandidate as WorkflowRunState["workflowSource"])
    : undefined;
  if (workflowSource?.kind === "builtin") {
    revision = workflowSource.revision;
    workflowId = workflowSource.id;
  }

  let failedNodeId: string | undefined;
  let errorSummary: string | undefined;
  if (status === "failed" || status === "timed_out") {
    const steps = state?.steps ?? [];
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index];
      if (step?.outcome !== "failed" && step?.outcome !== "timed_out") continue;
      failedNodeId = step.nodeId;
      if (step.error !== undefined) {
        errorSummary = redactSensitiveText(failureMessageForDiagnostic(step.error), 500);
      }
      break;
    }
    failedNodeId ??= state?.currentNode;
    if (errorSummary === undefined && state?.error !== undefined) {
      errorSummary = redactSensitiveText(failureMessageForDiagnostic(state.error), 500);
    }
  }

  let durationMs: number | undefined;
  let pausedAgeMs: number | undefined;
  const nowMs = Date.now();
  if (startedAt) {
    const startMs = Date.parse(startedAt);
    if (!Number.isNaN(startMs)) {
      if (startMs > nowMs + 60_000) {
        warnings.push("duration_anomaly: started_in_future");
      }
      if (status === "running" || status === "waiting") {
        durationMs = Math.max(0, nowMs - startMs);
      } else {
        const endMs =
          updatedAt !== undefined && !Number.isNaN(Date.parse(updatedAt))
            ? Date.parse(updatedAt)
            : startMs;
        durationMs = Math.max(0, endMs - startMs);
      }
    } else {
      warnings.push("invalid_started_at_timestamp");
    }
  }

  if (paused === true) {
    const pausedSinceMs = updatedAt === undefined ? Number.NaN : Date.parse(updatedAt);
    pausedAgeMs = Number.isNaN(pausedSinceMs)
      ? (durationMs ?? 0)
      : Math.max(0, nowMs - pausedSinceMs);
  }

  if (manifest && state) {
    if (manifest.runId !== state.runId) {
      warnings.push(
        `manifest_state_run_id_mismatch: manifest=${manifest.runId}, state=${state.runId}`,
      );
    }
    if (manifest.workflowName !== state.workflowName) {
      warnings.push(
        `manifest_state_workflow_name_mismatch: manifest=${manifest.workflowName}, state=${state.workflowName}`,
      );
    }
  }

  const snapshotPath = resolveBundlePath(runDir, paths.workflow, WORKFLOW_SNAPSHOT_PATH);
  const snapshotCandidate = await readJsonFile<WorkflowDefinitionSnapshot>(snapshotPath);
  const snapshot = isDefinitionSnapshotShape(snapshotCandidate) ? snapshotCandidate : null;
  if (!snapshotCandidate) {
    warnings.push("missing_definition_snapshot");
  } else if (snapshotCandidate.schema !== DEFINITION_SNAPSHOT_SCHEMA) {
    warnings.push(`incompatible_snapshot_schema: ${String(snapshotCandidate.schema)}`);
  } else if (!snapshot) {
    warnings.push("malformed_definition_snapshot");
  } else {
    if (currentNode && !snapshot.nodes[currentNode]) {
      const isCompositionNode =
        snapshot.composition !== undefined &&
        (snapshot.composition.mounts.some((m) =>
          currentNode.startsWith(`${m.mountPath.join("/")}/`),
        ) ||
          Object.keys(snapshot.nodes).some((k) => currentNode.startsWith(`${k}/`)));
      if (!isCompositionNode) {
        warnings.push(`current_node_not_in_snapshot: ${currentNode}`);
      }
    }
  }

  let sessionBinding: WorkflowSessionBinding | null = null;
  const sessionDir = resolveBundlePath(runDir, paths.session, SESSION_DIR);
  sessionBinding = await readJsonFile<WorkflowSessionBinding>(
    path.join(sessionDir, "binding.json"),
  );
  if (paths.session !== undefined && !sessionBinding) {
    warnings.push("missing_session_binding");
  } else if (sessionBinding && sessionBinding.schema !== SESSION_BINDING_SCHEMA) {
    warnings.push(`incompatible_session_binding_schema: ${sessionBinding.schema}`);
    sessionBinding = null;
  }
  if (sessionBinding?.schema === SESSION_BINDING_SCHEMA) {
    const malformedBindingWarning = validateSessionBinding(sessionBinding);
    if (malformedBindingWarning !== undefined) {
      warnings.push(malformedBindingWarning);
      sessionBinding = null;
    }
  }

  let project: string | undefined;
  if (sessionBinding?.cwd) {
    project = sessionBinding.cwd;
  } else if (typeof input === "object" && input !== null) {
    const rec = input as Record<string, unknown>;
    if (typeof rec.repository === "string") {
      project = rec.repository;
    } else if (typeof rec.project === "string") {
      project = rec.project;
    } else if (typeof rec.cwd === "string") {
      project = rec.cwd;
    }
  }

  return {
    runDir,
    runId,
    workflowName,
    ...(workflowId !== undefined ? { workflowId } : {}),
    ...(revision !== undefined ? { revision } : {}),
    status,
    startedAt,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(paused !== undefined ? { paused } : {}),
    ...(pausedAgeMs !== undefined ? { pausedAgeMs } : {}),
    ...(currentNode !== undefined ? { currentNode } : {}),
    ...(failedNodeId !== undefined ? { failedNodeId } : {}),
    ...(errorSummary !== undefined ? { errorSummary } : {}),
    ...(parentRunId !== undefined ? { parentRunId } : {}),
    ...(waitingOn !== undefined ? { waitingOn } : {}),
    ...(runTitle !== undefined ? { runTitle } : {}),
    ...(project !== undefined ? { project } : {}),
    sessionBinding,
    ...(input !== undefined ? { input } : {}),
    warnings: warnings.slice(0, 8).map((warning) => redactSensitiveText(warning, 500)),
  };
}

export type ListRunProjectionsOptions = {
  project?: string;
  liveOnly?: boolean;
  limit?: number;
};

export type ListRunProjectionsResult = {
  items: WorkflowRunProjection[];
  warnings: string[];
};

function extractProjectCandidates(projection: {
  project?: string;
  sessionBinding?: WorkflowSessionBinding | null;
  input?: unknown;
}): string[] {
  const candidates: string[] = [];
  if (projection.sessionBinding?.cwd && projection.sessionBinding.cwd.trim().length > 0) {
    candidates.push(projection.sessionBinding.cwd.trim());
  }
  if (typeof projection.input === "object" && projection.input !== null) {
    const rec = projection.input as Record<string, unknown>;
    if (typeof rec.repository === "string" && rec.repository.trim().length > 0) {
      candidates.push(rec.repository.trim());
    }
    if (typeof rec.project === "string" && rec.project.trim().length > 0) {
      candidates.push(rec.project.trim());
    }
    if (typeof rec.cwd === "string" && rec.cwd.trim().length > 0) {
      candidates.push(rec.cwd.trim());
    }
  }
  if (
    projection.project &&
    projection.project.trim().length > 0 &&
    !candidates.includes(projection.project.trim())
  ) {
    candidates.push(projection.project.trim());
  }
  return candidates;
}

/** Fast list of run projections under `outputRoot`, avoiding trace and session stream loads. */
export async function listRunProjections(
  outputRoot: string,
  options: ListRunProjectionsOptions = {},
): Promise<ListRunProjectionsResult> {
  let entries: string[];
  try {
    entries = await fs.readdir(outputRoot);
  } catch (error) {
    return {
      items: [],
      warnings: isMissingPath(error)
        ? []
        : [
            redactSensitiveText(
              `[runs] unreadable_directory: ${failureMessageForDiagnostic(error)}`,
              240,
            ),
          ],
    };
  }
  const projections: WorkflowRunProjection[] = [];
  const aggregateWarnings: string[] = [];
  for (const entry of entries) {
    const runDir = path.join(outputRoot, entry);
    try {
      const stat = await fs.stat(runDir);
      if (!stat.isDirectory()) continue;
    } catch (error) {
      aggregateWarnings.push(
        redactSensitiveText(
          `[${entry.slice(0, 160)}] unreadable_run_directory: ${failureMessageForDiagnostic(error)}`,
          500,
        ),
      );
      continue;
    }
    const projection = await readRunProjection(runDir);
    if (projection === null) continue;
    projections.push(projection);
    for (const warning of projection.warnings) {
      aggregateWarnings.push(`[${projection.runId}] ${warning}`);
    }
  }
  projections.sort((a, b) =>
    (typeof b.startedAt === "string" ? b.startedAt : "").localeCompare(
      typeof a.startedAt === "string" ? a.startedAt : "",
    ),
  );
  let filtered = projections;
  if (options.project !== undefined) {
    const target = path.resolve(options.project);
    filtered = filtered.filter((projection) => {
      const candidates = extractProjectCandidates(projection);
      return candidates.some((candidate) => {
        const resolved = path.resolve(candidate);
        return resolved === target || resolved.startsWith(`${target}${path.sep}`);
      });
    });
  }
  if (options.liveOnly === true) {
    filtered = filtered.filter(
      (projection) =>
        projection.paused === true ||
        projection.status === "running" ||
        projection.status === "waiting" ||
        projection.status === "queued",
    );
  }
  if (options.limit !== undefined && options.limit >= 0) {
    filtered = filtered.slice(0, options.limit);
  }
  return { items: filtered, warnings: aggregateWarnings.slice(0, 100) };
}

/**
 * Read run state without loading traces or session streams. Returns null when
 * the manifest or state is missing, unreadable, or schema-incompatible.
 */
export async function readRunState(runDir: string): Promise<WorkflowRunState | null> {
  const manifest = await readJsonFile<WorkflowRunManifest>(path.join(runDir, MANIFEST_PATH));
  if (!manifest || manifest.schema !== RUN_BUNDLE_SCHEMA) {
    return null;
  }
  if (validateRunManifestShape(manifest) !== undefined) return null;
  const paths: Partial<WorkflowRunManifest["paths"]> =
    typeof manifest.paths === "object" && manifest.paths !== null ? manifest.paths : {};
  const statePath = resolveBundlePath(runDir, paths.state, STATE_PATH);
  const state = await readJsonFile<WorkflowRunState>(statePath);
  if (!state || state.schema !== RUN_STATE_SCHEMA) {
    return null;
  }
  if (validateRunStateShape(state) !== undefined) return null;
  return state;
}

/** Read the final trace record without loading the rest of a run bundle. */
export async function readLastTraceEvent(
  runDir: string,
  tracePath?: string,
): Promise<WorkflowTraceEvent | null> {
  const events = await readNdjsonFile<WorkflowTraceEvent>(
    resolveBundlePath(runDir, tracePath, TRACE_PATH),
    isTraceEventShape,
  );
  return events.records.at(-1) ?? null;
}

export type ReadRunBundleOptions = {
  /** Load the full append-only trace. Detail views need it; run lists do not. */
  includeTrace?: boolean;
};

/** Read a run bundle from disk. Returns null when the bundle is unreadable. */
export async function readRunBundle(
  runDir: string,
  options: ReadRunBundleOptions = {},
): Promise<LoadedRunBundle | null> {
  const manifest = await readJsonFile<WorkflowRunManifest>(path.join(runDir, MANIFEST_PATH));
  if (!manifest || manifest.schema !== RUN_BUNDLE_SCHEMA) {
    return null;
  }
  // A schema-tagged manifest may still be malformed (e.g. hand-edited);
  if (validateRunManifestShape(manifest) !== undefined) return null;
  // treat anything unexpected as an unreadable bundle rather than throwing.
  const paths: Partial<WorkflowRunManifest["paths"]> =
    typeof manifest.paths === "object" && manifest.paths !== null ? manifest.paths : {};
  const state = await readJsonFile<WorkflowRunState>(
    resolveBundlePath(runDir, paths.state, STATE_PATH),
  );
  if (!state || state.schema !== RUN_STATE_SCHEMA) {
    return null;
  }
  if (validateRunStateShape(state) !== undefined) return null;
  const snapshotCandidate = await readJsonFile<WorkflowDefinitionSnapshot>(
    resolveBundlePath(runDir, paths.workflow, WORKFLOW_SNAPSHOT_PATH),
  );
  const snapshot = isDefinitionSnapshotShape(snapshotCandidate) ? snapshotCandidate : null;
  const trace =
    options.includeTrace === true
      ? await readNdjsonFile<WorkflowTraceEvent>(
          resolveBundlePath(runDir, paths.trace, TRACE_PATH),
          isTraceEventShape,
        )
      : undefined;
  const sessionDir = resolveBundlePath(runDir, paths.session, SESSION_DIR);
  let sessionBinding = await readJsonFile<WorkflowSessionBinding>(
    path.join(sessionDir, "binding.json"),
  );
  if (
    sessionBinding?.schema !== SESSION_BINDING_SCHEMA ||
    validateSessionBinding(sessionBinding) !== undefined
  ) {
    sessionBinding = null;
  }
  const entries = await readNdjsonFile<WorkflowSessionEntryRecord>(
    path.join(sessionDir, "entries.ndjson"),
  );
  const events = await readNdjsonFile<WorkflowSessionEventRecord>(
    path.join(sessionDir, "events.ndjson"),
  );
  const sessionCapture = await readJsonFile<WorkflowSessionCapture>(
    path.join(sessionDir, "capture.json"),
  );
  const flatIntegrity = assessSessionIntegrity({
    binding: sessionBinding,
    entries,
    events,
    capture: sessionCapture,
    runTerminal: state.status !== "running",
  });
  const sessionSegments: SessionCaptureSegment[] = [];
  let segmentIds: string[] = [];
  try {
    segmentIds = (await fs.readdir(path.join(sessionDir, "segments"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // No segments directory means only the flat stream can exist.
  }
  for (const attemptId of segmentIds) {
    const segmentDir = path.join(sessionDir, "segments", attemptId);
    let binding = await readJsonFile<WorkflowSessionBinding>(path.join(segmentDir, "binding.json"));
    if (
      binding?.schema !== SESSION_BINDING_SCHEMA ||
      (binding !== null && validateSessionBinding(binding) !== undefined)
    ) {
      binding = null;
    }
    const segmentEntries = await readNdjsonFile<WorkflowSessionEntryRecord>(
      path.join(segmentDir, "entries.ndjson"),
    );
    const segmentEvents = await readNdjsonFile<WorkflowSessionEventRecord>(
      path.join(segmentDir, "events.ndjson"),
    );
    const capture = await readJsonFile<WorkflowSessionCapture>(
      path.join(segmentDir, "capture.json"),
    );
    sessionSegments.push({
      attemptId,
      binding,
      entries: segmentEntries.records,
      events: segmentEvents.records,
      capture,
      integrity: assessSessionIntegrity({
        binding,
        entries: segmentEntries,
        events: segmentEvents,
        capture,
        runTerminal: state.status !== "running",
      }),
    });
  }
  // The headline integrity is the flat stream's when present; otherwise the
  // chronologically latest capture segment speaks for the run (segment ids
  // are random, so directory order says nothing about time).
  sessionSegments.sort((a, b) =>
    (a.binding?.boundAt ?? "").localeCompare(b.binding?.boundAt ?? ""),
  );
  const sessionIntegrity =
    flatIntegrity.status !== "unavailable" || sessionSegments.length === 0
      ? flatIntegrity
      : (sessionSegments.at(-1)?.integrity ?? flatIntegrity);
  return {
    runDir,
    manifest,
    state,
    snapshot,
    ...(trace !== undefined
      ? {
          traceEvents: trace.records,
          traceIntegrity: {
            exists: trace.exists,
            tornTail: trace.tornTail,
            malformed: trace.malformed,
          },
        }
      : {}),
    sessionBinding,
    sessionEntries: entries.records,
    sessionEvents: events.records,
    sessionCapture,
    sessionIntegrity,
    sessionSegments,
  };
}

/**
 * Resolve a manifest-relative path, rejecting anything that is not a string
 * or escapes the bundle directory. Malformed manifests must degrade to an
 * unreadable bundle, never to a thrown error that aborts a listing.
 */
function resolveBundlePath(runDir: string, relative: unknown, fallback: string): string {
  const candidate = path.resolve(
    runDir,
    typeof relative === "string" && relative ? relative : fallback,
  );
  if (
    candidate !== path.resolve(runDir) &&
    !candidate.startsWith(path.resolve(runDir) + path.sep)
  ) {
    return path.join(runDir, fallback);
  }
  return candidate;
}

/** List run bundles under `outputRoot`, most recently started first. */
export async function listRunBundles(outputRoot: string): Promise<LoadedRunBundle[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(outputRoot);
  } catch {
    return [];
  }
  const bundles: LoadedRunBundle[] = [];
  for (const entry of entries) {
    const bundle = await readRunBundle(path.join(outputRoot, entry), { includeTrace: false });
    if (bundle) {
      bundles.push(bundle);
    }
  }
  bundles.sort((a, b) => b.state.startedAt.localeCompare(a.state.startedAt));
  return bundles;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

type NdjsonRead<T> = {
  records: T[];
  exists: boolean;
  tornTail: boolean;
  malformed: boolean;
};

async function readNdjsonFile<T>(
  filePath: string,
  isRecordShape?: (value: unknown) => value is T,
): Promise<NdjsonRead<T>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return { records: [], exists: false, tornTail: false, malformed: false };
  }
  const tornTail = raw.length > 0 && !raw.endsWith("\n");
  const lines = raw.split("\n");
  if (tornTail) {
    lines.pop();
  }
  const records: T[] = [];
  let malformed = false;
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecordShape !== undefined && !isRecordShape(parsed)) {
        malformed = true;
        continue;
      }
      records.push(parsed as T);
    } catch {
      malformed = true;
    }
  }
  return { records, exists: true, tornTail, malformed };
}

function assessSessionIntegrity(input: {
  binding: WorkflowSessionBinding | null;
  entries: NdjsonRead<WorkflowSessionEntryRecord>;
  events: NdjsonRead<WorkflowSessionEventRecord>;
  capture: WorkflowSessionCapture | null;
  runTerminal: boolean;
}): SessionCaptureIntegrity {
  const anySessionFile =
    input.binding !== null || input.entries.exists || input.events.exists || input.capture !== null;
  if (!anySessionFile) {
    return { status: "unavailable", diagnostics: [] };
  }
  const diagnostics: string[] = [];
  if (!input.binding || input.binding.schema !== SESSION_BINDING_SCHEMA) {
    diagnostics.push("missing or invalid session binding");
  }
  if (!input.capture) {
    diagnostics.push("missing session capture status");
    return { status: "invalid", diagnostics };
  }
  try {
    validateSessionCapture(input.capture);
  } catch (error) {
    diagnostics.push(failureMessageForDiagnostic(error));
    return { status: "invalid", diagnostics };
  }
  if (input.entries.malformed || input.events.malformed) {
    diagnostics.push("malformed NDJSON line before the journal tail");
  }
  if (input.events.tornTail && input.capture.status !== "recording") {
    diagnostics.push("terminal session event journal has a torn tail");
  }
  if (input.runTerminal && input.capture.status === "recording") {
    diagnostics.push("terminal run still reports recording capture");
  }
  const validEntries: WorkflowSessionEntryRecord[] = [];
  for (const entry of input.entries.records) {
    if (!isSessionEntryRecordShape(entry)) {
      diagnostics.push("session entry is missing required envelope fields");
      break;
    }
    validEntries.push(entry);
  }
  const validEvents: WorkflowSessionEventRecord[] = [];
  let expected = 1;
  for (const event of input.events.records) {
    try {
      validateSessionEventRecord(event);
    } catch (error) {
      diagnostics.push(failureMessageForDiagnostic(error));
      break;
    }
    if (event.seq !== expected) {
      diagnostics.push(`session event sequence gap at ${expected}`);
      break;
    }
    validEvents.push(event);
    expected += 1;
  }
  diagnostics.push(...sessionRelationshipDiagnostics(validEntries, validEvents));
  if (input.capture.status !== "recording") {
    const lastEventSeq = input.events.records.at(-1)?.seq ?? 0;
    if (
      input.capture.eventCount !== input.events.records.length ||
      input.capture.entryCount !== input.entries.records.length ||
      input.capture.lastEventSeq !== lastEventSeq
    ) {
      diagnostics.push("session capture counts do not match durable files");
    }
  }
  if (diagnostics.length > 0) {
    return { status: "invalid", diagnostics };
  }
  if (input.capture.status === "failed") {
    return {
      status: "failed",
      diagnostics: [input.capture.failure?.message ?? "session capture failed"],
    };
  }
  return { status: input.capture.status, diagnostics: [] };
}

function failureMessageForDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createManifest(
  state: WorkflowRunState,
  present: { session: boolean },
): WorkflowRunManifest {
  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: state.runId,
    workflowName: state.workflowName,
    ...(state.runTitle !== undefined ? { runTitle: state.runTitle } : {}),
    ...(state.workflowSource !== undefined ? { workflowSource: state.workflowSource } : {}),
    ...(state.workflowSources !== undefined ? { workflowSources: state.workflowSources } : {}),
    ...(state.definitionDigest !== undefined ? { definitionDigest: state.definitionDigest } : {}),
    startedAt: state.startedAt,
    ...(state.finishedAt !== undefined ? { finishedAt: state.finishedAt } : {}),
    status: state.status,
    traceSchema: TRACE_EVENT_SCHEMA,
    paths: {
      workflow: WORKFLOW_SNAPSHOT_PATH,
      state: STATE_PATH,
      trace: TRACE_PATH,
      ...(present.session ? { session: SESSION_DIR } : {}),
      // Declare this before any payload can externalize a string. Live
      // session-event patches may reference a newly written artifact before
      // the next workflow state projection refreshes the manifest.
      artifacts: "artifacts",
    },
  };
}

export function createDefinitionSnapshot(workflow: WorkflowDefinition): WorkflowDefinitionSnapshot {
  const composition = compositionMetadata(workflow)?.snapshot;
  return {
    schema: DEFINITION_SNAPSHOT_SCHEMA,
    name: workflow.name,
    ...(workflow.contractId !== undefined ? { contractId: workflow.contractId } : {}),
    startAt: workflow.startAt,
    nodes: Object.fromEntries(
      Object.entries(workflow.nodes).map(([nodeId, node]) => [
        nodeId,
        snapshotNode(workflow, nodeId, node),
      ]),
    ),
    edges: structuredClone(workflow.edges),
    ...(composition !== undefined ? { composition: structuredClone(composition) } : {}),
  };
}

/**
 * Canonical SHA-256 digest of a workflow's definition snapshot.
 * Serializes the canonical JSON snapshot and returns sha256:<hex>.
 */
export function definitionSnapshotDigest(snapshot: WorkflowDefinitionSnapshot): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
}

export function definitionDigest(workflow: WorkflowDefinition): string {
  return definitionSnapshotDigest(createDefinitionSnapshot(workflow));
}

function snapshotNode(
  workflow: WorkflowDefinition,
  nodeId: string,
  node: WorkflowNodeDefinition,
): WorkflowNodeSnapshot {
  const composition = compositionMetadata(workflow);
  const entry = composition?.entries[nodeId];
  const exit = composition?.exits[nodeId];
  const scope = Object.values(composition?.scopes ?? {})
    .filter((candidate) => candidate.path !== "" && nodeId.startsWith(`${candidate.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const mountPath = entry?.mountPath ?? exit?.mountPath ?? scope?.path;
  const localNodeId =
    entry !== undefined
      ? entry.mountName
      : exit !== undefined
        ? exit.exitName
        : scope !== undefined
          ? nodeId.slice(scope.path.length + 1)
          : undefined;
  const common: WorkflowNodeSnapshot = {
    nodeType: node.nodeType,
    ...(mountPath !== undefined ? { mountPath: mountPath.split("/") } : {}),
    ...(localNodeId !== undefined ? { localNodeId } : {}),
    ...(entry !== undefined
      ? { includeTransition: "entry" as const }
      : exit !== undefined
        ? { includeTransition: "exit" as const }
        : {}),
    ...(typeof node.timeoutMs === "number" || node.timeoutMs === null
      ? { timeoutMs: node.timeoutMs }
      : {}),
    ...(node.statusDetail !== undefined ? { statusDetail: node.statusDetail } : {}),
  };
  if (node.nodeType === "agent" && node.expectedOutput !== undefined) {
    common.expectedOutput = node.expectedOutput;
  }
  if (node.nodeType === "agent" && node.toolPolicy !== undefined) {
    common.toolPolicy = node.toolPolicy;
  }
  if (node.nodeType === "notify") {
    common.summary = node.kind ?? "progress";
  }
  if (node.nodeType === "checkpoint" && node.summary !== undefined) {
    common.summary = node.summary;
  }
  if (node.nodeType === "checkpoint" && node.humanDecision !== undefined) {
    common.humanDecision = {
      audience:
        typeof node.humanDecision.audience === "string" ? node.humanDecision.audience : "<dynamic>",
      ...(typeof node.humanDecision.audience === "function" ? { dynamicAudience: true } : {}),
      choices: structuredClone(node.humanDecision.choices),
      ...(node.humanDecision.onTimeout !== undefined &&
      typeof node.humanDecision.onTimeout !== "function"
        ? { onTimeout: structuredClone(node.humanDecision.onTimeout) }
        : {}),
      ...(typeof node.humanDecision.onTimeout === "function" ? { dynamicTimeout: true } : {}),
    };
  }
  if (node.nodeType === "action") {
    common.actionExecution = "exec" in node ? "shell" : "function";
  }
  return common;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
}
