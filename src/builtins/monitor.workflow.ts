import path from "node:path";
import {
  action,
  agent,
  compute,
  defineWorkflow,
  includeWorkflow,
  includedResult,
  notify,
} from "../workflows/definition.js";
import {
  estimateProgress,
  formatProgressReport,
  type ProgressSample,
  type ProgressTrackState,
} from "../workflows/progress.js";
import type {
  WorkflowDefinition,
  WorkflowNodeContext,
  WorkflowProgressData,
} from "../workflows/types.js";
import { validateProgressData } from "../workflows/updates.js";
import autoimplementWorkflow, { type AutoimplementInput } from "./autoimplement.workflow.js";
import {
  parsePlanApprovalPolicy,
  type PlanApprovalPolicy,
  type ResolvedPlanApprovalPolicy,
} from "./plan-approval.workflow.js";
import planChangeWorkflow, { type NormalizedPlanChangeInput } from "./plan-change.workflow.js";

const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 24 * 60;
const DEFAULT_INTERVAL_MINUTES = 30;
const MIN_CHECK_TIMEOUT_MINUTES = 5;
const MAX_CHECK_TIMEOUT_MINUTES = 24 * 60;
const DEFAULT_MIN_CHECK_TIMEOUT_MINUTES = 60;
const DEFAULT_MAX_CHECKS = 1_000;
const MAX_CHECKS = 1_000;
const MAX_TRACKS = 256;
const MAX_OBSERVATION_CHARS = 8_000;
const MAX_REPORT_CHARS = 4_000;
const MAX_REASON_CHARS = 2_000;
const MAX_ACTION_TEXT_CHARS = 8_000;
const MAX_ID_CHARS = 256;
const MAX_CONSECUTIVE_CHECK_TIMEOUTS = 3;

export type MonitorRepairPolicy = {
  authorized: true;
  scope?: string;
  constraints?: string[];
  repository: string;
  baseBranch?: string;
  merge?: boolean;
  approval?: PlanApprovalPolicy;
};

export type MonitorInput = {
  task: string;
  everyMinutes?: number;
  stopWhen?: string;
  maxChecks?: number;
  checkTimeoutMinutes?: number;
  repair?: MonitorRepairPolicy;
};

type MonitorConfig = {
  task: string;
  everyMinutes: number;
  stopWhen: string;
  maxChecks: number;
  checkTimeoutMinutes: number;
  repair?: MonitorRepairPolicy;
};
type MonitorRoute = "wait" | "act" | "stop";
type MonitorGoalState = "complete" | "incomplete" | "blocked";
type MonitorWorkState = "running" | "waiting" | "idle" | "failed" | "stopped" | "unknown";
type MonitorActionKind = "advance" | "recover" | "repair";
type MonitorTrack = { key: string; data: WorkflowProgressData };
type MonitorAuthority = {
  status: "authorized" | "outside";
  basis: string;
  allowedMutations: string[];
  forbiddenMutations: string[];
  costLimit: string;
  providerRuntime: string;
  requiredChecks: string[];
  stopConditions: string[];
  allowedRecoveryActions: string[];
  repository?: string;
  baseBranch?: string;
  merge: boolean;
  repairApproval: ResolvedPlanApprovalPolicy;
};
type MonitorCostSafety = {
  paidAction: boolean;
  status: "not-applicable" | "within-limit" | "missing" | "exceeded";
  evidence: string;
};
type MonitorDefectSafety = {
  sharedCodeOrDataDefect: boolean;
  paidWorkers: "not-applicable" | "stopped" | "running";
  evidence: string;
};
type MonitorActionRequest = {
  kind: MonitorActionKind;
  incomplete: string;
  evidence: unknown;
  nextAction: string;
  authority: MonitorAuthority;
  cost: MonitorCostSafety;
  defect: MonitorDefectSafety;
  verification: string;
  failureId: string;
  targetStateId: string;
};
type MonitorCheck = {
  route: MonitorRoute;
  goalState: MonitorGoalState;
  workState: MonitorWorkState;
  observation: string;
  report: string;
  targetStateId: string;
  authorizedActions: string[];
  progress?: { tracks: MonitorTrack[] };
  action?: MonitorActionRequest;
  reason: string;
};
type MonitorActionResult = {
  status: "succeeded" | "failed" | "blocked";
  summary: string;
  evidence: unknown;
  verification: string;
  failureId: string;
  targetStateId: string;
};
type MonitorEstimate = { tracks: ProgressTrackState[] };
type MonitorCheckTimeout = {
  route: "retry" | "stop";
  consecutiveTimeouts: number;
  reason: string;
};
type MonitorCheckFailure = { route: "stop"; reason: string };
type RecordedAction = {
  status: "succeeded" | "failed" | "blocked";
  summary: string;
  evidence: unknown;
  verification: string;
  failureId: string;
  targetStateId: string;
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new Error(`${label} field ${unexpected} is not supported`);
}

