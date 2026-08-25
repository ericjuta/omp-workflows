import path from "node:path";
import type { LoadedRunBundle, WorkflowRunProjection } from "./store.js";

export type WorkflowRunListItem = {
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
  failingNode?: string;
  errorSummary?: string;
  errorCode?: string;
  waitingOn?: unknown;
  runTitle?: string;
  project?: string;
  parentRunId?: string;
  continuationRunId?: string;
  warnings?: string[];
};

export type ContinuationQueueFact = {
  runId: string;
  parentRunId: string | null;
  status?: string;
  startedAt?: string;
  workflowName?: string;
  input?: unknown;
  project?: string;
  errorSummary?: string;
  errorCode?: string;
};

type RunDiscoverySource = LoadedRunBundle | WorkflowRunProjection;

export function isLiveWorkflowStatus(status: string, paused?: boolean): boolean {
  if (paused === true) return true;
  return status === "running" || status === "waiting" || status === "queued";
}

export function workflowTaskFingerprint(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const raw =
    typeof record.task === "string"
      ? record.task
      : typeof record.problem === "string"
        ? record.problem
        : undefined;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized.length === 0) return null;
  return normalized.slice(0, 240);
}

function inputProjects(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  const record = input as Record<string, unknown>;
  return [record.repository, record.project, record.cwd].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
}

function projectMatches(projection: WorkflowRunProjection, target: string): boolean {
  const candidates = [
    projection.sessionBinding?.cwd,
    ...inputProjects(projection.input),
    projection.project,
  ];
  return candidates.some((candidate) => {
    if (candidate === undefined || candidate.trim().length === 0) return false;
    const resolved = path.resolve(candidate);
    return resolved === target || resolved.startsWith(`${target}${path.sep}`);
  });
}

function sourceProjection(source: RunDiscoverySource): WorkflowRunProjection {
  if (!("state" in source)) {
    return { ...source, warnings: [...source.warnings] };
  }
  const { state, sessionBinding, runDir } = source;
  const project = sessionBinding?.cwd ?? inputProjects(state.input)[0];
  const workflowSource = state.workflowSource;
  return {
    runDir,
    runId: state.runId,
    workflowName: state.workflowName,
    ...(workflowSource?.kind === "builtin"
      ? { workflowId: workflowSource.id, revision: workflowSource.revision }
      : {}),
    status: state.status,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    ...(state.paused !== undefined ? { paused: state.paused } : {}),
    ...(state.currentNode !== undefined ? { currentNode: state.currentNode } : {}),
    ...(state.status === "failed" && state.currentNode !== undefined
      ? { failedNodeId: state.currentNode }
      : {}),
    ...(state.error !== undefined ? { errorSummary: state.error.slice(0, 500) } : {}),
    ...(state.waitingOn !== undefined ? { waitingOn: state.waitingOn } : {}),
    ...(state.runTitle !== undefined ? { runTitle: state.runTitle } : {}),
    ...(state.parentRunId !== undefined ? { parentRunId: state.parentRunId } : {}),
    ...(project !== undefined ? { project } : {}),
    sessionBinding,
    input: state.input,
    warnings: [],
  };
}

function queueProjectionStatus(status: string | undefined): string {
  switch (status) {
    case "starting":
      return "queued";
    case "parked":
      return "waiting";
    case "done":
      return "completed";
    default:
      return status ?? "queued";
  }
}

/**
 * Collapse continuation chains into one in-memory family row. The returned
 * row identifies the latest continuation while retaining the waiting root id.
 * No run bundle is written or mutated.
 */
