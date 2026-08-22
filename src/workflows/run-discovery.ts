import path from "node:path";
import type { LoadedRunBundle } from "./store.js";

export type WorkflowRunListItem = {
  runId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  paused?: boolean;
  currentNode?: string;
  waitingOn?: unknown;
  runTitle?: string;
  project?: string;
};

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

function inputRepository(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const repository = (input as Record<string, unknown>).repository;
  return typeof repository === "string" && repository.trim().length > 0 ? repository : undefined;
}

function resolvedProjectPath(value: string): string {
  return path.resolve(value);
}

function projectMatches(candidate: string | undefined, target: string): boolean {
  if (candidate === undefined || candidate.trim().length === 0) return false;
  const resolved = resolvedProjectPath(candidate);
  return resolved === target || resolved.startsWith(`${target}${path.sep}`);
}

export function summarizeRunBundle(bundle: LoadedRunBundle): WorkflowRunListItem {
  const { state, sessionBinding } = bundle;
  const project = sessionBinding?.cwd ?? inputRepository(state.input);
  return {
    runId: state.runId,
    workflowName: state.workflowName,
    status: state.status,
    startedAt: state.startedAt,
    ...(state.paused !== undefined ? { paused: state.paused } : {}),
    ...(state.currentNode !== undefined ? { currentNode: state.currentNode } : {}),
    ...(state.waitingOn !== undefined ? { waitingOn: state.waitingOn } : {}),
    ...(state.runTitle !== undefined ? { runTitle: state.runTitle } : {}),
    ...(project !== undefined ? { project } : {}),
  };
}

export function selectRecentRuns(
  bundles: LoadedRunBundle[],
  options?: { limit?: number; liveOnly?: boolean; project?: string },
): WorkflowRunListItem[] {
  let filtered = [...bundles];

  if (options?.project !== undefined) {
    const targetProject = resolvedProjectPath(options.project);
    filtered = filtered.filter((bundle) => {
      return (
        projectMatches(bundle.sessionBinding?.cwd, targetProject) ||
        projectMatches(inputRepository(bundle.state.input), targetProject)
      );
    });
  }

  if (options?.liveOnly === true) {
    filtered = filtered.filter((bundle) =>
      isLiveWorkflowStatus(bundle.state.status, bundle.state.paused),
    );
  }

  filtered.sort((a, b) => {
    const timeA = Date.parse(a.state.startedAt) || 0;
    const timeB = Date.parse(b.state.startedAt) || 0;
    return timeB - timeA;
  });

  if (options?.limit !== undefined && options.limit >= 0) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered.map(summarizeRunBundle);
}

export function findMatchingLiveRuns(
  bundles: LoadedRunBundle[],
  query: { workflowName: string; fingerprint: string | null },
): WorkflowRunListItem[] {
  if (query.fingerprint === null) return [];

  const matches = bundles.filter((bundle) => {
    if (bundle.state.workflowName !== query.workflowName) return false;
    if (!isLiveWorkflowStatus(bundle.state.status, bundle.state.paused)) return false;
    const fp = workflowTaskFingerprint(bundle.state.input);
    return fp === query.fingerprint;
  });

  return matches.map(summarizeRunBundle);
}