function requireBoundedString(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} must not be empty`);
  if (trimmed.length > maxChars) throw new Error(`${label} must be at most ${maxChars} characters`);
  return trimmed;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((item, index) =>
    requireBoundedString(item, `${label}[${index}]`, MAX_ACTION_TEXT_CHARS),
  );
}

async function waitForUpdateSlot(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("monitor progress publication was cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 55);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForMonitorInterval(
  deadlineMs: number,
  signal: AbortSignal,
): Promise<{ interrupted: boolean }> {
  try {
    if (signal.aborted) {
      throw signal.reason ?? new Error("monitor interval was cancelled");
    }
    if (!Number.isFinite(deadlineMs)) {
      return { interrupted: true };
    }
    const remaining = Math.max(0, deadlineMs - Date.now());
    if (remaining === 0) {
      return { interrupted: false };
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("monitor interval was cancelled"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, remaining);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    return { interrupted: false };
  } catch (error) {
    if (signal.aborted) throw error;
    return { interrupted: true };
  }
}

function monitorIntervalDeadline(outputs: Record<string, unknown>): number {
  const scheduled = outputs.schedule;
  if (
    scheduled !== null &&
    typeof scheduled === "object" &&
    !Array.isArray(scheduled) &&
    "nextCheckAt" in scheduled &&
    typeof scheduled.nextCheckAt === "string"
  ) {
    return Date.parse(scheduled.nextCheckAt);
  }
  return Number.NaN;
}

export function prepareMonitorInput(input: unknown): MonitorConfig {
  const value = requireRecord(input, "monitor input") as Partial<MonitorInput>;
  const allowed = new Set([
    "task",
    "everyMinutes",
    "stopWhen",
    "maxChecks",
    "checkTimeoutMinutes",
    "repair",
  ]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`monitor input field ${field} is not supported`);
  }
  const task = requireBoundedString(value.task, "task", 8_000);
  const everyMinutes = value.everyMinutes ?? DEFAULT_INTERVAL_MINUTES;
  if (
    !Number.isInteger(everyMinutes) ||
    everyMinutes < MIN_INTERVAL_MINUTES ||
    everyMinutes > MAX_INTERVAL_MINUTES
  ) {
    throw new Error(
      `everyMinutes must be an integer from ${MIN_INTERVAL_MINUTES} through ${MAX_INTERVAL_MINUTES}`,
    );
  }
  const maxChecks = value.maxChecks ?? DEFAULT_MAX_CHECKS;
  if (!Number.isInteger(maxChecks) || maxChecks <= 0 || maxChecks > MAX_CHECKS) {
    throw new Error(`maxChecks must be an integer from 1 through ${MAX_CHECKS}`);
  }
  const checkTimeoutMinutes =
    value.checkTimeoutMinutes ?? Math.max(DEFAULT_MIN_CHECK_TIMEOUT_MINUTES, everyMinutes);
  if (
    !Number.isInteger(checkTimeoutMinutes) ||
    checkTimeoutMinutes < MIN_CHECK_TIMEOUT_MINUTES ||
    checkTimeoutMinutes > MAX_CHECK_TIMEOUT_MINUTES
  ) {
    throw new Error(
      `checkTimeoutMinutes must be an integer from ${MIN_CHECK_TIMEOUT_MINUTES} through ${MAX_CHECK_TIMEOUT_MINUTES}`,
    );
  }
  let repair: MonitorRepairPolicy | undefined;
  if (value.repair !== undefined) {
    const raw = requireRecord(value.repair, "repair policy");
    if (raw.authorized !== true) throw new Error("repair policy must set authorized to true");
    if (
      raw.constraints !== undefined &&
      (!Array.isArray(raw.constraints) || raw.constraints.some((item) => typeof item !== "string"))
    ) {
      throw new Error("repair constraints must be an array of strings");
    }
    if (raw.merge !== undefined && typeof raw.merge !== "boolean") {
      throw new Error("repair merge must be a boolean");
    }
    const repository = requireBoundedString(raw.repository, "repair repository", 4_000);
    if (!path.isAbsolute(repository)) {
      throw new Error("repair repository must be an absolute path");
    }
    const approval = parsePlanApprovalPolicy(raw.approval);
    repair = {
      authorized: true,
      ...(raw.scope !== undefined
        ? { scope: requireBoundedString(raw.scope, "repair scope", 4_000) }
        : {}),
      ...(raw.constraints !== undefined ? { constraints: [...raw.constraints] as string[] } : {}),
      repository: path.resolve(repository),
      ...(raw.baseBranch !== undefined
        ? { baseBranch: requireBoundedString(raw.baseBranch, "repair base branch", 256) }
        : {}),
      ...(raw.merge !== undefined ? { merge: raw.merge !== false } : {}),
      approval,
    };
  }
  return {
    task,
    everyMinutes,
    stopWhen:
      value.stopWhen === undefined
        ? "Stop only when the user explicitly asks to stop."
        : requireBoundedString(value.stopWhen, "stopWhen", 4_000),
    maxChecks,
    checkTimeoutMinutes,
    ...(repair !== undefined ? { repair } : {}),
  };
}

function configFrom(outputs: Record<string, unknown>): MonitorConfig {
  return outputs.prepare as MonitorConfig;
}

function completedChecks(context: WorkflowNodeContext): number {
  return context.state.steps.filter((step) => step.nodeId === "check" && step.outcome === "ok")
    .length;
}

function parseAuthority(input: unknown): MonitorAuthority {
  const value = requireRecord(input, "action authority");
  requireExactKeys(
    value,
    [
      "status",
      "basis",
      "allowedMutations",
      "forbiddenMutations",
      "costLimit",
      "providerRuntime",
      "requiredChecks",
      "stopConditions",
      "allowedRecoveryActions",
      "repository",
      "baseBranch",
      "merge",
      "repairApproval",
    ],
    "action authority",
  );
  if (value.status !== "authorized" && value.status !== "outside") {
    throw new Error("action authority status must be authorized or outside");
  }
  if (typeof value.merge !== "boolean") throw new Error("action authority merge must be boolean");
  const approval =
    value.repairApproval === undefined
      ? undefined
      : requireRecord(value.repairApproval, "repair approval");
  return {
    status: value.status,
    basis: requireBoundedString(value.basis, "action authority basis", MAX_ACTION_TEXT_CHARS),
    allowedMutations: requireStringArray(
      value.allowedMutations,
      "action authority allowedMutations",
    ),
    forbiddenMutations: requireStringArray(
      value.forbiddenMutations,
      "action authority forbiddenMutations",
    ),
    costLimit: requireBoundedString(
      value.costLimit,
      "action authority costLimit",
      MAX_ACTION_TEXT_CHARS,
    ),
    providerRuntime: requireBoundedString(
      value.providerRuntime,
      "action authority providerRuntime",
      MAX_ACTION_TEXT_CHARS,
    ),
    requiredChecks: requireStringArray(value.requiredChecks, "action authority requiredChecks"),
    stopConditions: requireStringArray(value.stopConditions, "action authority stopConditions"),
    allowedRecoveryActions: requireStringArray(
      value.allowedRecoveryActions,
      "action authority allowedRecoveryActions",
    ),
    ...(value.repository !== undefined
      ? {
          repository: requireBoundedString(value.repository, "action authority repository", 4_000),
        }
      : {}),
    ...(value.baseBranch !== undefined
      ? {
          baseBranch: requireBoundedString(value.baseBranch, "action authority baseBranch", 256),
        }
      : {}),
    merge: value.merge,
    repairApproval: parsePlanApprovalPolicy(approval),
  };
}

function parseCostSafety(input: unknown): MonitorCostSafety {
  const value = requireRecord(input, "action cost");
  requireExactKeys(value, ["paidAction", "status", "evidence"], "action cost");
  if (typeof value.paidAction !== "boolean") {
    throw new Error("action cost paidAction must be boolean");
  }
  if (
    value.status !== "not-applicable" &&
    value.status !== "within-limit" &&
    value.status !== "missing" &&
    value.status !== "exceeded"
  ) {
    throw new Error("action cost status is invalid");
  }
  return {
    paidAction: value.paidAction,
    status: value.status,
    evidence: requireBoundedString(value.evidence, "action cost evidence", MAX_ACTION_TEXT_CHARS),
  };
}

function parseDefectSafety(input: unknown): MonitorDefectSafety {
  const value = requireRecord(input, "action defect");
  requireExactKeys(value, ["sharedCodeOrDataDefect", "paidWorkers", "evidence"], "action defect");
  if (typeof value.sharedCodeOrDataDefect !== "boolean") {
    throw new Error("action defect sharedCodeOrDataDefect must be boolean");
  }
  if (
    value.paidWorkers !== "not-applicable" &&
    value.paidWorkers !== "stopped" &&
    value.paidWorkers !== "running"
  ) {
    throw new Error("action defect paidWorkers is invalid");
  }
  return {
    sharedCodeOrDataDefect: value.sharedCodeOrDataDefect,
    paidWorkers: value.paidWorkers,
    evidence: requireBoundedString(value.evidence, "action defect evidence", MAX_ACTION_TEXT_CHARS),
  };
}

function parseActionRequest(input: unknown): MonitorActionRequest {
  const value = requireRecord(input, "monitor action request");
  requireExactKeys(
    value,
    [
      "kind",
      "incomplete",
      "evidence",
      "nextAction",
      "authority",
      "cost",
      "defect",
      "verification",
      "failureId",
      "targetStateId",
    ],
    "monitor action request",
  );
  if (value.kind !== "advance" && value.kind !== "recover" && value.kind !== "repair") {
    throw new Error("monitor action kind must be advance, recover, or repair");
  }
  const request: MonitorActionRequest = {
    kind: value.kind,
    incomplete: requireBoundedString(
      value.incomplete,
      "monitor action incomplete work",
      MAX_ACTION_TEXT_CHARS,
    ),
    evidence: value.evidence ?? null,
    nextAction: requireBoundedString(
      value.nextAction,
      "monitor action nextAction",
      MAX_ACTION_TEXT_CHARS,
    ),
    authority: parseAuthority(value.authority),
    cost: parseCostSafety(value.cost),
    defect: parseDefectSafety(value.defect),
    verification: requireBoundedString(
      value.verification,
      "monitor action verification",
      MAX_ACTION_TEXT_CHARS,
    ),
    failureId: requireBoundedString(value.failureId, "monitor action failureId", MAX_ID_CHARS),
    targetStateId: requireBoundedString(
      value.targetStateId,
      "monitor action targetStateId",
      MAX_ID_CHARS,
    ),
  };
  if (request.authority.status !== "authorized") {
    throw new Error("unauthorized act cannot mutate");
  }
  if (request.authority.allowedMutations.length === 0) {
    throw new Error("route act requires at least one allowed mutation");
  }
  if (
    request.cost.paidAction &&
    (request.cost.status === "missing" || request.cost.status === "exceeded")
  ) {
    throw new Error("route act cannot launch paid work without verified remaining authority");
  }
  if (request.cost.paidAction && request.cost.status !== "within-limit") {
    throw new Error("paid route act requires cost status within-limit");
  }
  if (!request.cost.paidAction && request.cost.status !== "not-applicable") {
    throw new Error("unpaid route act requires cost status not-applicable");
  }
  if (
    request.kind === "repair" &&
    request.defect.sharedCodeOrDataDefect &&
    request.defect.paidWorkers === "running"
  ) {
    throw new Error("paid workers must stop before a shared code or data repair");
  }
  return request;
}

export function validateMonitorCheck(output: unknown, repairAuthorized = false): MonitorCheck {
  const value = requireRecord(output, "monitor check output");
  requireExactKeys(
    value,
    [
      "route",
      "goalState",
      "workState",
      "observation",
      "report",
      "targetStateId",
      "authorizedActions",
      "progress",
      "action",
      "reason",
    ],
    "monitor check",
  );
  if (value.route !== "wait" && value.route !== "act" && value.route !== "stop") {
    throw new Error("route must be wait, act, or stop");
  }
  if (
    value.goalState !== "complete" &&
    value.goalState !== "incomplete" &&
    value.goalState !== "blocked"
  ) {
    throw new Error("goalState must be complete, incomplete, or blocked");
  }
  if (
    value.workState !== "running" &&
    value.workState !== "waiting" &&
    value.workState !== "idle" &&
    value.workState !== "failed" &&
    value.workState !== "stopped" &&
    value.workState !== "unknown"
  ) {
    throw new Error("workState is invalid");
  }
  const check: MonitorCheck = {
    route: value.route,
    goalState: value.goalState,
    workState: value.workState,
    observation: requireBoundedString(value.observation, "observation", MAX_OBSERVATION_CHARS),
    report: requireBoundedString(value.report, "report", MAX_REPORT_CHARS),
    targetStateId: requireBoundedString(value.targetStateId, "targetStateId", MAX_ID_CHARS),
    authorizedActions: requireStringArray(value.authorizedActions, "authorizedActions"),
    reason: requireBoundedString(value.reason, "reason", MAX_REASON_CHARS),
  };
  if (value.progress !== undefined) check.progress = validateMonitorProgress(value.progress);
  if (value.action !== undefined) check.action = parseActionRequest(value.action);
  if (check.route === "act" && check.action === undefined) {
    throw new Error("route act requires action details");
  }
  if (check.action !== undefined && check.action.targetStateId !== check.targetStateId) {
    throw new Error("monitor action targetStateId must match the observed targetStateId");
  }
  if (check.route !== "act" && check.action !== undefined) {
    throw new Error("action details are only valid for route act");
  }
  if (check.goalState === "complete" && check.route !== "stop") {
    throw new Error("goalState complete requires route stop");
  }
  if (check.goalState === "blocked" && check.route !== "stop") {
    throw new Error("goalState blocked requires route stop");
  }
  if (check.route === "act" && check.goalState !== "incomplete") {
    throw new Error("route act requires goalState incomplete");
  }
  if (
    check.route === "act" &&
    check.workState !== "idle" &&
    check.workState !== "failed" &&
    check.workState !== "stopped"
  ) {
    throw new Error("route act requires idle, failed, or stopped work");
  }
  if (check.route === "wait" && check.goalState !== "incomplete") {
    throw new Error("route wait requires goalState incomplete");
  }
  if (check.route === "wait" && check.workState !== "running" && check.workState !== "waiting") {
    throw new Error("route wait requires running work or an external wait");
  }
  if (!repairAuthorized && check.action?.kind === "repair") {
    throw new Error("monitor repair requires explicit monitor repair authorization");
  }
  return check;
}

function validateMonitorProgress(input: unknown): { tracks: MonitorTrack[] } {
  const value = requireRecord(input, "progress");
  requireExactKeys(value, ["tracks"], "progress");
  if (!Array.isArray(value.tracks) || value.tracks.length < 1 || value.tracks.length > MAX_TRACKS) {
    throw new Error(`progress.tracks must contain 1 through ${MAX_TRACKS} entries`);
  }
  const keys = new Set<string>();
  const tracks = value.tracks.map((raw, index) => {
    const track = requireRecord(raw, `progress.tracks[${index}]`);
    requireExactKeys(track, ["key", "data"], `progress.tracks[${index}]`);
    const key = requireBoundedString(track.key, `progress.tracks[${index}].key`, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(key)) {
      throw new Error(`progress.tracks[${index}].key is invalid`);
    }
    if (keys.has(key)) throw new Error(`progress track key ${key} is duplicated`);
    keys.add(key);
    return {
      key,
      data: validateProgressData(requireRecord(track.data, `progress.tracks[${index}].data`)),
    };
  });
  return { tracks };
}

function estimateTracks(outputs: Record<string, unknown>): MonitorEstimate {
  const check = outputs.check as MonitorCheck;
  if (check.progress === undefined) return { tracks: [] };
  const previous = outputs.estimate as MonitorEstimate | undefined;
  const previousByKey = new Map((previous?.tracks ?? []).map((track) => [track.key, track]));
  const at = new Date().toISOString();
  return {
    tracks: check.progress.tracks.map((track) => {
      const samples: ProgressSample[] = [
        ...(previousByKey.get(track.key)?.samples ?? []),
        { at, data: track.data },
      ].slice(-9);
      return { key: track.key, samples, estimate: estimateProgress(track.key, samples) };
    }),
  };
}

function currentCheck(outputs: Record<string, unknown>): MonitorCheck {
  return outputs.check as MonitorCheck;
}

function actionFrom(outputs: Record<string, unknown>): MonitorActionRequest {
  const request = currentCheck(outputs).action;
  if (request === undefined) throw new Error("monitor action details are missing");
  return request;
}

function repeatedRepairWithoutProgress(context: WorkflowNodeContext): boolean {
  const current = context.outputs.check as MonitorCheck;
  const action = current.action;
  if (action?.kind !== "repair") return false;
  const steps = context.state.steps;
  const currentCheckIndex = steps.findLastIndex((step) => step.nodeId === "check");
  for (let index = currentCheckIndex - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.nodeId !== "check") continue;
    const prior = step.output as MonitorCheck;
    if (
      prior.action?.kind !== "repair" ||
      prior.action.failureId !== action.failureId ||
      prior.action.targetStateId !== action.targetStateId
    ) {
      continue;
    }
    return steps
      .slice(index + 1, currentCheckIndex)
      .some((candidate) => candidate.nodeId === "implementation");
  }
  return false;
}

function currentRepairPlan(outputs: Record<string, unknown>): {
  plan: unknown;
  planDigest: string;
  documents: string[];
} {
  const result = includedResult(planChangeWorkflow, outputs.planChange);
  if (result.exit !== "ready") throw new Error("monitor plan change did not return a ready plan");
  return {
    plan: result.output.plan,
    planDigest: result.output.planDigest,
    documents: result.output.documents,
  };
}

function repairBlockedReason(outputs: Record<string, unknown>): string {
  const guard = outputs.repairGuard as { reason?: string; route?: string } | undefined;
  if (guard?.route === "blocked" && guard.reason !== undefined) return guard.reason;
  const planChange = outputs.planChange as
    | { exit?: string; output?: { reason?: string } }
    | undefined;
  const implementation = outputs.implementation as
    | { exit?: string; output?: { reason?: string } }
    | undefined;
  return (
    implementation?.output?.reason ??
    planChange?.output?.reason ??
    "The repair did not produce new verified progress."
  );
}

function recordedActionFromStep(
  step: WorkflowNodeContext["state"]["steps"][number],
): RecordedAction | undefined {
  if (step.outcome !== "ok") return undefined;
  if (step.nodeId === "act") {
    const result = step.output as MonitorActionResult;
    return {
      status: result.status,
      summary: result.summary,
      evidence: result.evidence,
      verification: result.verification,
      failureId: result.failureId,
      targetStateId: result.targetStateId,
    };
  }
  return undefined;
}

function latestRecordedAction(context: WorkflowNodeContext): RecordedAction | undefined {
  for (let index = context.state.steps.length - 1; index >= 0; index -= 1) {
    const step = context.state.steps[index];
    if (step === undefined) continue;
    const recorded = recordedActionFromStep(step);
    if (recorded !== undefined) return recorded;
  }
  return undefined;
}

function reportMessage(context: WorkflowNodeContext): string {
  const check = context.outputs.check as MonitorCheck;
  const estimate = context.outputs.estimate as MonitorEstimate;
  const config = configFrom(context.outputs);
  const suffix: string[] = [`Goal: ${check.goalState}`, `Work: ${check.workState}`];
  if (estimate.tracks.length > 0) {
    suffix.push(
      formatProgressReport(
        estimate.tracks.map((track) => track.estimate),
        check.route === "wait" ? config.everyMinutes : undefined,
        new Date(),
        2_000,
      ),
    );
  }
  const lastAction = latestRecordedAction(context);
  if (lastAction !== undefined) suffix.push(`Last action: ${lastAction.summary}`);
  if (check.action !== undefined && completedChecks(context) < config.maxChecks) {
    suffix.push(`Next action: ${check.action.nextAction}`);
  }
  if (check.route === "wait" && completedChecks(context) >= config.maxChecks) {
    suffix.push(`Reached the ${config.maxChecks}-check safety limit.`);
  }
  const suffixText = suffix.filter(Boolean).join("\n");
  const reportBudget = Math.max(1, MAX_REPORT_CHARS - suffixText.length - 1);
  const report =
    check.report.length <= reportBudget
      ? check.report
      : `${check.report.slice(0, Math.max(0, reportBudget - 1))}…`;
  return `${report}\n${suffixText}`;
}

function previousActionPrompt(context: WorkflowNodeContext): string {
  const actionRecord = latestRecordedAction(context);
  return actionRecord === undefined
    ? "There is no previous completed action."
    : `Previous action result: ${JSON.stringify(actionRecord)}`;
}

export function validateMonitorActionResult(
  output: unknown,
  expected: Pick<MonitorActionRequest, "failureId" | "targetStateId">,
): MonitorActionResult {
  const value = requireRecord(output, "monitor action result");
  requireExactKeys(
    value,
    ["status", "summary", "evidence", "verification", "failureId", "targetStateId"],
    "monitor action result",
  );
  if (value.status !== "succeeded" && value.status !== "failed" && value.status !== "blocked") {
    throw new Error("monitor action result status must be succeeded, failed, or blocked");
  }
  const result: MonitorActionResult = {
    status: value.status,
    summary: requireBoundedString(value.summary, "monitor action result summary", MAX_REPORT_CHARS),
    evidence: value.evidence ?? null,
    verification: requireBoundedString(
      value.verification,
      "monitor action result verification",
      MAX_ACTION_TEXT_CHARS,
    ),
    failureId: requireBoundedString(
      value.failureId,
      "monitor action result failureId",
      MAX_ID_CHARS,
    ),
    targetStateId: requireBoundedString(
      value.targetStateId,
      "monitor action result targetStateId",
      MAX_ID_CHARS,
    ),
  };
  if (result.failureId !== expected.failureId || result.targetStateId !== expected.targetStateId) {
    throw new Error(
      "monitor action result must preserve the requested failure and target-state IDs",
    );
  }
  return result;
}

const monitorWorkflow: WorkflowDefinition = defineWorkflow({
  source: import.meta.url,
  contractId: "pi-workflows.monitor.v1",
  name: "monitor",
  input: prepareMonitorInput,
  title: ({ input }) => {
    try {
      return `monitor: ${prepareMonitorInput(input).task.slice(0, 80)}`;
    } catch {
      return "monitor";
    }
  },
  startAt: "prepare",
  maxSteps: 200_000,
  includes: {
    planChange: includeWorkflow(planChangeWorkflow, {
      input: ({ outputs }): NormalizedPlanChangeInput => {
        const config = configFrom(outputs);
        const request = actionFrom(outputs);
        if (request.kind !== "repair") throw new Error("monitor repair details are missing");
        const prior = outputs.planChange as
          | { exit?: string; output?: { plan?: unknown } }
          | undefined;
        return {
          task: request.nextAction,
          ...(config.repair?.scope !== undefined ? { scope: config.repair.scope } : {}),
          ...(config.repair?.constraints !== undefined
            ? { constraints: config.repair.constraints }
            : {}),
          ...(config.repair?.repository !== undefined
            ? { repository: config.repair.repository }
            : {}),
          ...(prior?.exit === "ready" && prior.output?.plan !== undefined
            ? { previousPlan: prior.output.plan }
            : {}),
          newEvidence: request.evidence,
          approval: parsePlanApprovalPolicy(config.repair?.approval),
        };
      },
    }),
    implementation: includeWorkflow({
      workflow: "autoimplement",
      contract: autoimplementWorkflow,
      input: ({ outputs }) => {
        const config = configFrom(outputs);
        const request = actionFrom(outputs);
        const documented = currentRepairPlan(outputs);
        if (request.kind !== "repair") throw new Error("monitor repair details are missing");
        if (config.repair === undefined) throw new Error("monitor repair policy is missing");
        if (config.repair.repository === undefined) {
          throw new Error("monitor repair repository is required");
        }
        const implementationInput: AutoimplementInput = {
          task: request.nextAction,
          plan: documented.plan,
          documentation: {
            status: "current",
            planDigest: documented.planDigest,
            documents: documented.documents,
          },
          ...(config.repair?.scope !== undefined ? { scope: config.repair.scope } : {}),
          ...(config.repair?.constraints !== undefined
            ? { constraints: config.repair.constraints }
            : {}),
          repository: config.repair.repository,
          ...(config.repair?.baseBranch !== undefined
            ? { baseBranch: config.repair.baseBranch }
            : {}),
          approval: parsePlanApprovalPolicy(config.repair?.approval),
          merge: config.repair?.merge === true,
        };
        return implementationInput;
      },
    }),
  },
  nodes: {
    prepare: compute({ run: ({ input }) => prepareMonitorInput(input) }),
    check: agent({
      statusDetail: "checking monitored target",
      toolPolicy: "observation-only",
      timeoutMs: ({ outputs }) => configFrom(outputs).checkTimeoutMinutes * 60_000,
      prompt: (context) => {
        const config = configFrom(context.outputs);
        const previous = context.state.steps
          .slice()
          .reverse()
          .find((step) => step.nodeId === "check" && step.outcome === "ok")?.output as
          | MonitorCheck
          | undefined;
        const priorEstimate = context.outputs.estimate as MonitorEstimate | undefined;
        return [
          `Perform monitoring check ${completedChecks(context) + 1} of at most ${config.maxChecks}.`,
          `Task: ${config.task}`,
          `Stop when: ${config.stopWhen}`,
          previous === undefined
            ? "There is no previous observation."
            : `Previous accepted observation: ${previous.observation}`,
          previousActionPrompt(context),
          priorEstimate?.tracks.length
            ? `Previous progress: ${formatProgressReport(priorEstimate.tracks.map((track) => track.estimate))}`
            : "There is no previous measured progress.",
          "This check itself is observation-only. Do not edit files, change target state, invoke mutating commands, or perform a repair.",
          "Choose route wait, act, or stop. Record goalState complete, incomplete, or blocked and the target workState separately. List authorizedActions already granted by the user. Goal complete requires route stop.",
          "Choose wait only when useful target work is moving or an external event must finish. Choose act only when the goal is incomplete, work is idle, failed, or stopped, and one safe action is fully authorized. Choose stop when the goal is complete or safe continuation is blocked.",
          config.repair === undefined
            ? "This monitor has no repair authorization. Route act may request kind advance or recover when existing task authority covers that mutation. action.kind repair is forbidden."
            : "Repair is authorized only through the existing repair workflow. When a concrete in-scope defect is observed, request route act with action.kind repair; do not perform the mutation during this check. Protected model, benchmark, credential, hardware, spending, and scope decisions remain forbidden.",
          "For act, describe one exact action. Use advance for normal next work, recover for an operational restart or resume, and repair only for a code or configuration defect. A normal start, resume, or restart must not become repair. Unauthorized act cannot mutate.",
          "Use available read-only tools to inspect the current source of truth.",
          "You are the regular Pi model running this check and the observation adapter. When useful measurable facts appear during the check, publish them with workflow action update. Include the latest tracks in the final submission. Do not require the monitored target to implement a Pi-specific progress API, file, store, schema, or command.",
          "Every accepted check must include a concise user-facing report. Add progress tracks only when the target provides measurable facts. Submit observed counts and target-provided finish times; do not invent rates or an ETA.",
        ].join("\n\n");
      },
      expectedOutput:
        '{ "route": "wait" | "act" | "stop", "goalState": "complete" | "incomplete" | "blocked", "workState": "running" | "waiting" | "idle" | "failed" | "stopped" | "unknown", "observation": "current factual state", "report": "concise status update", "targetStateId": "stable observed target-state ID", "authorizedActions": ["safe action already authorized by the user"], "progress": { "tracks": [{ "key": "stable-key", "data": { "schema": "pi-workflows.progress.v1", "status": "running", "completed": 1, "total": 2, "unit": "items" } }] } (optional), "action": { "kind": "advance" | "recover" | "repair", "incomplete": "what remains", "evidence": {}, "nextAction": "one exact action", "authority": { "status": "authorized", "basis": "existing authority", "allowedMutations": ["allowed file, system, or resource"], "forbiddenMutations": [], "costLimit": "recorded limit or not applicable", "providerRuntime": "recorded contract or not applicable", "requiredChecks": [], "stopConditions": [], "allowedRecoveryActions": [], "repository": "optional absolute path", "baseBranch": "optional branch", "merge": false, "repairApproval": { "mode": "auto" | "required" | "skip" } }, "cost": { "paidAction": false, "status": "not-applicable" | "within-limit", "evidence": "cost evidence" }, "defect": { "sharedCodeOrDataDefect": false, "paidWorkers": "not-applicable" | "stopped" | "running", "evidence": "worker evidence" }, "verification": "how to prove success", "failureId": "stable failure ID", "targetStateId": "stable target-state ID" } (required only for act), "reason": "short reason" }',
      validate: (output, context) =>
        validateMonitorCheck(output, configFrom(context.outputs).repair !== undefined),
    }),
    recordCheckTimeout: compute({
      run: (context) => {
        let consecutiveTimeouts = 0;
        for (let index = context.state.steps.length - 1; index >= 0; index -= 1) {
          const step = context.state.steps[index];
          if (step?.nodeId !== "check") continue;
          if (step.outcome !== "timed_out") break;
          consecutiveTimeouts += 1;
        }
        const route = consecutiveTimeouts >= MAX_CONSECUTIVE_CHECK_TIMEOUTS ? "stop" : "retry";
        return {
          route,
          consecutiveTimeouts,
          reason:
            route === "retry"
              ? `Monitor check timed out (${consecutiveTimeouts}/${MAX_CONSECUTIVE_CHECK_TIMEOUTS}); another check will be scheduled after the configured interval.`
              : `Monitor check timed out ${consecutiveTimeouts} consecutive times; stopping without a current observation.`,
        };
      },
    }),
    recordCheckFailure: compute({
      run: (context) => {
        const failed = context.state.steps
          .slice()
          .reverse()
          .find((step) => step.nodeId === "check" && step.outcome === "failed");
        return {
          route: "stop",
          reason: `Monitor check failed without an accepted observation: ${failed?.error ?? "unknown check failure"}`,
        };
      },
    }),
    checkTimeoutRetryReport: notify({
      statusDetail: "reporting monitor check timeout",
      kind: "progress",
      message: ({ outputs }) => {
        const timeout = outputs.recordCheckTimeout as MonitorCheckTimeout;
        return timeout.reason;
      },
    }),
    checkTimeoutStopReport: notify({
      statusDetail: "reporting monitor timeout limit",
      kind: "final",
      message: ({ outputs }) => {
        const timeout = outputs.recordCheckTimeout as MonitorCheckTimeout;
        return timeout.reason;
      },
    }),
    checkFailureReport: notify({
      statusDetail: "reporting monitor check failure",
      kind: "final",
      message: ({ outputs }) => {
        const failure = outputs.recordCheckFailure as MonitorCheckFailure;
        return failure.reason;
      },
    }),
    finishCheckTimeout: compute({
      run: (context) => {
        const timeout = context.outputs.recordCheckTimeout as MonitorCheckTimeout;
        return {
          reason: timeout.reason,
          consecutiveTimeouts: timeout.consecutiveTimeouts,
          checks: completedChecks(context),
          reported: true,
        };
      },
    }),
    finishCheckFailure: compute({
      run: (context) => {
        const failure = context.outputs.recordCheckFailure as MonitorCheckFailure;
        return {
          reason: failure.reason,
          checks: completedChecks(context),
          reported: true,
        };
      },
    }),
    estimate: compute({ run: ({ outputs }) => estimateTracks(outputs) }),
    publish_progress: action({
      statusDetail: "publishing monitor progress",
      run: async ({ outputs, publishUpdate, signal }) => {
        const check = outputs.check as MonitorCheck;
        if (check.progress === undefined) return { published: 0 };
        for (const track of check.progress.tracks) {
          await waitForUpdateSlot(signal);
          await publishUpdate({ type: "progress", key: track.key, data: track.data });
        }
        return { published: check.progress.tracks.length };
      },
    }),
    report: notify({
      statusDetail: "queueing monitor update",
      message: (context) => reportMessage(context),
      kind: "progress",
    }),
    decide: compute({
      run: (context) => {
        const check = context.outputs.check as MonitorCheck;
        const config = configFrom(context.outputs);
        const checks = completedChecks(context);
        if (check.route === "stop") return { route: "stop", reason: check.reason, checks };
        if (checks >= config.maxChecks) {
          return {
            route: "stop",
            reason: `Reached the ${config.maxChecks}-check safety limit.`,
            checks,
          };
        }
        if (check.route === "wait") return { route: "wait", reason: check.reason, checks };
        const request = actionFrom(context.outputs);
        return { route: request.kind, reason: check.reason, checks };
      },
    }),
    act: agent({
      statusDetail: "performing authorized monitor action",
      timeoutMs: ({ outputs }) => configFrom(outputs).checkTimeoutMinutes * 60_000,
      prompt: ({ outputs }) => {
        const request = actionFrom(outputs);
        if (request.kind === "repair") throw new Error("repair must use the composed repair path");
        return [
          `Perform this one ${request.kind} action with normal tools: ${request.nextAction}`,
          `Incomplete work: ${request.incomplete}`,
          `Evidence: ${JSON.stringify(request.evidence)}`,
          `Authorization: ${JSON.stringify(request.authority)}`,
          `Cost safety: ${JSON.stringify(request.cost)}`,
          `Defect safety: ${JSON.stringify(request.defect)}`,
          `Verification: ${request.verification}`,
          "Perform only the stated action and only on the allowed files, systems, and resources. Do not plan, document, redesign, broaden scope, change a protected contract, or perform another action. Verify the direct result before submitting. Preserve the supplied failure and target-state IDs exactly.",
        ].join("\n\n");
      },
      expectedOutput:
        '{ "status": "succeeded" | "failed" | "blocked", "summary": "action performed and real result", "evidence": {}, "verification": "verification performed", "failureId": "unchanged failure ID", "targetStateId": "unchanged target-state ID" }',
      validate: (output, context) =>
        validateMonitorActionResult(output, actionFrom(context.outputs)),
    }),
    repairGuard: compute({
      run: (context) =>
        repeatedRepairWithoutProgress(context)
          ? {
              route: "blocked",
              reason:
                "The same issue returned after a completed repair with no changed target evidence.",
            }
          : { route: "repair", reason: "The issue is new or has changed evidence." },
    }),
    repairBlocked: compute({
      run: (context) => ({
        reason: repairBlockedReason(context.outputs),
        observation: (context.outputs.check as MonitorCheck).observation,
        checks: completedChecks(context),
        reported: true,
      }),
    }),
    repairReport: notify({
      statusDetail: "reporting blocked monitor repair",
      kind: "final",
      message: ({ outputs }) => {
        const result = outputs.repairBlocked as { reason: string };
        return `Automatic repair stopped: ${result.reason}`;
      },
    }),
    schedule: action({
      statusDetail: "scheduling next monitor check",
      run: async ({ outputs, publishUpdate }) => {
        const config = configFrom(outputs);
        const lastCheckAt = new Date().toISOString();
        const nextCheckAt = new Date(
          Date.parse(lastCheckAt) + config.everyMinutes * 60_000,
        ).toISOString();
        await publishUpdate({
          type: "monitor.schedule",
          key: "next-check",
          data: {
            schema: "pi-workflows.monitor-schedule.v1",
            lastCheckAt,
            nextCheckAt,
            everyMinutes: config.everyMinutes,
          },
        });
        return { lastCheckAt, nextCheckAt, everyMinutes: config.everyMinutes };
      },
    }),
    sleep: compute({
      statusDetail: "waiting for next monitor check",
      timeoutMs: null,
      run: async ({ outputs, signal }) => {
        const config = configFrom(outputs);
        const waited = await waitForMonitorInterval(monitorIntervalDeadline(outputs), signal);
        return { waitedMinutes: config.everyMinutes, ...waited };
      },
    }),
    finish: compute({
      run: ({ outputs }) => {
        const check = outputs.check as MonitorCheck;
        const decision = outputs.decide as { reason?: string; checks?: number } | undefined;
        const repair = outputs.repairBlocked as { reason?: string } | undefined;
        return {
          reason: repair?.reason ?? decision?.reason ?? check.reason,
          observation: check.observation,
          goalState: repair === undefined ? check.goalState : "blocked",
          workState: check.workState,
          checks: decision?.checks ?? 1,
          reported: true,
          ...(outputs.implementation !== undefined
            ? { repair: outputs.implementation }
            : repair !== undefined
              ? { repair }
              : {}),
        };
      },
    }),
  },
  edges: [
    { from: "prepare", to: "check" },
    {
      from: "check",
      switch: {
        on: "$result.outcome",
        cases: {
          ok: "estimate",
          timed_out: "recordCheckTimeout",
          failed: "recordCheckFailure",
        },
      },
    },
    {
      from: "recordCheckTimeout",
      switch: {
        on: "$.route",
        cases: { retry: "checkTimeoutRetryReport", stop: "checkTimeoutStopReport" },
      },
    },
    { from: "checkTimeoutRetryReport", to: "schedule" },
    { from: "checkTimeoutStopReport", to: "finishCheckTimeout" },
    { from: "recordCheckFailure", to: "checkFailureReport" },
    { from: "checkFailureReport", to: "finishCheckFailure" },
    { from: "estimate", to: "publish_progress" },
    { from: "publish_progress", to: "report" },
    { from: "report", to: "decide" },
    {
      from: "decide",
      switch: {
        on: "$.route",
        cases: {
          stop: "finish",
          wait: "schedule",
          advance: "act",
          recover: "act",
          repair: "repairGuard",
        },
      },
    },
    { from: "act", to: "check" },
    {
      from: "repairGuard",
      switch: { on: "$.route", cases: { repair: "planChange", blocked: "repairBlocked" } },
    },
    { from: "planChange.ready", to: "implementation" },
    { from: "planChange.blocked", to: "repairBlocked" },
    { from: "implementation.completed", to: "check" },
    { from: "implementation.blocked", to: "repairBlocked" },
    { from: "repairBlocked", to: "repairReport" },
    { from: "repairReport", to: "finish" },
    { from: "schedule", to: "sleep" },
    { from: "sleep", to: "check" },
  ],
});

export default monitorWorkflow;