export function overlayContinuationFamilies(
  sources: RunDiscoverySource[],
  queueFacts: readonly ContinuationQueueFact[] = [],
): WorkflowRunProjection[] {
  const projections = sources.map(sourceProjection);
  const byId = new Map(projections.map((projection) => [projection.runId, projection]));

  for (const fact of queueFacts) {
    if (byId.has(fact.runId)) continue;
    const parent = fact.parentRunId === null ? undefined : byId.get(fact.parentRunId);
    const status = queueProjectionStatus(fact.status);
    const project = fact.project ?? parent?.project;
    const input = fact.input ?? parent?.input;
    const queued: WorkflowRunProjection = {
      runDir: "",
      runId: fact.runId,
      workflowName: fact.workflowName ?? parent?.workflowName ?? "unknown",
      ...(parent?.workflowId !== undefined ? { workflowId: parent.workflowId } : {}),
      ...(parent?.revision !== undefined ? { revision: parent.revision } : {}),
      status,
      effectiveStatus: status,
      startedAt: fact.startedAt ?? parent?.startedAt ?? "",
      ...(fact.parentRunId !== null ? { parentRunId: fact.parentRunId } : {}),
      ...(parent?.runTitle !== undefined ? { runTitle: parent.runTitle } : {}),
      ...(project !== undefined ? { project } : {}),
      ...(fact.errorSummary !== undefined ? { errorSummary: fact.errorSummary.slice(0, 500) } : {}),
      ...(fact.errorCode !== undefined ? { errorCode: fact.errorCode } : {}),
      ...(parent?.sessionBinding !== undefined ? { sessionBinding: parent.sessionBinding } : {}),
      ...(input !== undefined ? { input } : {}),
      warnings: parent === undefined ? [] : [...parent.warnings],
    };
    projections.push(queued);
    byId.set(queued.runId, queued);
  }

  const children = new Map<string, WorkflowRunProjection[]>();
  for (const projection of projections) {
    if (projection.parentRunId === undefined || !byId.has(projection.parentRunId)) continue;
    const siblings = children.get(projection.parentRunId) ?? [];
    siblings.push(projection);
    children.set(projection.parentRunId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort(
      (a, b) =>
        (b.startedAt || "").localeCompare(a.startedAt || "") || b.runId.localeCompare(a.runId),
    );
  }

  const roots = projections.filter(
    (projection) => projection.parentRunId === undefined || !byId.has(projection.parentRunId),
  );
  const consumed = new Set<string>();
  const families: WorkflowRunProjection[] = [];

  for (const root of roots) {
    let leaf = root;
    const familyIds = new Set<string>([root.runId]);
    const integrityWarnings: string[] = [];
    while (true) {
      const siblings = children.get(leaf.runId);
      const child = siblings?.[0];
      if (!child || familyIds.has(child.runId)) break;
      if (siblings.length > 1) {
        integrityWarnings.push(
          `multiple_continuation_children: parent=${leaf.runId}, selected=${child.runId}, children=${siblings
            .map((sibling) => sibling.runId)
            .join(",")}`.slice(0, 500),
        );
      }
      leaf = child;
      familyIds.add(child.runId);
    }
    for (const id of familyIds) consumed.add(id);

    if (leaf.runId === root.runId) {
      families.push({ ...root, warnings: [...root.warnings] });
      continue;
    }
    families.push({
      ...leaf,
      workflowName: root.workflowName === "unknown" ? leaf.workflowName : root.workflowName,
      ...(root.workflowId !== undefined ? { workflowId: root.workflowId } : {}),
      ...(root.revision !== undefined ? { revision: root.revision } : {}),
      effectiveStatus: leaf.effectiveStatus ?? leaf.status,
      parentRunId: root.runId,
      continuationRunId: leaf.runId,
      ...(root.runTitle !== undefined ? { runTitle: root.runTitle } : {}),
      ...(root.project !== undefined ? { project: root.project } : {}),
      ...(root.sessionBinding !== undefined ? { sessionBinding: root.sessionBinding } : {}),
      ...(root.input !== undefined ? { input: root.input } : {}),
      warnings: [...new Set([...integrityWarnings, ...root.warnings, ...leaf.warnings])].slice(
        0,
        8,
      ),
    });
  }

  for (const projection of projections) {
    if (!consumed.has(projection.runId)) {
      families.push({ ...projection, warnings: [...projection.warnings] });
    }
  }
  return families;
}

function summarizeProjection(projection: WorkflowRunProjection): WorkflowRunListItem {
  return {
    runId: projection.runId,
    workflowName: projection.workflowName,
    ...(projection.workflowId !== undefined ? { workflowId: projection.workflowId } : {}),
    ...(projection.revision !== undefined ? { revision: projection.revision } : {}),
    status: projection.effectiveStatus ?? projection.status,
    ...(projection.effectiveStatus !== undefined
      ? { effectiveStatus: projection.effectiveStatus }
      : {}),
    startedAt: projection.startedAt,
    ...(projection.updatedAt !== undefined ? { updatedAt: projection.updatedAt } : {}),
    ...(projection.durationMs !== undefined ? { durationMs: projection.durationMs } : {}),
    ...(projection.paused !== undefined ? { paused: projection.paused } : {}),
    ...(projection.pausedAgeMs !== undefined ? { pausedAgeMs: projection.pausedAgeMs } : {}),
    ...(projection.currentNode !== undefined ? { currentNode: projection.currentNode } : {}),
    ...(projection.failedNodeId !== undefined ? { failingNode: projection.failedNodeId } : {}),
    ...(projection.errorSummary !== undefined ? { errorSummary: projection.errorSummary } : {}),
    ...(projection.errorCode !== undefined ? { errorCode: projection.errorCode } : {}),
    ...(projection.waitingOn !== undefined ? { waitingOn: projection.waitingOn } : {}),
    ...(projection.runTitle !== undefined ? { runTitle: projection.runTitle } : {}),
    ...(projection.project !== undefined ? { project: projection.project } : {}),
    ...(projection.parentRunId !== undefined ? { parentRunId: projection.parentRunId } : {}),
    ...(projection.continuationRunId !== undefined
      ? { continuationRunId: projection.continuationRunId }
      : {}),
    ...(projection.warnings.length > 0 ? { warnings: [...projection.warnings] } : {}),
  };
}

export function summarizeRunBundle(bundle: LoadedRunBundle): WorkflowRunListItem {
  return summarizeProjection(sourceProjection(bundle));
}

export function selectRecentRuns(
  sources: RunDiscoverySource[],
  options?: { limit?: number; liveOnly?: boolean; project?: string },
  queueFacts: readonly ContinuationQueueFact[] = [],
): WorkflowRunListItem[] {
  let filtered = overlayContinuationFamilies(sources, queueFacts);

  if (options?.project !== undefined) {
    const targetProject = path.resolve(options.project);
    filtered = filtered.filter((projection) => projectMatches(projection, targetProject));
  }

  if (options?.liveOnly === true) {
    filtered = filtered.filter((projection) =>
      isLiveWorkflowStatus(projection.effectiveStatus ?? projection.status, projection.paused),
    );
  }

  filtered.sort((a, b) => {
    const timeA = Date.parse(a.startedAt) || 0;
    const timeB = Date.parse(b.startedAt) || 0;
    return timeB - timeA;
  });

  if (options?.limit !== undefined && options.limit >= 0) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered.map(summarizeProjection);
}

export function findMatchingLiveRuns(
  sources: RunDiscoverySource[],
  query: { workflowName: string; fingerprint: string | null },
  queueFacts: readonly ContinuationQueueFact[] = [],
): WorkflowRunListItem[] {
  if (query.fingerprint === null) return [];

  const matches = overlayContinuationFamilies(sources, queueFacts).filter((projection) => {
    if (projection.workflowName !== query.workflowName) return false;
    if (!isLiveWorkflowStatus(projection.effectiveStatus ?? projection.status, projection.paused)) {
      return false;
    }
    return workflowTaskFingerprint(projection.input) === query.fingerprint;
  });

  return matches.map(summarizeProjection);
}
