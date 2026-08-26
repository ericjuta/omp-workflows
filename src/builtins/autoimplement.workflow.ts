import path from "node:path";
import {
  COMMAND_BATCH_RESULT_SCHEMA,
  runCommandBatch,
  type CommandBatchItem,
  type CommandBatchResult,
  type RunCommandBatchOptions,
} from "../workflows/command-batch.js";
import {
  action,
  agent,
  compute,
  defineWorkflow,
  includeWorkflow,
  includedResult,
} from "../workflows/definition.js";
import { digest } from "../workflows/human-decision.js";
import type { WorkflowActionContext, WorkflowNodeContext } from "../workflows/types.js";
import autodocWorkflow, { type AutodocInput } from "./autodoc.workflow.js";
import {
  attestReviewerRuntime,
  parseAutoimplementConcurrency,
  parseCiInspectionBatch,
  parsePublishedRepositories,
  parseVerificationCommandPlan,
  requireSafeGitRef,
  reviewerCommand,
  reviewerRuntimeFailureReason,
  type AutoimplementConcurrency,
  type CiInspectionBatch,
  type PublishedRepositories,
  type PublishedRepository,
  type ReviewerRuntimeAttestation,
  type VerificationCommandPlan,
} from "./autoimplement-command-batches.js";
import changeVerificationWorkflow, {
  type ChangeVerificationInput,
  type VerificationCheck,
} from "./change-verification.workflow.js";
import { parsePlanApprovalPolicy, type PlanApprovalPolicy } from "./plan-approval.workflow.js";
import planChangeWorkflow, { type NormalizedPlanChangeInput } from "./plan-change.workflow.js";
import workspacePreparationWorkflow, {
  parsePreparedWorkspace,
  type PreparedWorkspace,
  type WorkspaceMode,
  type WorkspacePreparationInput,
} from "./workspace-preparation.workflow.js";

export type AutoimplementInput = {
  task: string;
  plan?: unknown;
  scope?: string;
  constraints?: string[];
  repository: string;
  baseBranch?: string;
  merge?: boolean;
  documents?: string[];
  documentation?: {
    status: "current";
    planDigest: string;
    documents: string[];
  };
  approval?: PlanApprovalPolicy;
  concurrency?: Partial<AutoimplementConcurrency>;
  workspaceMode?: WorkspaceMode;
  directDefaultBranchAuthorized?: boolean;
  preparedWorkspace?: PreparedWorkspace;
  verificationChecks?: VerificationCheck[];
};

export type ExistingPlanDiscovery = {
  route: "found" | "blocked";
  plan?: unknown;
  documentation?: "current" | "missing" | "stale";
  documents: string[];
  reason: string;
  evidence: unknown;
};

type ReviewFinding = {
  severity: "P0" | "P1" | "P2" | "lower";
  kind: "design" | "implementation";
  summary: string;
};

type RepositoryReviewAssessment = {
  id: string;
  repository: string;
  baseBranch: string;
  baseRevision: string;
  headRevision: string;
  dependencyFingerprint?: string;
  invocationSucceeded: boolean;
  p0: ReviewFinding[];
  p1: ReviewFinding[];
  p2: ReviewFinding[];
  lower: ReviewFinding[];
  reason: string;
};

type ReviewAssessment = {
  route: "critical" | "p2" | "clean" | "command_error" | "blocked";
  invocationSucceeded: boolean;
  p0: ReviewFinding[];
  p1: ReviewFinding[];
  p2: ReviewFinding[];
  lower: ReviewFinding[];
  reason: string;
  repositories?: RepositoryReviewAssessment[];
};

export type AutoimplementCompleted = {
  status: "completed";
  task: string;
  plan: unknown;
  implementation: unknown;
  verification: unknown;
  reviewRounds: ReviewAssessment[];
  ci: unknown;
  delivery: unknown;
};

export type AutoimplementBlocked = {
  status: "blocked";
  task: string;
  reason: string;
  evidence: unknown;
};

type BlockerOrigin =
  | "implementation"
  | "verification"
  | "reviewer"
  | "comments"
  | "ci"
  | "delivery"
  | "defaultBranch";

type BlockerRecovery =
  | "redesign"
  | "fix"
  | "planVerification"
  | "repairReviewCommand"
  | "selectReviewCommands"
  | "inspectComments"
  | "inspectCi"
  | "opportunisticTest"
  | "finalizeDefaultBranch";

type BlockerChallenge = {
  route: "continue" | "blocked";
  origin: BlockerOrigin;
  recovery: BlockerRecovery;
  blockingNow: boolean;
  outsideAuthority: boolean;
  canProceed: boolean;
  reason: string;
  nextAction: string;
  alternativesChecked: string[];
  evidence: string[];
};

const BLOCKER_RECOVERIES: Record<BlockerOrigin, readonly BlockerRecovery[]> = {
  implementation: ["redesign", "fix"],
  verification: ["planVerification", "fix"],
  reviewer: ["repairReviewCommand", "selectReviewCommands"],
  comments: ["inspectComments", "fix"],
  ci: ["inspectCi", "opportunisticTest"],
  delivery: ["inspectComments", "inspectCi"],
  defaultBranch: ["finalizeDefaultBranch"],
};

const MAX_BLOCKER_CHALLENGES = 3;
const MAX_CHALLENGE_ITEMS = 5;
const MAX_CHALLENGE_TEXT = 500;
const MAX_TIMEOUT_FALLBACKS = 3;
const MAX_TIMEOUT_FALLBACK_EVIDENCE = 8;
const TIMEOUT_FALLBACK_SOURCES = [
  "implement",
  "planVerification",
  "fix",
  "publish",
  "addressP2",
  "verifyP2",
  "inspectComments",
  "inspectCi",
  "opportunisticTest",
  "finalizeDefaultBranch",
  "finalizeDelivery",
] as const;

const WORK_ATTEMPT_NODES = ["implement", "fix", "addressP2"] as const;

type TimeoutFallbackSource = (typeof TIMEOUT_FALLBACK_SOURCES)[number];
type TimeoutFallbackRoute = "retry" | "verify" | "review" | "ci" | "deliver" | "replan" | "blocked";

const TIMEOUT_FALLBACK_ROUTES: Record<TimeoutFallbackSource, readonly TimeoutFallbackRoute[]> = {
  implement: ["retry", "replan", "blocked"],
  planVerification: ["retry", "verify", "replan", "blocked"],
  fix: ["retry", "replan", "blocked"],
  publish: ["retry", "replan", "blocked"],
  addressP2: ["retry", "replan", "blocked"],
  verifyP2: ["retry", "replan", "blocked"],
  inspectComments: ["retry", "review", "ci", "replan", "blocked"],
  inspectCi: ["retry", "ci", "deliver", "replan", "blocked"],
  opportunisticTest: ["retry", "ci", "deliver", "replan", "blocked"],
  finalizeDefaultBranch: ["retry", "replan", "blocked"],
  finalizeDelivery: ["retry", "deliver", "replan", "blocked"],
};

type TimeoutFallbackResult = {
  route: TimeoutFallbackRoute;
  reason: string;
  evidence: string[];
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireAbsolutePath(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!path.isAbsolute(result)) throw new Error(`${label} must be absolute`);
  return path.resolve(result);
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value] as string[];
}

function boundedChallengeItems(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_CHALLENGE_ITEMS) {
    throw new Error(`${label} must be an array with at most ${MAX_CHALLENGE_ITEMS} items`);
  }
  return value.map((item, index) => {
    const text = requireString(item, `${label}[${index}]`);
    if (text.length > MAX_CHALLENGE_TEXT) {
      throw new Error(`${label}[${index}] must be at most ${MAX_CHALLENGE_TEXT} characters`);
    }
    return text;
  });
}
const MAX_PROMPT_CHARS_DEFAULT = 24_000;
const MAX_PROMPT_CHARS_BATCH = 32_000;
const MAX_PROMPT_CHARS_PLAN = 16_000;
const MAX_PROMPT_CHARS_ISSUE = 16_000;
const MAX_PROMPT_CHARS_REVIEW = 24_000;
const MAX_PROMPT_CHARS_TEXT = 8_000;
const MAX_PROMPT_CHARS_SCOPE = 4_000;
const MAX_PROMPT_CHARS_CONSTRAINTS = 8_000;
const MAX_PROMPT_CHARS_DOCUMENTS = 8_000;
const MAX_PROMPT_CHARS_ATTEMPTS = 16_000;

const PROMPT_ROUTE_KEYS: Record<string, true> = {
  allPassed: true,
  anyFailed: true,
  anyTimedOut: true,
  anyTruncated: true,
  attemptId: true,
  baseBranch: true,
  blockingNow: true,
  branch: true,
  canProceed: true,
  command: true,
  completed: true,
  cwd: true,
  exitCode: true,
  headRevision: true,
  id: true,
  invocationSucceeded: true,
  issueKind: true,
  kind: true,
  reason: true,
  name: true,
  nodeId: true,
  origin: true,
  outcome: true,
  outsideAuthority: true,
  passed: true,
  pushed: true,
  recovery: true,
  repository: true,
  route: true,
  schema: true,
  severity: true,
  source: true,
  status: true,
  summary: true,
  stderrTruncated: true,
  stdoutTruncated: true,
  timedOut: true,
  total: true,
};

const PROMPT_COLLECTION_KEYS: Record<string, true> = {
  commands: true,
  evidence: true,
  failures: true,
  files: true,
  items: true,
  lower: true,
  p0: true,
  p1: true,
  p2: true,
  repositories: true,
  steps: true,
  targets: true,
  untested: true,
};
const PROMPT_ID_KEYS: Record<string, true> = {
  attemptId: true,
  headRevision: true,
  id: true,
  nodeId: true,
  runId: true,
};

function boundPromptText(text: string, maxChars = MAX_PROMPT_CHARS_TEXT): string {
  if (text.length <= maxChars) return text;
  const marker = `\n... [TRUNCATED ${text.length} original chars] ...\n`;
  if (marker.length >= maxChars) return "[TRUNCATED]";
  const headChars = Math.floor((maxChars - marker.length) / 2);
  const tailChars = maxChars - marker.length - headChars;
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
}
function compactPromptFact(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…".slice(0, maxChars);
  const headChars = Math.ceil((maxChars - 1) / 2);
  const tailChars = maxChars - 1 - headChars;
  return `${text.slice(0, headChars)}…${tailChars === 0 ? "" : text.slice(-tailChars)}`;
}

function projectPromptValue(
  value: unknown,
  stringBudget: number,
  summaryOnly: boolean,
  arrayLimit = Number.POSITIVE_INFINITY,
  compactStrings = false,
): unknown {
  if (typeof value === "string") {
    return compactStrings
      ? compactPromptFact(value, stringBudget)
      : boundPromptText(value, stringBudget);
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const limit = Math.max(1, Math.floor(arrayLimit));
    if (value.length <= limit) {
      return value.map((item) =>
        projectPromptValue(item, stringBudget, summaryOnly, arrayLimit, compactStrings),
      );
    }
    const headCount = Math.ceil(limit / 2);
    const tailCount = Math.floor(limit / 2);
    const omittedItems = value.length - headCount - tailCount;
    return [
      ...value
        .slice(0, headCount)
        .map((item) =>
          projectPromptValue(item, stringBudget, summaryOnly, arrayLimit, compactStrings),
        ),
      { promptProjection: { truncated: true, omittedItems } },
      ...value
        .slice(value.length - tailCount)
        .map((item) =>
          projectPromptValue(item, stringBudget, summaryOnly, arrayLimit, compactStrings),
        ),
    ];
  }

  const projected: Record<string, unknown> = {};
  let omittedFields = 0;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const routeFact = PROMPT_ROUTE_KEYS[key] === true;
    const collection = PROMPT_COLLECTION_KEYS[key] === true;
    if (
      summaryOnly &&
      !routeFact &&
      !collection &&
      typeof child !== "number" &&
      typeof child !== "boolean"
    ) {
      omittedFields += 1;
      continue;
    }
    const factBudget = PROMPT_ID_KEYS[key] === true ? 128 : Math.min(512, stringBudget);
    projected[key] = projectPromptValue(
      child,
      routeFact ? factBudget : stringBudget,
      summaryOnly,
      arrayLimit,
      routeFact || collection,
    );
  }
  if (omittedFields > 0) {
    projected.promptProjection = {
      truncated: true,
      omittedFields,
    };
  }
  return projected;
}

function projectBoundedJson(value: unknown, maxChars = MAX_PROMPT_CHARS_DEFAULT): string {
  if (value === undefined) return "";
  if (typeof value === "string") return boundPromptText(value, maxChars);

  for (const stringBudget of [4_000, 2_000, 1_000, 500, 250, 120, 60, 20]) {
    const json = JSON.stringify(projectPromptValue(value, stringBudget, false));
    if (json.length <= maxChars) return json;
  }
  for (const stringBudget of [120, 60, 20]) {
    const json = JSON.stringify(projectPromptValue(value, stringBudget, true));
    if (json.length <= maxChars) return json;
  }
  for (const arrayLimit of [64, 32, 16, 8, 4]) {
    const json = JSON.stringify(projectPromptValue(value, 20, true, arrayLimit));
    if (json.length <= maxChars) return json;
  }

  throw new Error(`Autoimplement structural prompt projection exceeds ${maxChars} characters`);
}

function isTimeoutFallbackSource(nodeId: string): nodeId is TimeoutFallbackSource {
  return (TIMEOUT_FALLBACK_SOURCES as readonly string[]).includes(nodeId);
}

function latestTimedOutStep(context: WorkflowNodeContext) {
  for (let index = context.state.steps.length - 1; index >= 0; index -= 1) {
    const step = context.state.steps[index];
    if (step?.outcome === "timed_out" && isTimeoutFallbackSource(step.nodeId)) return step;
  }
  throw new Error("No supported timed-out Autoimplement step is available");
}

function latestStepIndex(
  context: WorkflowNodeContext,
  predicate: (step: WorkflowNodeContext["state"]["steps"][number]) => boolean,
): number {
  for (let index = context.state.steps.length - 1; index >= 0; index -= 1) {
    const step = context.state.steps[index];
    if (step && predicate(step)) return index;
  }
  return -1;
}

function latestWorkAttemptIndex(context: WorkflowNodeContext): number {
  return latestStepIndex(context, (step) =>
    (WORK_ATTEMPT_NODES as readonly string[]).includes(step.nodeId),
  );
}

function hasCurrentAcceptedWork(context: WorkflowNodeContext): boolean {
  const index = latestWorkAttemptIndex(context);
  return index >= 0 && context.state.steps[index]?.outcome === "ok";
}

function latestPublicationIndex(context: WorkflowNodeContext): number {
  return latestStepIndex(context, (step) => {
    if (step.outcome !== "ok") return false;
    if (step.nodeId === "publish") return true;
    if (step.nodeId !== "verifyP2") return false;
    const output = step.output;
    return (
      output !== null && typeof output === "object" && "passed" in output && output.passed === true
    );
  });
}

function hasCurrentPublication(context: WorkflowNodeContext): boolean {
  return latestPublicationIndex(context) > latestWorkAttemptIndex(context);
}

function latestSuccessfulRouteStep(
  context: WorkflowNodeContext,
  nodeIds: readonly string[],
): { index: number; route: string | undefined } {
  const index = latestStepIndex(
    context,
    (step) => step.outcome === "ok" && nodeIds.includes(step.nodeId),
  );
  const output = index < 0 ? undefined : context.state.steps[index]?.output;
  const route =
    output !== null &&
    typeof output === "object" &&
    "route" in output &&
    typeof output.route === "string"
      ? output.route
      : undefined;
  return { index, route };
}

function currentCommentsIndex(context: WorkflowNodeContext): number {
  const publicationIndex = latestPublicationIndex(context);
  const comments = latestSuccessfulRouteStep(context, ["inspectComments"]);
  return comments.index > publicationIndex && comments.route === "ci" ? comments.index : -1;
}

function hasCurrentReadyCi(context: WorkflowNodeContext): boolean {
  const commentsIndex = currentCommentsIndex(context);
  if (commentsIndex < 0) return false;
  const ci = latestSuccessfulRouteStep(context, ["inspectCi", "assessTrackedCi"]);
  if (ci.index <= commentsIndex) return false;
  if (ci.route === "green") return true;
  if (ci.route !== "failed") return false;
  const classification = latestSuccessfulRouteStep(context, ["classifyCi"]);
  return classification.index > ci.index && classification.route === "unrelated";
}

function parseTimeoutFallback(value: unknown, context: WorkflowNodeContext): TimeoutFallbackResult {
  const result = requireRecord(value, "timeout fallback");
  const routes: TimeoutFallbackRoute[] = [
    "retry",
    "verify",
    "review",
    "ci",
    "deliver",
    "replan",
    "blocked",
  ];
  if (!routes.includes(result.route as TimeoutFallbackRoute)) {
    throw new Error(`timeout fallback route must be one of ${routes.join(", ")}`);
  }
  const route = result.route as TimeoutFallbackRoute;
  const reason = requireString(result.reason, "timeout fallback reason");
  const evidence = requireStringArray(result.evidence, "timeout fallback evidence").map(
    (item, index) => requireString(item, `timeout fallback evidence[${index}]`),
  );
  if (evidence.length === 0 || evidence.length > MAX_TIMEOUT_FALLBACK_EVIDENCE) {
    throw new Error(
      `timeout fallback evidence must contain 1 through ${MAX_TIMEOUT_FALLBACK_EVIDENCE} items`,
    );
  }

  const timedOut = latestTimedOutStep(context);
  const source = timedOut.nodeId as TimeoutFallbackSource;
  if (!TIMEOUT_FALLBACK_ROUTES[source].includes(route)) {
    throw new Error(`timeout fallback route ${route} is not safe after timed-out ${source}`);
  }
  if (route === "verify" && !hasCurrentAcceptedWork(context)) {
    throw new Error("timeout fallback cannot route to verification without current accepted work");
  }
  if (["review", "ci", "deliver"].includes(route) && !hasCurrentPublication(context)) {
    throw new Error(
      "timeout fallback cannot move past publication without a current published head",
    );
  }
  if (route === "ci" && currentCommentsIndex(context) < 0) {
    throw new Error("timeout fallback cannot route to CI before comment inspection completed");
  }
  if (route === "deliver" && !hasCurrentReadyCi(context)) {
    throw new Error("timeout fallback cannot route to delivery before CI is ready");
  }

  return { route, reason, evidence };
}

function timeoutFallbackTarget(context: WorkflowNodeContext): { route: string } {
  const fallback = context.outputs.timeoutFallback as TimeoutFallbackResult;
  if (fallback.route !== "retry") {
    const routes: Record<Exclude<TimeoutFallbackRoute, "retry">, string> = {
      verify: "selectVerificationPath",
      review: "selectReviewCommands",
      ci: "inspectCi",
      deliver: "finalizeDelivery",
      replan: "redesign",
      blocked: "blocked",
    };
    return { route: routes[fallback.route] };
  }
  return { route: latestTimedOutStep(context).nodeId };
}

function timeoutFallbackGuard(context: WorkflowNodeContext) {
  const timeout = latestTimedOutStep(context);
  const attempts = context.state.steps.filter(
    (step) => step.nodeId === "timeoutFallback" && step.outcome === "ok",
  ).length;
  if (attempts >= MAX_TIMEOUT_FALLBACKS) {
    const timeouts = context.state.steps
      .filter((step) => step.outcome === "timed_out" && isTimeoutFallbackSource(step.nodeId))
      .map((step) => ({
        nodeId: step.nodeId,
        attemptId: step.attemptId,
        error: step.error,
      }));
    return {
      route: "blocked",
      reason: `Autoimplement reached the ${MAX_TIMEOUT_FALLBACKS}-fallback timeout safety limit.`,
      evidence: {
        attempts,
        limit: MAX_TIMEOUT_FALLBACKS,
        timeouts,
      },
    };
  }
  return {
    route: "recover",
    attempt: attempts + 1,
    limit: MAX_TIMEOUT_FALLBACKS,
    timeout: {
      nodeId: timeout.nodeId,
      attemptId: timeout.attemptId,
      error: timeout.error,
    },
  };
}

function throwLatestSupportedFailure(context: WorkflowNodeContext): never {
  for (let index = context.state.steps.length - 1; index >= 0; index -= 1) {
    const step = context.state.steps[index];
    if (
      step?.outcome === "failed" &&
      (isTimeoutFallbackSource(step.nodeId) ||
        step.nodeId === "assessReview" ||
        step.nodeId === "recoverReviewAssessment")
    ) {
      throw new Error(step.error ?? `Autoimplement node failed: ${step.nodeId}`);
    }
  }
  throw new Error("No supported failed Autoimplement step is available");
}

function parseBlockerChallenge(value: unknown, context: WorkflowNodeContext): BlockerChallenge {
  const result = requireRecord(value, "blocker challenge");
  if (result.route !== "continue" && result.route !== "blocked") {
    throw new Error("blocker challenge route must be continue or blocked");
  }
  const guard = requireRecord(context.outputs.challengeBlockerGuard, "blocker challenge guard");
  const origin = guard.origin;
  if (typeof origin !== "string" || !(origin in BLOCKER_RECOVERIES) || result.origin !== origin) {
    throw new Error("blocker challenge origin must match the guarded blocker origin");
  }
  const recovery = result.recovery;
  if (
    typeof recovery !== "string" ||
    !BLOCKER_RECOVERIES[origin as BlockerOrigin].includes(recovery as BlockerRecovery)
  ) {
    throw new Error(`blocker challenge recovery is not allowed for ${String(origin)}`);
  }
  for (const key of ["blockingNow", "outsideAuthority", "canProceed"] as const) {
    if (typeof result[key] !== "boolean") {
      throw new Error(`blocker challenge ${key} must be a boolean`);
    }
  }
  const blockingNow = result.blockingNow as boolean;
  const outsideAuthority = result.outsideAuthority as boolean;
  const canProceed = result.canProceed as boolean;
  const reason = requireString(result.reason, "blocker challenge reason");
  if (reason.length > MAX_CHALLENGE_TEXT) {
    throw new Error(`blocker challenge reason must be at most ${MAX_CHALLENGE_TEXT} characters`);
  }
  if (typeof result.nextAction !== "string") {
    throw new Error("blocker challenge nextAction must be a string");
  }
  const nextAction = result.nextAction.trim();
  if (nextAction.length > MAX_CHALLENGE_TEXT) {
    throw new Error(
      `blocker challenge nextAction must be at most ${MAX_CHALLENGE_TEXT} characters`,
    );
  }
  const alternativesChecked = boundedChallengeItems(
    result.alternativesChecked,
    "blocker challenge alternativesChecked",
  );
  const evidence = boundedChallengeItems(result.evidence, "blocker challenge evidence");

  if (result.route === "blocked") {
    if (
      blockingNow !== true ||
      outsideAuthority !== true ||
      canProceed !== false ||
      nextAction.length > 0 ||
      alternativesChecked.length === 0 ||
      evidence.length === 0
    ) {
      throw new Error(
        "blocked challenge requires blockingNow=true, outsideAuthority=true, canProceed=false, an empty nextAction, and concrete alternatives and evidence",
      );
    }
  } else if (canProceed !== true || nextAction.length === 0) {
    throw new Error("continue challenge requires canProceed=true and a practical nextAction");
  }

  return {
    route: result.route,
    origin: origin as BlockerOrigin,
    recovery: recovery as BlockerRecovery,
    blockingNow,
    outsideAuthority,
    canProceed,
    reason,
    nextAction,
    alternativesChecked,
    evidence,
  };
}

function parseInput(value: unknown): AutoimplementInput {
  const input = requireRecord(value, "autoimplement input");
  const constraints = input.constraints;
  if (
    constraints !== undefined &&
    (!Array.isArray(constraints) || constraints.some((item) => typeof item !== "string"))
  ) {
    throw new Error("autoimplement constraints must be an array of strings");
  }
  if (input.merge !== undefined && typeof input.merge !== "boolean") {
    throw new Error("autoimplement merge must be a boolean");
  }
  const documents = input.documents;
  if (
    documents !== undefined &&
    (!Array.isArray(documents) || documents.some((item) => typeof item !== "string"))
  ) {
    throw new Error("autoimplement documents must be an array of strings");
  }
  let documentation: AutoimplementInput["documentation"];
  if (input.documentation !== undefined) {
    if (input.plan === undefined) {
      throw new Error("autoimplement documentation requires an explicit plan");
    }
    const raw = requireRecord(input.documentation, "autoimplement documentation");
    if (raw.status !== "current") {
      throw new Error("autoimplement documentation status must be current");
    }
    const planDigest = requireString(raw.planDigest, "autoimplement documentation planDigest");
    if (planDigest !== digest(input.plan)) {
      throw new Error("autoimplement documentation planDigest does not match the explicit plan");
    }
    if (!Array.isArray(raw.documents) || raw.documents.some((item) => typeof item !== "string")) {
      throw new Error("autoimplement documentation documents must be an array of strings");
    }
    documentation = {
      status: "current",
      planDigest,
      documents: [...raw.documents] as string[],
    };
  }
  const repository = requireAbsolutePath(input.repository, "repository");
  const concurrency = parseAutoimplementConcurrency(input.concurrency);
  const approval = parsePlanApprovalPolicy(input.approval);
  let workspaceMode: WorkspaceMode | undefined;
  if (input.workspaceMode !== undefined) {
    if (
      input.workspaceMode !== "auto" &&
      input.workspaceMode !== "branch" &&
      input.workspaceMode !== "worktree" &&
      input.workspaceMode !== "defaultBranch"
    ) {
      throw new Error(
        "autoimplement workspaceMode must be auto, branch, worktree, or defaultBranch",
      );
    }
    workspaceMode = input.workspaceMode;
  }
  const parsedPreparedWorkspace =
    input.preparedWorkspace === undefined
      ? undefined
      : parsePreparedWorkspace(input.preparedWorkspace);
  if (input.verificationChecks !== undefined && !Array.isArray(input.verificationChecks)) {
    throw new Error("autoimplement verificationChecks must be an array");
  }
  if (Array.isArray(input.verificationChecks) && input.verificationChecks.length === 0) {
    throw new Error("autoimplement verificationChecks must be non-empty when supplied");
  }
  return {
    task: requireString(input.task, "autoimplement task"),
    ...(input.plan !== undefined ? { plan: input.plan } : {}),
    ...(input.scope !== undefined ? { scope: requireString(input.scope, "scope") } : {}),
    ...(constraints !== undefined ? { constraints: [...constraints] as string[] } : {}),
    repository,
    ...(input.baseBranch !== undefined
      ? { baseBranch: requireSafeGitRef(input.baseBranch, "baseBranch") }
      : {}),
    merge: input.merge === true,
    ...(documents !== undefined ? { documents: [...documents] as string[] } : {}),
    ...(documentation !== undefined ? { documentation } : {}),
    approval,
    concurrency,
    ...(workspaceMode === undefined ? {} : { workspaceMode }),
    ...(input.directDefaultBranchAuthorized === undefined
      ? {}
      : { directDefaultBranchAuthorized: input.directDefaultBranchAuthorized === true }),
    ...(parsedPreparedWorkspace === undefined
      ? {}
      : { preparedWorkspace: parsedPreparedWorkspace }),
    ...(input.verificationChecks === undefined
      ? {}
      : { verificationChecks: input.verificationChecks as VerificationCheck[] }),
  };
}

function parseExistingPlan(value: unknown): ExistingPlanDiscovery {
  const result = requireRecord(value, "existing plan discovery");
  if (result.route !== "found" && result.route !== "blocked") {
    throw new Error("existing plan discovery route must be found or blocked");
  }
  if (result.route === "found") {
    if (result.plan === undefined) throw new Error("found plan must include plan");
    if (
      result.documentation !== "current" &&
      result.documentation !== "missing" &&
      result.documentation !== "stale"
    ) {
      throw new Error("found plan documentation must be current, missing, or stale");
    }
  }
  if (
    !Array.isArray(result.documents) ||
    result.documents.some((item) => typeof item !== "string")
  ) {
    throw new Error("existing plan documents must be an array of strings");
  }
  return {
    route: result.route,
    ...(result.plan !== undefined ? { plan: result.plan } : {}),
    ...(result.documentation !== undefined
      ? { documentation: result.documentation as "current" | "missing" | "stale" }
      : {}),
    documents: [...result.documents] as string[],
    reason: requireString(result.reason, "existing plan discovery reason"),
    evidence: result.evidence ?? null,
  };
}

function parseRoute<T extends string>(
  value: unknown,
  routes: readonly T[],
  label: string,
): Record<string, unknown> & { route: T } {
  const record = requireRecord(value, label);
  if (!routes.includes(record.route as T)) {
    throw new Error(`${label} route must be one of ${routes.join(", ")}`);
  }
  return { ...record, route: record.route as T };
}

type ReviewCommandSelection = {
  route: "run" | "reuse";
  repositories: PublishedRepository[];
  commands: CommandBatchItem[];
  reviewerRuntime: ReviewerRuntimeAttestation;
};

type BatchExecution = {
  route: "assess" | "repair" | "blocked";
  batch: CommandBatchResult;
  reason?: string;
};

function concurrency(context: WorkflowNodeContext): AutoimplementConcurrency {
  return parseAutoimplementConcurrency((context.input as AutoimplementInput).concurrency);
}

type CommandBatchTrust = Pick<
  RunCommandBatchOptions,
  "gitCommand" | "validateBeforeGitSpawn" | "validateBeforeSpawn"
>;

function runAutoimplementBatch(
  context: WorkflowActionContext,
  kind: "review" | "ciWatch" | "verification",
  commands: CommandBatchItem[],
  maxConcurrency: number,
  trust: CommandBatchTrust = {},
): Promise<CommandBatchResult> {
  return runCommandBatch(
    { items: commands, maxConcurrency: Math.min(maxConcurrency, Math.max(1, commands.length)) },
    {
      signal: context.signal,
      ...trust,
      onItemSettled: async (result, completed, total) => {
        if (context.signal.aborted) return;
        try {
          await context.publishUpdate({
            type: "command-batch.item",
            key: `${kind}/${result.id}`,
            data: {
              schema: "pi-workflows.command-batch-item.v1",
              batchKind: kind,
              itemId: result.id,
              outcome: result.outcome,
              completed,
              total,
            },
          });
        } catch (error) {
          if (!context.signal.aborted) throw error;
        }
      },
    },
  );
}

function commandBatchTimeoutMs(commands: CommandBatchItem[], maxConcurrency: number): number {
  if (commands.length === 0) return 10_000;
  const concurrency = Math.min(maxConcurrency, commands.length);
  const waves = Math.ceil(commands.length / concurrency);
  const longestItem = Math.max(...commands.map((command) => command.timeoutMs));
  return waves * longestItem + 10_000;
}

function reviewBatchNeedsRepair(result: CommandBatchResult): boolean {
  return result.items.some(
    (item) =>
      item.outcome === "timedOut" ||
      item.outcome === "cancelled" ||
      (item.outcome === "failed" && item.exitCode === null) ||
      item.stdoutTruncated ||
      item.stderrTruncated,
  );
}

function reviewRepairAttempted(context: WorkflowNodeContext): boolean {
  return context.state.steps.some(
    (step) => step.nodeId === "repairReviewCommand" && step.outcome === "ok",
  );
}

function latestOutput<T>(context: WorkflowNodeContext, nodeIds: string[]): T {
  for (let index = context.state.steps.length - 1; index >= 0; index -= 1) {
    const step = context.state.steps[index];
    if (step && nodeIds.includes(step.nodeId)) return step.output as T;
  }
  for (const nodeId of nodeIds) {
    if (context.outputs[nodeId] !== undefined) return context.outputs[nodeId] as T;
  }
  throw new Error(`No output found for ${nodeIds.join(" or ")}`);
}

function currentPlan(context: WorkflowNodeContext): unknown {
  const adopted = context.outputs.adoptPlan as { plan?: unknown } | undefined;
  if (adopted?.plan !== undefined) return adopted.plan;
  const documented = context.outputs.documentation as
    | { exit?: string; output?: { plan?: unknown } }
    | undefined;
  if (documented?.exit === "ready" && documented.output?.plan !== undefined) {
    return documented.output.plan;
  }
  const discovered = context.outputs.findPlan as ExistingPlanDiscovery | undefined;
  if (discovered?.route === "found" && discovered.plan !== undefined) return discovered.plan;
  return (context.input as AutoimplementInput).plan;
}
function preparedWorkspace(context: WorkflowNodeContext): PreparedWorkspace {
  const request = context.input as AutoimplementInput;
  if (request.preparedWorkspace !== undefined) return request.preparedWorkspace;
  const result = includedResult(workspacePreparationWorkflow, context.outputs.workspace);
  if (result.exit !== "ready") throw new Error("autoimplement workspace is not ready");
  return result.output;
}

function preparedRepository(context: WorkflowNodeContext): string {
  const workspace = preparedWorkspace(context);
  return workspace.worktreePath ?? workspace.repository;
}
function preparedRepositoryRules(context: WorkflowNodeContext): string[] {
  const repository = preparedRepository(context);
  return [
    `Prepared repository: ${repository}`,
    `Run every repository command from exactly ${repository}; do not access or modify another repository.`,
    "Preserve every pre-existing untracked and ignored file, and every tracked file outside the current authorized changes. Never run git clean or any equivalent cleanup. Never overwrite or delete a pre-existing untracked or ignored file.",
  ];
}

function parseImplementationForContext(
  value: unknown,
  context: WorkflowNodeContext,
): Record<string, unknown> {
  const result = requireRecord(value, "implementation result");
  const repository = preparedRepository(context);
  if (result.repositories !== undefined) {
    const reported = requireStringArray(result.repositories, "implementation repositories");
    if (
      reported.length !== 1 ||
      !path.isAbsolute(reported[0]!) ||
      path.resolve(reported[0]!) !== repository
    ) {
      throw new Error(`implementation repositories must contain only ${repository}`);
    }
  }
  const files = requireStringArray(result.files ?? [], "implementation files");
  for (const file of files) {
    const resolved = path.resolve(repository, file);
    if (
      path.isAbsolute(file) ||
      (resolved !== repository && !resolved.startsWith(`${repository}${path.sep}`))
    ) {
      throw new Error(`implementation file must stay inside the prepared repository: ${file}`);
    }
  }
  return { ...result, repository, repositories: [repository], files };
}

function parsePublishedForContext(
  value: unknown,
  context: WorkflowNodeContext,
): PublishedRepositories {
  const result = parsePublishedRepositories(value);
  const repository = preparedRepository(context);
  if (result.repositories.length !== 1 || result.repositories[0]?.repository !== repository) {
    throw new Error(`publication repositories must contain only ${repository}`);
  }
  const requestedBaseBranch = (context.input as AutoimplementInput).baseBranch;
  if (
    requestedBaseBranch !== undefined &&
    result.repositories[0]?.baseBranch !== requestedBaseBranch
  ) {
    throw new Error(`publication repository must use base branch ${requestedBaseBranch}`);
  }
  return result;
}

function currentDocumentationReceipt(
  context: WorkflowNodeContext,
  plan: unknown,
): AutodocInput["documentation"] | undefined {
  const planDigest = digest(plan);
  const request = context.input as AutoimplementInput;
  if (request.documentation?.planDigest === planDigest) return request.documentation;
  if (context.outputs.documentation === undefined) return undefined;
  const documented = includedResult(autodocWorkflow, context.outputs.documentation);
  if (documented.exit !== "ready" || documented.output.planDigest !== planDigest) return undefined;
  return {
    status: "current",
    planDigest,
    documents: documented.output.documentation.files,
  };
}
const BLOCKER_ORIGINS_BY_NODE: Readonly<Record<string, BlockerOrigin>> = {
  classifyImplementation: "implementation",
  selectVerificationPath: "verification",
  localVerification: "verification",
  runReview: "reviewer",
  repairReviewCommand: "reviewer",
  routeReviewAssessment: "reviewer",
  routeInspectCommentsResult: "comments",
  routeInspectCiResult: "ci",
  repairCiCommand: "ci",
  assessTrackedCi: "ci",
  classifyCi: "ci",
  routeFinalizeDeliveryResult: "delivery",
  routeFinalizeDefaultBranchResult: "defaultBranch",
};

function blockerOriginNodeId(nodeId: string): string {
  const slash = nodeId.indexOf("/");
  return slash === -1 ? nodeId : nodeId.slice(0, slash);
}

function blockerOrigin(context: WorkflowNodeContext): BlockerOrigin {
  const previous = context.state.steps.at(-1);
  const nodeId = previous?.nodeId;
  const origin =
    nodeId === undefined
      ? undefined
      : (BLOCKER_ORIGINS_BY_NODE[nodeId] ?? BLOCKER_ORIGINS_BY_NODE[blockerOriginNodeId(nodeId)]);
  if (origin === undefined) {
    throw new Error(
      `No safe blocker recovery exists for ${previous?.nodeId ?? "the workflow start"}`,
    );
  }
  return origin;
}

function blockerChallenges(context: WorkflowNodeContext): BlockerChallenge[] {
  return context.state.steps
    .filter((step) => step.nodeId === "challengeBlocker" && step.outcome === "ok")
    .map((step) => step.output as BlockerChallenge);
}

function latestBlockerClaim(context: WorkflowNodeContext): unknown {
  const ids = [
    "classifyImplementation",
    "runReview",
    "routeReviewAssessment",
    "localVerification",
    "repairReviewCommand",
    "routeInspectCommentsResult",
    "routeInspectCiResult",
    "repairCiCommand",
    "assessTrackedCi",
    "classifyCi",
    "routeFinalizeDeliveryResult",
    "routeFinalizeDefaultBranchResult",
  ];
  for (let index = context.state.steps.length - 1; index >= 0; index -= 1) {
    const step = context.state.steps[index];
    if (step && ids.includes(step.nodeId)) {
      return { source: step.nodeId, result: step.output };
    }
  }
  throw new Error("No model-generated blocker claim is available to challenge");
}

function recentWorkflowAttempts(context: WorkflowNodeContext): unknown[] {
  return context.state.steps.slice(-12).map((step) => ({
    nodeId: step.nodeId,
    outcome: step.outcome,
    error: step.error ?? null,
    durationMs:
      step.action?.durationMs ??
      Math.max(0, Date.parse(step.finishedAt) - Date.parse(step.startedAt)),
  }));
}

function latestIssue(context: WorkflowNodeContext): unknown {
  const ids = [
    "challengeBlocker",
    "classifyImplementation",
    "localVerification",
    "triageReview",
    "inspectComments",
    "classifyCi",
    "timeoutFallback",
    "adoptPlan",
  ];
  for (let index = context.state.steps.length - 1; index >= 0; index -= 1) {
    const step = context.state.steps[index];
    if (step && ids.includes(step.nodeId)) return step.output;
  }
  return null;
}

function parseFinding(value: unknown, severity: ReviewFinding["severity"]): ReviewFinding {
  const finding = requireRecord(value, `${severity} finding`);
  if (finding.kind !== "design" && finding.kind !== "implementation") {
    throw new Error(`${severity} finding kind must be design or implementation`);
  }
  return {
    severity,
    kind: finding.kind,
    summary: requireString(finding.summary, `${severity} finding summary`),
  };
}

function parseVerificationForContext(
  value: unknown,
  context: WorkflowNodeContext,
): VerificationCommandPlan {
  const implementation = latestOutput<Record<string, unknown>>(context, ["implement"]);
  const repository = preparedRepository(context);
  const provenance = Array.isArray(implementation.repositories) ? implementation.repositories : [];
  if (provenance.length !== 1 || path.resolve(String(provenance[0])) !== repository) {
    throw new Error("verification requires implementation provenance for the prepared repository");
  }
  const plan = parseVerificationCommandPlan(value, repository);
  for (const command of plan.commands) {
    if (path.resolve(command.cwd) !== repository) {
      throw new Error(`verification command cwd must match the prepared repository: ${repository}`);
    }
  }
  return plan;
}

function currentPublishedRepositories(context: WorkflowNodeContext): PublishedRepositories {
  return latestOutput<PublishedRepositories>(context, ["verifyP2", "publish"]);
}
function publishedRepositoryReferences(context: WorkflowNodeContext): string {
  return JSON.stringify({
    repositories: currentPublishedRepositories(context).repositories.map((repository) => ({
      id: repository.id,
      headRevision: repository.headRevision,
      pr: repository.pr,
    })),
  });
}

type DeliveryRepositoryResult = {
  repository: string;
  pr: string;
  merged: boolean;
  reportComment: string;
  reason: string;
};

function parseDeliveryRepository(
  value: unknown,
  index: number,
  published: ReadonlyMap<string, PublishedRepository>,
): DeliveryRepositoryResult {
  const result = requireRecord(value, `delivery repositories[${index}]`);
  const id = requireString(result.id, `delivery repositories[${index}].id`);
  const expected = published.get(id);
  if (expected === undefined) {
    throw new Error(`delivery repositories[${index}].id is not a published repository: ${id}`);
  }
  if (typeof result.merged !== "boolean") {
    throw new Error(`delivery repositories[${index}].merged must be a boolean`);
  }
  return {
    repository: path.resolve(expected.repository),
    pr: expected.pr,
    merged: result.merged,
    reportComment: requireString(
      result.reportComment,
      `delivery repositories[${index}].reportComment`,
    ),
    reason: requireString(result.reason, `delivery repositories[${index}].reason`),
  };
}

function parseDeliveryResult(
  value: unknown,
  context: WorkflowNodeContext,
): Record<string, unknown> {
  const result = requireRecord(value, "delivery result");
  if (result.status !== "completed" && result.status !== "blocked") {
    throw new Error("delivery status must be completed or blocked");
  }
  const request = context.input as AutoimplementInput;
  if (request.merge !== true && result.merged === true) {
    throw new Error("delivery cannot merge without explicit merge: true");
  }
  if (result.status === "blocked") return result;
  if (typeof result.merged !== "boolean") {
    throw new Error("completed delivery merged must be a boolean");
  }
  const reportComment = requireString(result.reportComment, "completed delivery reportComment");
  const reason = requireString(result.reason, "completed delivery reason");
  const published = currentPublishedRepositories(context).repositories;
  const firstPublished = published[0];
  if (firstPublished === undefined)
    throw new Error("completed delivery has no published repository");
  const pr = firstPublished.pr;
  const publishedById = new Map(
    published.map((repository) => [repository.id, repository] as const),
  );
  let repositories: DeliveryRepositoryResult[];
  if (result.repositories === undefined) {
    if (published.length !== 1) {
      throw new Error("completed delivery repositories must cover every published repository");
    }
    const only = published[0];
    if (only === undefined) throw new Error("completed delivery has no published repository");
    repositories = [
      {
        repository: path.resolve(only.repository),
        pr,
        merged: result.merged,
        reportComment,
        reason,
      },
    ];
  } else {
    if (!Array.isArray(result.repositories)) {
      throw new Error("completed delivery repositories must be an array");
    }
    repositories = result.repositories.map((repository, index) =>
      parseDeliveryRepository(repository, index, publishedById),
    );
  }
  const actual = new Map<string, DeliveryRepositoryResult>();
  for (const repository of repositories) {
    if (actual.has(repository.repository)) {
      throw new Error(`completed delivery repository is duplicated: ${repository.repository}`);
    }
    actual.set(repository.repository, repository);
  }
  const mergeExpected = request.merge === true;
  for (const expected of published) {
    const repository = actual.get(path.resolve(expected.repository));
    if (repository === undefined || repository.pr !== expected.pr) {
      throw new Error(
        `completed delivery does not match published repository and PR: ${expected.repository}`,
      );
    }
    if (repository.merged !== mergeExpected) {
      throw new Error(
        `completed delivery merge result does not match merge policy: ${expected.repository}`,
      );
    }
    actual.delete(repository.repository);
  }
  if (actual.size > 0) {
    throw new Error(
      `completed delivery contains unpublished repositories: ${[...actual.keys()].join(", ")}`,
    );
  }
  const first = repositories.find(
    (repository) => repository.repository === path.resolve(firstPublished.repository),
  );
  if (
    first === undefined ||
    first.pr !== pr ||
    first.merged !== result.merged ||
    first.reportComment !== reportComment
  ) {
    throw new Error(
      "completed delivery top-level compatibility fields must match the first result",
    );
  }
  return { status: "completed", merged: result.merged, pr, reportComment, reason, repositories };
}

function parseP2Verification(
  value: unknown,
  context: WorkflowNodeContext,
): Record<string, unknown> {
  const result = requireRecord(value, "P2 verification");
  if (typeof result.passed !== "boolean") {
    throw new Error("P2 verification passed must be a boolean");
  }
  if (result.pushed !== true) {
    throw new Error("P2 verification pushed must be true");
  }
  const refreshed = parsePublishedRepositories(result);
  const previous = latestOutput<PublishedRepositories>(context, ["publish"]);
  const expected = new Map(
    previous.repositories.map((repository) => [repository.id, repository] as const),
  );
  for (const repository of refreshed.repositories) {
    const prior = expected.get(repository.id);
    if (
      prior === undefined ||
      prior.repository !== repository.repository ||
      prior.branch !== repository.branch ||
      prior.baseBranch !== repository.baseBranch ||
      prior.baseRevision !== repository.baseRevision ||
      prior.pr !== repository.pr ||
      prior.dependencyFingerprint !== repository.dependencyFingerprint
    ) {
      throw new Error(`P2 verification repository does not match publication: ${repository.id}`);
    }
    expected.delete(repository.id);
  }
  if (expected.size > 0) {
    throw new Error(
      `P2 verification is missing repository ids: ${[...expected.keys()].join(", ")}`,
    );
  }
  return { ...result, repositories: refreshed.repositories };
}

function parseCiInspectionForPublished(
  value: unknown,
  context: WorkflowNodeContext,
): CiInspectionBatch {
  const result = requireRecord(value, "CI inspection");
  if (!Array.isArray(result.targets)) {
    throw new Error("CI inspection targets must be an array");
  }
  const published = currentPublishedRepositories(context);
  const expected = new Map(
    published.repositories.map((repository) => [repository.id, repository] as const),
  );
  const hydratedTargets = result.targets.map((value, index) => {
    const target = requireRecord(value, `CI targets[${index}]`);
    const id = requireString(target.id, `CI targets[${index}].id`);
    const repository = expected.get(id);
    if (repository === undefined) {
      throw new Error(`CI target id is not a published repository: ${id}`);
    }
    const trackingCommand =
      target.trackingCommand === undefined
        ? undefined
        : {
            ...requireRecord(target.trackingCommand, `CI targets[${index}].trackingCommand`),
            id,
            cwd: repository.repository,
          };
    return {
      ...target,
      repository: repository.repository,
      headRevision: repository.headRevision,
      pr: repository.pr,
      ...(trackingCommand === undefined ? {} : { trackingCommand }),
    };
  });
  const inspected = parseCiInspectionBatch({ targets: hydratedTargets });
  for (const target of inspected.targets) {
    const repository = expected.get(target.id);
    if (
      repository === undefined ||
      repository.repository !== target.repository ||
      repository.headRevision !== target.headRevision ||
      repository.pr !== target.pr
    ) {
      throw new Error(
        `CI target does not match the published repository and head: ${target.id} (${JSON.stringify({ target, repository })})`,
      );
    }
    expected.delete(target.id);
  }
  if (expected.size > 0) {
    throw new Error(`CI inspection is missing repository ids: ${[...expected.keys()].join(", ")}`);
  }
  return inspected;
}

function parseTrackedCiAssessment(
  value: unknown,
  context: WorkflowNodeContext,
): Record<string, unknown> & { route: CiInspectionBatch["route"] } {
  const result = requireRecord(value, "tracked CI assessment");
  const inspected = latestOutput<CiInspectionBatch>(context, ["inspectCi"]);
  const execution = latestOutput<BatchExecution>(context, ["trackCi"]);
  const expectedIds = execution.batch.items.map((item) => item.id);
  if (!Array.isArray(result.targets)) {
    throw new Error("tracked CI assessment targets must be an array");
  }
  const seen = new Set<string>();
  const targets = result.targets.map((entry, index) => {
    const target = requireRecord(entry, `tracked CI assessment targets[${index}]`);
    const id = requireString(target.id, `tracked CI assessment targets[${index}].id`);
    if (seen.has(id)) throw new Error(`tracked CI assessment target is duplicated: ${id}`);
    seen.add(id);
    if (
      target.route !== "green" &&
      target.route !== "failed" &&
      target.route !== "pending" &&
      target.route !== "unavailable"
    ) {
      throw new Error(`tracked CI assessment targets[${index}].route is invalid`);
    }
    return {
      id,
      route: target.route,
      reason: requireString(target.reason, `tracked CI assessment targets[${index}].reason`),
    };
  });
  const missing = expectedIds.filter((id) => !seen.has(id));
  const unexpected = [...seen].filter((id) => !expectedIds.includes(id));
  if (missing.length > 0 || unexpected.length > 0 || targets.length !== expectedIds.length) {
    throw new Error(
      `tracked CI assessment targets must exactly cover watched ids; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`,
    );
  }
  const trackedRoutes = new Map(targets.map((target) => [target.id, target.route] as const));
  const routes = inspected.targets.map((target) => trackedRoutes.get(target.id) ?? target.route);
  const route = routes.includes("failed")
    ? "failed"
    : routes.includes("pending")
      ? "pending"
      : routes.includes("unavailable")
        ? "unavailable"
        : "green";
  if (result.route !== route) {
    throw new Error(`tracked CI assessment route must be ${route}`);
  }
  return {
    ...result,
    route,
    reason: requireString(result.reason, "tracked CI assessment reason"),
    targets,
    relatedFailures: requireStringArray(
      result.relatedFailures ?? [],
      "tracked CI assessment relatedFailures",
    ),
    unrelatedFailures: requireStringArray(
      result.unrelatedFailures ?? [],
      "tracked CI assessment unrelatedFailures",
    ),
  };
}

function selectReviewCommands(context: WorkflowNodeContext): ReviewCommandSelection {
  const published = latestOutput<PublishedRepositories>(context, ["publish"]);
  const reviewed = reviewRounds(context).flatMap((round) => round.repositories ?? []);
  const repositories = published.repositories.filter(
    (repository) =>
      !reviewed.some(
        (entry) =>
          entry.id === repository.id &&
          entry.baseRevision === repository.baseRevision &&
          entry.headRevision === repository.headRevision &&
          entry.dependencyFingerprint === repository.dependencyFingerprint &&
          entry.invocationSucceeded,
      ),
  );
  const prepared = latestOutput<{ reviewerRuntime: ReviewerRuntimeAttestation }>(context, [
    "prepare",
  ]);
  const reviewerRuntime = reviewRepairAttempted(context)
    ? latestOutput<ReviewCommandSelection>(context, ["selectReviewCommands"]).reviewerRuntime
    : prepared.reviewerRuntime;
  const reviewer = reviewerRuntime.reviewer;
  const reviewerEnvironment = reviewerRuntime.reviewerEnvironment;
  if (reviewRepairAttempted(context)) {
    const previous = latestOutput<ReviewCommandSelection>(context, ["selectReviewCommands"]);
    const targetsUnchanged =
      previous.repositories.length === repositories.length &&
      repositories.every((repository, index) => {
        const prior = previous.repositories[index];
        return (
          prior !== undefined &&
          prior.id === repository.id &&
          prior.repository === repository.repository &&
          prior.baseBranch === repository.baseBranch &&
          prior.baseRevision === repository.baseRevision &&
          prior.headRevision === repository.headRevision &&
          prior.dependencyFingerprint === repository.dependencyFingerprint
        );
      });
    const commands =
      repositories.length === 0 || reviewer === undefined || reviewerEnvironment === undefined
        ? []
        : targetsUnchanged
          ? previous.commands
          : repositories.map((repository) =>
              reviewerCommand(repository, reviewer, reviewerEnvironment),
            );
    return {
      route: repositories.length === 0 ? "reuse" : "run",
      repositories,
      commands,
      reviewerRuntime,
    };
  }

  return {
    route: repositories.length === 0 ? "reuse" : "run",
    repositories,
    commands:
      reviewer === undefined || reviewerEnvironment === undefined
        ? []
        : repositories.map((repository) =>
            reviewerCommand(repository, reviewer, reviewerEnvironment),
          ),
    reviewerRuntime,
  };
}

function reviewerAttestationFailureBatch(
  selected: ReviewCommandSelection,
  reason: string,
): CommandBatchResult {
  const items = selected.repositories.map((repository) => ({
    id: repository.id,
    outcome: "failed" as const,
    command: selected.reviewerRuntime.reviewer?.executable ?? "omp-reviewer",
    args: ["--base", repository.baseRevision],
    cwd: repository.repository,
    stdout: "",
    stderr: reason,
    exitCode: null,
    signal: null,
    durationMs: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    error: reason,
  }));
  return {
    schema: COMMAND_BATCH_RESULT_SCHEMA,
    items,
    completed: items.length,
    total: items.length,
  };
}

function reviewerAttestationFailureReason(selected: ReviewCommandSelection): string | undefined {
  const runtimeFailure = reviewerRuntimeFailureReason(selected.reviewerRuntime);
  if (runtimeFailure !== undefined) return runtimeFailure;
  const reviewer = selected.reviewerRuntime.reviewer;
  if (
    reviewer === undefined ||
    !path.isAbsolute(reviewer.executable) ||
    selected.commands.length !== selected.repositories.length ||
    selected.commands.some((command) => command.command !== reviewer.executable)
  ) {
    return "The reviewer command no longer matches the attested absolute executable.";
  }
  return undefined;
}

function reviewerBatchTrust(selected: ReviewCommandSelection): CommandBatchTrust {
  const runtime = selected.reviewerRuntime;
  return {
    ...(runtime.git === undefined ? {} : { gitCommand: runtime.git.executable }),
    validateBeforeGitSpawn: () => reviewerRuntimeFailureReason(runtime),
    validateBeforeSpawn: (item) =>
      reviewerRuntimeFailureReason(runtime) ??
      (item.command === runtime.reviewer?.executable
        ? undefined
        : "The reviewer command no longer matches the attested absolute executable."),
  };
}

function parseReviewAssessment(value: unknown, context: WorkflowNodeContext): ReviewAssessment {
  const review = requireRecord(value, "review assessment");
  if (!Array.isArray(review.repositories)) {
    throw new Error("review repositories must be an array");
  }
  const selected = latestOutput<ReviewCommandSelection>(context, ["selectReviewCommands"]);
  const execution = latestOutput<BatchExecution>(context, ["runReview"]);
  const executed = new Map(execution.batch.items.map((item) => [item.id, item]));
  const expected = new Map(selected.repositories.map((repository) => [repository.id, repository]));
  const repositories = review.repositories.map((value, index) => {
    const raw = requireRecord(value, `review repositories[${index}]`);
    const id = requireString(raw.id, `review repositories[${index}].id`);
    const published = expected.get(id);
    if (published === undefined)
      throw new Error(`review repository id was not in the batch: ${id}`);
    expected.delete(id);
    const batchItem = executed.get(id);
    const batchItemSucceeded = batchItem?.outcome === "succeeded" && batchItem.exitCode === 0;
    const parseList = (key: "p0" | "p1" | "p2" | "lower", severity: ReviewFinding["severity"]) => {
      const list = raw[key];
      if (!Array.isArray(list))
        throw new Error(`review repositories[${index}].${key} must be an array`);
      return list.map((item) => parseFinding(item, severity));
    };
    return {
      id,
      repository: published.repository,
      baseBranch: published.baseBranch,
      baseRevision: published.baseRevision,
      headRevision: published.headRevision,
      ...(published.dependencyFingerprint !== undefined
        ? { dependencyFingerprint: published.dependencyFingerprint }
        : {}),
      invocationSucceeded: batchItemSucceeded && raw.invocationSucceeded === true,
      p0: parseList("p0", "P0"),
      p1: parseList("p1", "P1"),
      p2: parseList("p2", "P2"),
      lower: parseList("lower", "lower"),
      reason: requireString(raw.reason, `review repositories[${index}].reason`),
    } satisfies RepositoryReviewAssessment;
  });
  if (expected.size > 0) {
    throw new Error(
      `review assessment is missing repository ids: ${[...expected.keys()].join(", ")}`,
    );
  }
  const p0 = repositories.flatMap((entry) => entry.p0);
  const p1 = repositories.flatMap((entry) => entry.p1);
  const p2 = repositories.flatMap((entry) => entry.p2);
  const lower = repositories.flatMap((entry) => entry.lower);
  const invocationSucceeded = repositories.every((entry) => entry.invocationSucceeded);
  const route = !invocationSucceeded
    ? reviewRepairAttempted(context)
      ? "blocked"
      : "command_error"
    : p0.length + p1.length > 0
      ? "critical"
      : p2.length > 0
        ? "p2"
        : "clean";
  return {
    route,
    invocationSucceeded,
    p0,
    p1,
    p2,
    lower,
    reason: requireString(review.reason, "review reason"),
    repositories,
  };
}

function reviewRounds(context: WorkflowNodeContext): ReviewAssessment[] {
  return context.state.steps
    .filter(
      (step) =>
        (step.nodeId === "assessReview" || step.nodeId === "recoverReviewAssessment") &&
        step.outcome === "ok",
    )
    .map((step) => step.output as ReviewAssessment);
}

function currentReviewAssessment(context: WorkflowNodeContext): ReviewAssessment {
  return latestOutput<ReviewAssessment>(context, ["recoverReviewAssessment", "assessReview"]);
}

function reviewRoundsForOutput(context: WorkflowNodeContext): ReviewAssessment[] {
  const rounds = reviewRounds(context);
  const repositoryIds = new Set(
    rounds.flatMap((round) => (round.repositories ?? []).map((repository) => repository.id)),
  );
  if (repositoryIds.size > 1) return rounds;
  return rounds.map(({ repositories: _repositories, ...round }) => round);
}

function ciForOutput(context: WorkflowNodeContext): unknown {
  const result = latestOutput<Record<string, unknown>>(context, ["assessTrackedCi", "inspectCi"]);
  const targets = result.targets;
  if (!Array.isArray(targets) || targets.length !== 1) return result;
  const { targets: _targets, ...aggregate } = result;
  if (result.route === "green" || result.route === "failed" || result.route === "unavailable") {
    const target = targets[0];
    if (target !== null && typeof target === "object" && !Array.isArray(target)) {
      const record = target as Record<string, unknown>;
      return {
        ...aggregate,
        reason: aggregate.reason ?? record.reason,
        relatedFailures: aggregate.relatedFailures ?? record.relatedFailures ?? [],
        unrelatedFailures: aggregate.unrelatedFailures ?? record.unrelatedFailures ?? [],
      };
    }
  }
  return aggregate;
}

function latestBlockedReason(context: WorkflowNodeContext): { reason: string; evidence: unknown } {
  const candidates = [
    "timeoutFallbackGuard",
    "timeoutFallback",
    "challengeBlockerGuard",
    "challengeBlocker",
    "runReview",
    "repairReviewCommand",
    "assessReview",
    "reviewAssessmentRecoveryBlocked",
    "finalizeDelivery",
    "inspectCi",
    "assessTrackedCi",
    "classifyCi",
    "inspectComments",
    "classifyImplementation",
    "localVerification",
    "triageReview",
    "redesign",
    "adoptPlan",
    "findPlan",
    "documentation",
    "workspace",
    "prepare",
  ];
  for (let index = context.state.steps.length - 1; index >= 0; index -= 1) {
    const step = context.state.steps[index];
    if (!step || !candidates.includes(step.nodeId)) continue;
    const output = step.output as Record<string, unknown>;
    const reason = output.reason ?? output.blocker ?? output.summary;
    if (typeof reason === "string" && reason.length > 0) return { reason, evidence: step.output };
  }
  return {
    reason: "Autoimplementation could not continue within the authorized scope.",
    evidence: null,
  };
}

export const autoimplementWorkflow = defineWorkflow({
  source: import.meta.url,
  contractId: "pi-workflows.autoimplement.v1",
  name: "autoimplement",
  input: parseInput,
  title: ({ input }) => `autoimplement: ${input.task.slice(0, 60)}`,
  presentationPrompt:
    "Summarize what was implemented, the review rounds by severity, the CI result, the PR or merge result, and any remaining limitation. Include exact validation commands.",
  startAt: "prepare",
  maxSteps: 240,
  includes: {
    workspace: includeWorkflow(workspacePreparationWorkflow, {
      input: (context): WorkspacePreparationInput => {
        const request = context.input as AutoimplementInput;
        return {
          repository: request.repository,
          ...(request.baseBranch === undefined ? {} : { baseBranch: request.baseBranch }),
          ...(request.scope === undefined ? {} : { scope: request.scope }),
          ...(request.workspaceMode === undefined ? {} : { workspaceMode: request.workspaceMode }),
          ...(request.directDefaultBranchAuthorized === undefined
            ? {}
            : { directDefaultBranchAuthorized: request.directDefaultBranchAuthorized }),
          ...(request.preparedWorkspace === undefined
            ? {}
            : { preparedWorkspace: request.preparedWorkspace }),
        };
      },
    }),
    documentation: includeWorkflow(autodocWorkflow, {
      input: (context): AutodocInput => {
        const request = context.input as AutoimplementInput;
        const discovery = context.outputs.findPlan as ExistingPlanDiscovery | undefined;
        const plan = currentPlan(context);
        if (plan === undefined) throw new Error("autoimplement documentation is missing a plan");
        const documentation = currentDocumentationReceipt(context, plan);
        return {
          task: request.task,
          plan,
          repository: request.repository,
          ...(request.baseBranch !== undefined ? { baseBranch: request.baseBranch } : {}),
          ...(request.scope !== undefined ? { scope: request.scope } : {}),
          ...(request.workspaceMode !== undefined ? { workspaceMode: request.workspaceMode } : {}),
          ...(request.directDefaultBranchAuthorized === undefined
            ? {}
            : { directDefaultBranchAuthorized: request.directDefaultBranchAuthorized }),
          preparedWorkspace: preparedWorkspace(context),
          ...(request.verificationChecks === undefined
            ? {}
            : { verificationChecks: request.verificationChecks }),
          ...(documentation !== undefined ? { documentation } : {}),
          documents:
            request.documents ?? request.documentation?.documents ?? discovery?.documents ?? [],
          evidence: latestIssue(context),
        } as AutodocInput;
      },
    }),
    localVerification: includeWorkflow(changeVerificationWorkflow, {
      input: (context): ChangeVerificationInput => {
        const request = context.input as AutoimplementInput;
        const plan =
          request.verificationChecks === undefined
            ? latestOutput<VerificationCommandPlan>(context, ["planVerification"])
            : { commands: [], untested: [] };
        const implementation = latestOutput<Record<string, unknown>>(context, ["implement"]);
        return {
          originatingWorkflow: "autoimplement",
          qualifiedNode: "autoimplement/localVerification",
          workspace: preparedWorkspace(context),
          checks:
            request.verificationChecks ??
            plan.commands.map((command) => ({
              ...command,
              readOnly: true,
              baseEligible: true,
              changedFileScope: false,
              findingFormat: "text" as const,
            })),
          changedFiles: Array.isArray(implementation.files)
            ? implementation.files.filter((file): file is string => typeof file === "string")
            : [],
          untested: plan.untested,
          plan: currentPlan(context),
          maxConcurrency: concurrency(context).verification,
        };
      },
    }),
    redesign: includeWorkflow(planChangeWorkflow, {
      input: (context): NormalizedPlanChangeInput => {
        const request = context.input as AutoimplementInput;
        const plan = currentPlan(context);
        const documentation =
          plan === undefined ? undefined : currentDocumentationReceipt(context, plan);
        return {
          task: request.task,
          ...(request.scope !== undefined ? { scope: request.scope } : {}),
          ...(request.constraints !== undefined ? { constraints: request.constraints } : {}),
          repository: preparedRepository(context),
          documents: request.documents ?? request.documentation?.documents ?? [],
          ...(plan !== undefined ? { previousPlan: plan } : {}),
          ...(documentation !== undefined ? { documentation } : {}),
          newEvidence: latestIssue(context),
          approval: parsePlanApprovalPolicy(request.approval),
        };
      },
    }),
  },
  exits: {
    completed: {
      from: "finalize",
      validate: (value: unknown): AutoimplementCompleted => value as AutoimplementCompleted,
    },
    blocked: {
      from: "blocked",
      validate: (value: unknown): AutoimplementBlocked => value as AutoimplementBlocked,
    },
  },
  nodes: {
    prepare: compute({
      run: ({ input }) => {
        const request = input as AutoimplementInput;
        const reviewerRuntime = attestReviewerRuntime();
        if (reviewerRuntime.failure !== undefined) {
          return {
            reviewerRuntime,
            route: "blocked",
            status: "blocked",
            task: request.task,
            reason: reviewerRuntime.failure,
            evidence: { reviewerRuntime },
          } satisfies AutoimplementBlocked & {
            route: "blocked";
            reviewerRuntime: ReviewerRuntimeAttestation;
          };
        }
        return {
          reviewerRuntime,
          route: request.plan === undefined ? "find" : "workspace",
        };
      },
    }),
    findPlan: agent({
      statusDetail: "finding existing plan",
      toolPolicy: "observation-only",
      prompt: ({ input }) => {
        const request = input as AutoimplementInput;
        return [
          "Find the clear plan that has already been selected for this task.",
          "Use the current conversation context and referenced canonical documents.",
          "Do not devise, improve, replace, document, or implement a plan.",
          "Return blocked when no single clear existing plan can be found.",
          "Report whether its canonical documentation is current, missing, or stale.",
          `Task: ${boundPromptText(request.task)}`,
          `Repository: ${boundPromptText(request.repository ?? "current repository", MAX_PROMPT_CHARS_SCOPE)}`,
          `Referenced documents: ${projectBoundedJson(request.documents ?? [], MAX_PROMPT_CHARS_DOCUMENTS)}`,
        ].join("\n");
      },
      expectedOutput:
        '{ "route": "found" | "blocked", "plan": {} (required when found), "documentation": "current" | "missing" | "stale" (required when found), "documents": ["canonical file"], "reason": "reason", "evidence": "evidence" }',
      validate: parseExistingPlan,
    }),
    routeFoundPlan: compute({
      run: ({ outputs }) => {
        const discovered = outputs.findPlan as ExistingPlanDiscovery;
        if (discovered.route !== "found" || discovered.plan === undefined) {
          return { route: "blocked", reason: discovered.reason, evidence: discovered.evidence };
        }
        return {
          route: "workspace",
          plan: discovered.plan,
          documentation: discovered.documentation,
          reason: discovered.reason,
          evidence: discovered.evidence,
        };
      },
    }),
    adoptPlan: compute({
      run: ({ outputs }) => {
        const result = includedResult(planChangeWorkflow, outputs.redesign);
        if (result.exit !== "ready") throw new Error("redesign did not return a ready plan");
        return {
          plan: result.output.plan,
          planDigest: result.output.planDigest,
          documents: result.output.documents,
          approval: result.output.approval,
          reason: "The changed plan was documented and passed its approval policy.",
        };
      },
    }),
    routeWorkspace: compute({
      run: (context) => {
        const request = context.input as AutoimplementInput;
        const discovered = context.outputs.findPlan as ExistingPlanDiscovery | undefined;
        return {
          route:
            request.documentation?.status === "current" || discovered?.documentation === "current"
              ? "implement"
              : "document",
          workspace: preparedWorkspace(context),
        };
      },
    }),
    selectVerificationPath: compute({
      run: ({ input }) => ({
        route: (input as AutoimplementInput).verificationChecks === undefined ? "plan" : "verify",
      }),
    }),
    routeVerifiedWorkspace: compute({
      run: (context) => ({
        route:
          preparedWorkspace(context).mode === "defaultBranch" ? "defaultBranch" : "pullRequest",
      }),
    }),
    routeFinalizeDefaultBranchResult: compute({
      run: ({ outputs }) => outputs.finalizeDefaultBranch,
    }),
    finalizeDefaultBranch: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "finalizing default-branch work",
      prompt: (context) => {
        const request = context.input as AutoimplementInput;
        return [
          "Finalize verified work in the explicitly authorized default-branch workspace.",
          ...preparedRepositoryRules(context),
          "Never open a pull request from the default branch to itself.",
          "Commit and push only when the authorized scope explicitly allows each action. Otherwise leave the verified local change and report it.",
          "Do not merge, release, or deploy.",
          `Prepared workspace: ${projectBoundedJson(preparedWorkspace(context))}`,
          `Authorized scope: ${boundPromptText(request.scope ?? request.repository ?? "the current repository and task", MAX_PROMPT_CHARS_SCOPE)}`,
        ].join("\n");
      },
      expectedOutput: `{ "status": "completed" | "blocked", "committed": true | false, "pushed": true | false, "merged": false, "pr": "none", "reportComment": "summary", "reason": "result" }`,
      validate: (value) => {
        const result = requireRecord(value, "default-branch delivery");
        if (result.status !== "completed" && result.status !== "blocked") {
          throw new Error("default-branch delivery status must be completed or blocked");
        }
        if (result.merged !== false || result.pr !== "none") {
          throw new Error("default-branch delivery cannot merge or open a pull request to itself");
        }
        return result;
      },
    }),
    timeoutFallbackGuard: compute({
      run: timeoutFallbackGuard,
    }),
    timeoutFallback: agent({
      timeoutMs: 8 * 60_000,
      toolPolicy: "observation-only",
      statusDetail: "choosing a safe timeout fallback",
      prompt: (context) => {
        const request = context.input as AutoimplementInput;
        const guard = context.outputs.timeoutFallbackGuard;
        const previousFallbacks = context.state.steps
          .filter((step) => step.nodeId === "timeoutFallback" && step.outcome === "ok")
          .map((step) => step.output);
        return [
          "A bounded Autoimplement agent step timed out. Choose the safest existing workflow stage to run next instead of ending the run blindly.",
          "This is a read-only fallback step. Inspect state, but do not edit files, run mutating commands, commit, push, open or update a pull request, post comments, merge, deploy, or release.",
          "Inspect the current repository worktree, branch, diff, and commits. Inspect the remote branch, pull request, review, CI, merge, and final report when they exist and affect the next route.",
          "Do not assume that the timed-out step failed or completed. Use accepted workflow outputs and durable repository or pull-request state.",
          "Before any forward route, confirm that its accepted output belongs to the current work attempt and that observed local and remote heads match the accepted publication. Otherwise retry, replan, or block.",
          "Choose retry only when the timed-out stage must run again. Choose verify when accepted implementation output exists and verification is next. Choose review when accepted publication output exists. Choose ci only after comment inspection routed to CI. Choose deliver only after CI is green or classified unrelated. Choose replan when evidence invalidates the approved plan. Choose blocked only when no safe route exists.",
          "Do not skip required implementation, verification, review, CI, authorization, or delivery checks.",
          `Task: ${boundPromptText(request.task)}`,
          `Approved plan: ${projectBoundedJson(currentPlan(context), MAX_PROMPT_CHARS_PLAN)}`,
          `Authorized scope: ${boundPromptText(request.scope ?? request.repository ?? "the current repository and task", MAX_PROMPT_CHARS_SCOPE)}`,
          `Timeout: ${projectBoundedJson(guard)}`,
          `Previous fallback results: ${projectBoundedJson(previousFallbacks)}`,
          `Recent workflow attempts: ${projectBoundedJson(recentWorkflowAttempts(context), MAX_PROMPT_CHARS_ATTEMPTS)}`,
        ].join("\n");
      },
      expectedOutput: `{ "route": "retry" | "verify" | "review" | "ci" | "deliver" | "replan" | "blocked", "reason": "why this is the safest next stage", "evidence": ["state inspected before choosing the route"] }`,
      validate: parseTimeoutFallback,
    }),
    routeTimeoutFallback: compute({
      run: timeoutFallbackTarget,
    }),
    propagateSupportedFailure: compute({
      run: throwLatestSupportedFailure,
    }),
    routeVerifyP2Result: compute({
      run: ({ outputs }) => outputs.verifyP2,
    }),
    routeInspectCommentsResult: compute({
      run: ({ outputs }) => outputs.inspectComments,
    }),
    routeInspectCiResult: compute({
      run: ({ outputs }) => outputs.inspectCi,
    }),
    routeFinalizeDeliveryResult: compute({
      run: ({ outputs }) => outputs.finalizeDelivery,
    }),
    implement: agent({
      timeoutMs: 8 * 60 * 60_000,
      statusDetail: "implementing",
      prompt: (context) => {
        const request = context.input as AutoimplementInput;
        return [
          `Implement this task end-to-end: ${boundPromptText(request.task)}`,
          ...preparedRepositoryRules(context),
          `Plan: ${projectBoundedJson(currentPlan(context), MAX_PROMPT_CHARS_PLAN)}`,
          `Authorized scope: ${boundPromptText(request.scope ?? request.repository ?? "the current repository and task", MAX_PROMPT_CHARS_SCOPE)}`,
          `Constraints: ${projectBoundedJson(request.constraints ?? [], MAX_PROMPT_CHARS_CONSTRAINTS)}`,
          "Before changing files, inspect the current worktree, diff, commits, branch, remote state, and matching pull request. Continue existing work and do not repeat completed effects.",
          "Follow repository instructions and use the most elegant long-term production-ready implementation without unnecessary work.",
          "If implementation exposes a new design or scope problem, report it precisely instead of forcing the old plan.",
          "Report the prepared repository as the only changed repository so independent verification retains authoritative provenance.",
          "Do not merge yet.",
        ].join("\n");
      },
      expectedOutput: `{ "status": "implemented" | "issue" | "blocked", "summary": "work completed or issue", "files": ["changed file"], "repositories": ["absolute repository path changed"], "issueKind": "design" | "implementation" | null, "evidence": "new evidence" }`,
      validate: parseImplementationForContext,
    }),
    classifyImplementation: agent({
      statusDetail: "assessing implementation",
      toolPolicy: "observation-only",
      prompt: ({ outputs }) =>
        [
          "Assess the implementation result.",
          "Choose verify when implementation is ready for tests.",
          "Choose redesign when new evidence invalidates the plan.",
          "Choose fix for a local implementation issue that does not change the plan.",
          "Choose blocked only for a material issue outside the authorized scope.",
          `Implementation: ${projectBoundedJson(outputs.implement)}`,
        ].join("\n"),
      expectedOutput: `{ "route": "verify" | "redesign" | "fix" | "blocked", "summary": "reason", "evidence": "evidence" }`,
      validate: (value) =>
        parseRoute(
          value,
          ["verify", "redesign", "fix", "blocked"] as const,
          "implementation assessment",
        ),
    }),
    challengeBlockerGuard: compute({
      run: (context) => {
        const challenges = blockerChallenges(context);
        let origin: BlockerOrigin;
        try {
          origin = blockerOrigin(context);
        } catch (error) {
          return {
            route: "blocked",
            reason: error instanceof Error ? error.message : "No safe blocker recovery exists.",
            evidence: { previousNode: context.state.steps.at(-1)?.nodeId ?? null },
          };
        }
        return challenges.length >= MAX_BLOCKER_CHALLENGES
          ? {
              route: "blocked",
              origin,
              reason: `Blocker challenge reached the ${MAX_BLOCKER_CHALLENGES}-attempt workflow safety limit.`,
              evidence: { attempts: challenges.length, challenges },
            }
          : {
              route: "challenge",
              origin,
              recoveries: BLOCKER_RECOVERIES[origin],
              attempt: challenges.length + 1,
              limit: MAX_BLOCKER_CHALLENGES,
            };
      },
    }),
    challengeBlocker: agent({
      statusDetail: "challenging blocker claim",
      prompt: (context) => {
        const request = context.input as AutoimplementInput;
        const guard = requireRecord(
          context.outputs.challengeBlockerGuard,
          "blocker challenge guard",
        );
        return [
          "Independently challenge the latest claim that autoimplement is blocked.",
          "Are you really blocked? Is this really a blocker right now? Can you find a safe way to move forward and finish this?",
          "Inspect the task, approved plan, current result, evidence, scope, authority, previous attempts, and viable alternatives.",
          "Confirm blocked only when the issue blocks progress now, is outside authority, and has no safe practical path forward.",
          "For continue, preserve the exact blocker origin and choose only one listed recovery. No recovery may skip implementation, verification, publication, review, comment, CI, or delivery gates.",
          "Return continue with the next practical action when work can proceed. Keep text concise, with at most five alternatives and five evidence items.",
          `Blocker origin: ${String(guard.origin)}`,
          `Allowed recoveries: ${projectBoundedJson(guard.recoveries)}`,
          `Task: ${boundPromptText(request.task)}`,
          `Approved plan: ${projectBoundedJson(currentPlan(context), MAX_PROMPT_CHARS_PLAN)}`,
          `Current result and claimed blocker: ${projectBoundedJson(latestBlockerClaim(context), MAX_PROMPT_CHARS_ISSUE)}`,
          `Authorized scope: ${boundPromptText(request.scope ?? request.repository ?? "the current repository and task", MAX_PROMPT_CHARS_SCOPE)}`,
          `Constraints and authority: ${projectBoundedJson(request.constraints ?? [], MAX_PROMPT_CHARS_CONSTRAINTS)}`,
          `Merge authorized: ${request.merge === true}`,
          `Previous blocker challenges: ${projectBoundedJson(blockerChallenges(context), MAX_PROMPT_CHARS_ISSUE)}`,
          `Recent workflow attempts: ${projectBoundedJson(recentWorkflowAttempts(context), MAX_PROMPT_CHARS_ATTEMPTS)}`,
        ].join("\n");
      },
      expectedOutput: `{ "route": "continue" | "blocked", "origin": "exact guarded origin", "recovery": "one allowed recovery", "blockingNow": true | false, "outsideAuthority": true | false, "canProceed": true | false, "reason": "concise reason", "nextAction": "practical action or empty when blocked", "alternativesChecked": ["checked alternative"], "evidence": ["concrete evidence"] }`,
      validate: parseBlockerChallenge,
    }),
    routeBlockerRecovery: compute({
      run: ({ outputs }) => {
        const challenge = outputs.challengeBlocker as BlockerChallenge;
        return { route: challenge.recovery, origin: challenge.origin };
      },
    }),
    planVerification: agent({
      timeoutMs: 15 * 60_000,
      statusDetail: "planning independent verification commands",
      prompt: (context) =>
        [
          "Select the required local verification commands for the current authorized implementation changes.",
          "Return every required command with the prepared repository as cwd; multiple commands may share that cwd.",
          ...preparedRepositoryRules(context),
          `Implementation provenance: ${projectBoundedJson(latestOutput(context, ["implement"]), MAX_PROMPT_CHARS_PLAN)}`,
          "Use exact executables and argument arrays without shell wrappers, environment overrides, stdin, Git or GitHub mutations, package publication, deployment, merge, or release commands.",
          "Use the prepared absolute repository path, explicit timeouts no longer than 2700000ms, and maxOutputChars no larger than 1000000.",
          "List checks that cannot run locally under untested.",
          `Prepared workspace: ${projectBoundedJson(preparedWorkspace(context))}`,
        ].join("\n"),
      expectedOutput: `{ "commands": [{ "id": "stable-id", "command": "npm", "args": ["run", "check"], "cwd": "/absolute/repository", "timeoutMs": 2700000, "maxOutputChars": 1000000 }], "untested": ["remaining check"] }`,
      validate: parseVerificationForContext,
    }),
    fix: agent({
      timeoutMs: 45 * 60_000,
      statusDetail: "fixing",
      prompt: (context) =>
        [
          "Fix the current implementation issue without expanding the approved design.",
          ...preparedRepositoryRules(context),
          "Inspect the current diff and commits first. Continue any partial fix and change only work that is still missing.",
          `Issue: ${projectBoundedJson(latestIssue(context), MAX_PROMPT_CHARS_ISSUE)}`,
          `Current plan: ${projectBoundedJson(currentPlan(context), MAX_PROMPT_CHARS_PLAN)}`,
          "Stop after the fix so verification can run again.",
        ].join("\n"),
      expectedOutput: `{ "fixed": "what changed", "files": ["changed file"] }`,
      validate: (value) => requireRecord(value, "fix result"),
    }),
    publish: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "committing and pushing",
      prompt: (context) => {
        const request = context.input as AutoimplementInput;
        return [
          "Commit and push the verified implementation before review.",
          ...preparedRepositoryRules(context),
          "Inspect the branch, local and remote heads, and matching pull requests first. Do not push an already-pushed head or create a second pull request for the same branch and base.",
          "Use the existing implementation-plan PR when one exists. Otherwise open a PR and use the pr-description skill for its body.",
          "Inspect the complete public diff before every push or PR mutation.",
          "Publish only from the prepared repository and report its exact absolute path, branch, validated plain base ref, immutable base commit hash, immutable pushed head commit hash, and PR URL. Resolve both revisions to full object ids; never report HEAD or another symbolic ref.",
          "Include dependencyFingerprint only when a declared dependency result is relevant to review reuse.",
          `Requested base branch: ${boundPromptText(request.baseBranch ?? "discover each repository default branch", MAX_PROMPT_CHARS_SCOPE)}.`,
          "Do not merge yet.",
        ].join("\n");
      },
      expectedOutput: `{ "repositories": [{ "repository": "/absolute/repository", "branch": "branch", "baseBranch": "base", "baseRevision": "full immutable commit hash", "headRevision": "full immutable commit hash", "pr": "URL", "pushed": true, "dependencyFingerprint": "optional digest" }] }`,
      validate: parsePublishedForContext,
    }),
    selectReviewCommands: compute({
      run: selectReviewCommands,
    }),
    runReview: action({
      statusDetail: "running omp-reviewer commands",
      timeoutMs: (context) => {
        const selected = latestOutput<ReviewCommandSelection>(context, ["selectReviewCommands"]);
        return commandBatchTimeoutMs(selected.commands, concurrency(context).reviewer);
      },
      run: async (context): Promise<BatchExecution> => {
        const selected = latestOutput<ReviewCommandSelection>(context, ["selectReviewCommands"]);
        const attestationFailure = reviewerAttestationFailureReason(selected);
        if (attestationFailure !== undefined) {
          const batch = reviewerAttestationFailureBatch(selected, attestationFailure);
          return reviewRepairAttempted(context)
            ? { route: "blocked", batch, reason: attestationFailure }
            : { route: "repair", batch, reason: attestationFailure };
        }
        const batch = await runAutoimplementBatch(
          context,
          "review",
          selected.commands,
          concurrency(context).reviewer,
          reviewerBatchTrust(selected),
        );
        if (!reviewBatchNeedsRepair(batch)) return { route: "assess", batch };
        return reviewRepairAttempted(context)
          ? {
              route: "blocked",
              batch,
              reason: "omp-reviewer failed again after one reviewer repair attempt.",
            }
          : { route: "repair", batch };
      },
    }),
    repairReviewCommand: agent({
      statusDetail: "repairing reviewer prerequisites",
      prompt: (context) =>
        [
          "One or more omp-reviewer commands failed, timed out, or returned truncated output.",
          ...preparedRepositoryRules(context),
          "Diagnose and fix only local reviewer prerequisites or configuration that are in scope.",
          "Do not change the deterministic executable, base branch, or repository command shape, and do not substitute another reviewer.",
          "The retry will use only the absolute reviewer executable attested before this repair; PATH changes and replacement binaries are rejected.",
          "Choose retry only when the same commands can now produce complete reviews. Choose blocked when omp-reviewer or required configuration remains unavailable.",
          `Failed batch: ${projectBoundedJson(context.outputs.runReview)}`,
        ].join("\n"),
      expectedOutput: `{ "route": "retry" | "blocked", "reason": "diagnosis and action" }`,
      validate: (value, context) => {
        const result = parseRoute(value, ["retry", "blocked"] as const, "reviewer command repair");
        if (result.route !== "retry") return result;
        const selected = latestOutput<ReviewCommandSelection>(context, ["selectReviewCommands"]);
        const attestationFailure = reviewerAttestationFailureReason(selected);
        if (attestationFailure === undefined) return result;
        return {
          ...result,
          route: "blocked" as const,
          reason: attestationFailure,
        };
      },
    }),
    assessReview: agent({
      statusDetail: "assessing reviewer findings",
      toolPolicy: "observation-only",
      prompt: (context) => {
        const selected = latestOutput<ReviewCommandSelection>(context, ["selectReviewCommands"]);
        const execution = latestOutput<BatchExecution>(context, ["runReview"]);
        return [
          "Assess each completed omp-reviewer result separately.",
          "Return one repository entry for every selected command, using the exact repository id.",
          "Set invocationSucceeded false when a complete valid review was not produced.",
          "Record every finding under P0, P1, P2, or lower and mark it as design or implementation.",
          "Do not promote P2 findings to P1 merely to force another review round.",
          `Selected repositories: ${projectBoundedJson(selected.repositories, MAX_PROMPT_CHARS_PLAN)}`,
          `Reviewer results: ${projectBoundedJson(execution.batch, MAX_PROMPT_CHARS_BATCH)}`,
        ].join("\n");
      },
      expectedOutput: `{ "repositories": [{ "id": "repository-id", "invocationSucceeded": true | false, "p0": [{ "kind": "design" | "implementation", "summary": "finding" }], "p1": [], "p2": [], "lower": [], "reason": "assessment" }], "reason": "batch assessment" }`,
      validate: parseReviewAssessment,
    }),
    recoverReviewAssessment: agent({
      timeoutMs: 8 * 60_000,
      toolPolicy: "observation-only",
      statusDetail: "recovering reviewer assessment",
      prompt: (context) => {
        const selected = latestOutput<ReviewCommandSelection>(context, ["selectReviewCommands"]);
        const execution = latestOutput<BatchExecution>(context, ["runReview"]);
        return [
          "The first reviewer assessment timed out. Reassess the persisted completed batch once without invoking omp-reviewer or running any commands.",
          "Return one repository entry for every selected command, using the exact repository id.",
          "Set invocationSucceeded false when a complete valid review was not produced.",
          "Record every finding under P0, P1, P2, or lower and mark it as design or implementation.",
          "Do not promote P2 findings to P1 merely to force another review round.",
          `Selected repositories: ${projectBoundedJson(selected.repositories, MAX_PROMPT_CHARS_PLAN)}`,
          `Persisted reviewer results: ${projectBoundedJson(execution.batch, MAX_PROMPT_CHARS_BATCH)}`,
        ].join("\n");
      },
      expectedOutput: `{ "repositories": [{ "id": "repository-id", "invocationSucceeded": true | false, "p0": [{ "kind": "design" | "implementation", "summary": "finding" }], "p1": [], "p2": [], "lower": [], "reason": "assessment" }], "reason": "batch assessment" }`,
      validate: parseReviewAssessment,
    }),
    reviewAssessmentRecoveryBlocked: compute({
      run: () => ({
        reason:
          "Reviewer commands completed, but both the primary and bounded recovery assessments timed out.",
        evidence: { reviewerRerun: false, assessmentsTimedOut: 2 },
      }),
    }),
    routeReviewAssessment: compute({
      run: (context) => currentReviewAssessment(context),
    }),
    triageReview: compute({
      run: (context) => {
        const review = currentReviewAssessment(context);
        const critical = [...review.p0, ...review.p1];
        return {
          route: critical.some((finding) => finding.kind === "design") ? "redesign" : "fix",
          summary: `${critical.length} P0/P1 finding(s) require changes`,
          evidence: critical,
        };
      },
    }),
    addressP2: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "addressing P2 findings",
      prompt: (context) =>
        [
          "Address valid P2 findings from the last review when the improvement is proportionate and in scope.",
          ...preparedRepositoryRules(context),
          "Inspect the current diff and commits first. Do not repeat a P2 change that is already present.",
          "Do not rerun omp-reviewer solely because P2 work changes files. Verification will run once, then the workflow continues.",
          `Review: ${projectBoundedJson(currentReviewAssessment(context), MAX_PROMPT_CHARS_REVIEW)}`,
        ].join("\n"),
      expectedOutput: `{ "addressed": ["P2 change"], "skipped": [{ "finding": "finding", "reason": "why" }] }`,
      validate: (value) => requireRecord(value, "P2 result"),
    }),
    verifyP2: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "verifying P2 changes",
      prompt: (context) =>
        [
          "Run focused verification for the P2 changes and push the verified result.",
          ...preparedRepositoryRules(context),
          "Inspect the local and remote heads first. Do not push again when the verified head is already remote.",
          "Do not run omp-reviewer again because the previous round had no P0 or P1 findings.",
          "Re-observe every published PR after the push and return its current repository, branch, base branch, full immutable base and head commit hashes, PR URL, pushed status, and unchanged dependency fingerprint.",
          "Report exact commands and outcomes.",
        ].join("\n"),
      expectedOutput: `{ "passed": true | false, "commands": [{ "command": "command", "outcome": "result" }], "pushed": true, "repositories": [{ "repository": "/absolute/repository", "branch": "branch", "baseBranch": "base", "baseRevision": "full immutable base commit hash", "headRevision": "full immutable pushed commit hash", "pr": "URL", "pushed": true, "dependencyFingerprint": "optional fingerprint" }] }`,
      validate: parseP2Verification,
    }),
    inspectComments: agent({
      timeoutMs: 20 * 60_000,
      statusDetail: "checking PR comments",
      prompt: (context) =>
        [
          "Inspect current inline review comments and PR issue comments for every published pull request.",
          "Handle pull requests one at a time. Reply to and resolve every comment. Ignore stale or irrelevant comments only after explaining why.",
          "Choose redesign for a valid design issue, fix for a local code issue, ci when no actionable comment remains on any PR, or blocked for an external blocker.",
          `Published repositories: ${publishedRepositoryReferences(context)}`,
        ].join("\n"),
      expectedOutput: `{ "route": "redesign" | "fix" | "ci" | "blocked", "summary": "comment status", "evidence": ["comment or response"] }`,
      validate: (value) =>
        parseRoute(value, ["redesign", "fix", "ci", "blocked"] as const, "PR comment assessment"),
    }),
    inspectCi: agent({
      timeoutMs: 10 * 60_000,
      toolPolicy: "observation-only",
      statusDetail: "checking CI",
      prompt: (context) =>
        [
          "Inspect every published pull request once without waiting for completion.",
          "Return one target per exact published repository id. The workflow derives and validates repository paths, heads, and PR URLs from that id.",
          "Choose green, failed, pending, or unavailable for each target.",
          "When pending, provide an exact supported gh pr checks --watch or gh run watch command with timeoutMs at most 300000 and maxOutputChars at most 1000000. The workflow binds its id, cwd, and PR before execution.",
          "Separate failures caused by this change from unrelated failures. Do not invent an ETA.",
          `Published repositories: ${publishedRepositoryReferences(context)}`,
        ].join("\n"),
      expectedOutput: `{ "targets": [{ "id": "repository-id", "route": "green" | "failed" | "pending" | "unavailable", "reason": "status", "relatedFailures": ["failure"], "unrelatedFailures": ["failure"], "trackingCommand": { "command": "gh", "args": ["pr", "checks", "PR URL", "--watch"], "timeoutMs": 300000, "maxOutputChars": 1000000 } }] }`,
      validate: parseCiInspectionForPublished,
    }),
    trackCi: action({
      statusDetail: "tracking pending CI commands",
      timeoutMs: (context) => {
        const inspected = latestOutput<CiInspectionBatch>(context, ["inspectCi"]);
        const commands = inspected.targets.flatMap((target) =>
          target.trackingCommand === undefined ? [] : [target.trackingCommand],
        );
        return commandBatchTimeoutMs(commands, concurrency(context).ciWatch);
      },
      run: async (context): Promise<BatchExecution> => {
        const inspected = latestOutput<CiInspectionBatch>(context, ["inspectCi"]);
        const commands = inspected.targets.flatMap((target) =>
          target.trackingCommand === undefined ? [] : [target.trackingCommand],
        );
        const batch = await runAutoimplementBatch(
          context,
          "ciWatch",
          commands,
          concurrency(context).ciWatch,
        );
        const needsRepair = batch.items.some(
          (item) =>
            (item.outcome === "failed" && item.exitCode === null) ||
            item.stdoutTruncated ||
            item.stderrTruncated,
        );
        return { route: needsRepair ? "repair" : "assess", batch };
      },
    }),
    repairCiCommand: agent({
      statusDetail: "repairing CI watch prerequisites",
      prompt: (context) =>
        [
          "One or more supported CI watch commands failed or returned truncated output.",
          ...preparedRepositoryRules(context),
          "Diagnose and fix only local gh prerequisites or authentication that are already authorized.",
          "Do not change the PR identity or substitute another command form.",
          "Choose retry only when the same validated commands can now provide useful status. Choose blocked otherwise.",
          `Failure: ${projectBoundedJson(context.outputs.trackCi)}`,
        ].join("\n"),
      expectedOutput: `{ "route": "retry" | "blocked", "reason": "diagnosis" }`,
      validate: (value) => parseRoute(value, ["retry", "blocked"] as const, "CI command repair"),
    }),
    assessTrackedCi: agent({
      statusDetail: "assessing tracked CI",
      toolPolicy: "observation-only",
      prompt: (context) => {
        const inspected = latestOutput<CiInspectionBatch>(context, ["inspectCi"]);
        const execution = latestOutput<BatchExecution>(context, ["trackCi"]);
        return [
          "Assess every CI watch result without starting another wait.",
          "Return one target result for every watched PR and an aggregate route of green, failed, pending, or unavailable.",
          "A timed-out watch normally remains pending. Separate related from unrelated failures. Do not invent an ETA.",
          `Initial inspection: ${projectBoundedJson(inspected)}`,
          `Tracking results: ${projectBoundedJson(execution.batch)}`,
        ].join("\n");
      },
      expectedOutput: `{ "route": "green" | "failed" | "pending" | "unavailable", "reason": "status", "targets": [{ "id": "repository-id", "route": "green" | "failed" | "pending" | "unavailable", "reason": "status" }], "relatedFailures": ["failure"], "unrelatedFailures": ["failure"] }`,
      validate: parseTrackedCiAssessment,
    }),
    opportunisticTest: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "using CI wait for more testing",
      prompt: (context) =>
        [
          "CI has remained pending for about five minutes.",
          ...preparedRepositoryRules(context),
          "Do not spend this model turn waiting for CI.",
          "Run additional useful local tests, smoke tests, or targeted checks that were not covered earlier.",
          "If no further useful test exists, say so plainly. Then stop so the workflow can inspect CI again.",
        ].join("\n"),
      expectedOutput: `{ "performed": [{ "command": "exact command", "outcome": "result" }], "furtherUsefulTests": true | false, "summary": "what was learned" }`,
      validate: (value) => requireRecord(value, "opportunistic test result"),
    }),
    classifyCi: agent({
      statusDetail: "classifying CI failures",
      toolPolicy: "observation-only",
      prompt: (context) =>
        [
          "Classify the current CI failure.",
          "Choose redesign when it invalidates the plan, fix for a related local issue, unrelated when the failures are demonstrably outside this change, or blocked when required CI cannot be verified.",
          `CI: ${projectBoundedJson(latestOutput(context, ["inspectCi", "assessTrackedCi"]))}`,
        ].join("\n"),
      expectedOutput: `{ "route": "redesign" | "fix" | "unrelated" | "blocked", "reason": "classification", "evidence": ["failure"] }`,
      validate: (value) =>
        parseRoute(
          value,
          ["redesign", "fix", "unrelated", "blocked"] as const,
          "CI classification",
        ),
    }),
    finalizeDelivery: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "finalizing PRs",
      prompt: (context) => {
        const request = context.input as AutoimplementInput;
        return [
          request.merge === false
            ? "Leave every verified PR ready without merging because input disabled merge."
            : "Handle verified PRs one at a time and merge each unless repository policy or explicit user instructions prohibit it.",
          "Before each mutation, inspect the current PR head, merge state, and existing final report. Do not merge an already merged expected head or post a duplicate report.",
          "Use each repository's required merge method.",
          "Post a final report with the implementation summary and exact validation commands on every PR only when that report is missing.",
          "Return top-level merged, reportComment, and reason fields. For several PRs, use the first result for the top-level compatibility fields and include every result under repositories.",
          "Key every repository result by exact published id. The workflow derives repository paths and PR URLs before persisting the result.",
          "Return blocked instead of claiming completion when a required merge or report action fails.",
          `Published repositories: ${publishedRepositoryReferences(context)}`,
        ].join("\n");
      },
      expectedOutput: `{ "status": "completed" | "blocked", "merged": true | false, "reportComment": "first report URL or summary", "reason": "aggregate result", "repositories": [{ "id": "repository-id", "merged": true | false, "reportComment": "URL or summary", "reason": "result" }] }`,
      validate: parseDeliveryResult,
    }),
    blocked: compute({
      run: (context) => {
        const request = context.input as AutoimplementInput;
        const blocked = latestBlockedReason(context);
        return {
          status: "blocked",
          task: request.task,
          reason: blocked.reason,
          evidence: blocked.evidence,
        } satisfies AutoimplementBlocked;
      },
    }),
    finalize: compute({
      run: (context) => {
        const request = context.input as AutoimplementInput;
        return {
          status: "completed",
          task: request.task,
          plan: currentPlan(context),
          implementation: latestOutput(context, ["implement"]),
          verification:
            context.outputs.localVerification === undefined
              ? latestOutput(context, ["verifyP2"])
              : includedResult(changeVerificationWorkflow, context.outputs.localVerification)
                  .output,
          reviewRounds:
            context.outputs.finalizeDefaultBranch === undefined
              ? reviewRoundsForOutput(context)
              : [],
          ci:
            context.outputs.finalizeDefaultBranch === undefined
              ? ciForOutput(context)
              : {
                  route: "notApplicable",
                  reason: "Direct default-branch work has no pull request.",
                },
          delivery: latestOutput(context, ["finalizeDefaultBranch", "finalizeDelivery"]),
        } satisfies AutoimplementCompleted;
      },
    }),
  },
  edges: [
    {
      from: "prepare",
      switch: {
        on: "$.route",
        cases: {
          find: "findPlan",
          workspace: "workspace",
          blocked: "blocked",
        },
      },
    },
    {
      from: "findPlan",
      switch: { on: "$.route", cases: { found: "routeFoundPlan", blocked: "blocked" } },
    },
    {
      from: "routeFoundPlan",
      switch: {
        on: "$.route",
        cases: { workspace: "workspace", blocked: "blocked" },
      },
    },
    { from: "redesign.ready", to: "adoptPlan" },
    { from: "redesign.blocked", to: "blocked" },
    { from: "adoptPlan", to: "implement" },
    { from: "workspace.ready", to: "routeWorkspace" },
    { from: "workspace.blocked", to: "blocked" },
    {
      from: "routeWorkspace",
      switch: { on: "$.route", cases: { implement: "implement", document: "documentation" } },
    },
    { from: "documentation.ready", to: "implement" },
    { from: "documentation.blocked", to: "blocked" },
    {
      from: "timeoutFallbackGuard",
      switch: { on: "$.route", cases: { recover: "timeoutFallback", blocked: "blocked" } },
    },
    { from: "timeoutFallback", to: "routeTimeoutFallback" },
    { from: "propagateSupportedFailure", to: "blocked" },
    {
      from: "routeTimeoutFallback",
      switch: {
        on: "$.route",
        cases: {
          implement: "implement",
          planVerification: "planVerification",
          selectVerificationPath: "selectVerificationPath",
          fix: "fix",
          publish: "publish",
          addressP2: "addressP2",
          verifyP2: "verifyP2",
          inspectComments: "inspectComments",
          inspectCi: "inspectCi",
          opportunisticTest: "opportunisticTest",
          finalizeDefaultBranch: "finalizeDefaultBranch",
          finalizeDelivery: "finalizeDelivery",
          selectReviewCommands: "selectReviewCommands",
          redesign: "redesign",
          blocked: "blocked",
        },
      },
    },
    {
      from: "implement",
      switch: {
        on: "$result.outcome",
        cases: {
          ok: "classifyImplementation",
          timed_out: "timeoutFallbackGuard",
          failed: "propagateSupportedFailure",
        },
      },
    },
    {
      from: "classifyImplementation",
      switch: {
        on: "$.route",
        cases: {
          verify: "selectVerificationPath",
          redesign: "redesign",
          fix: "fix",
          blocked: "challengeBlockerGuard",
        },
      },
    },
    {
      from: "challengeBlockerGuard",
      switch: { on: "$.route", cases: { challenge: "challengeBlocker", blocked: "blocked" } },
    },
    {
      from: "challengeBlocker",
      switch: { on: "$.route", cases: { continue: "routeBlockerRecovery", blocked: "blocked" } },
    },
    {
      from: "routeBlockerRecovery",
      switch: {
        on: "$.route",
        cases: {
          redesign: "redesign",
          fix: "fix",
          planVerification: "planVerification",
          repairReviewCommand: "repairReviewCommand",
          selectReviewCommands: "selectReviewCommands",
          inspectComments: "inspectComments",
          inspectCi: "inspectCi",
          opportunisticTest: "opportunisticTest",
          finalizeDefaultBranch: "finalizeDefaultBranch",
        },
      },
    },
    {
      from: "selectVerificationPath",
      switch: { on: "$.route", cases: { plan: "planVerification", verify: "localVerification" } },
    },
    {
      from: "planVerification",
      switch: {
        on: "$result.outcome",
        cases: {
          ok: "localVerification",
          timed_out: "timeoutFallbackGuard",
          failed: "propagateSupportedFailure",
        },
      },
    },
    { from: "localVerification.ready", to: "routeVerifiedWorkspace" },
    { from: "localVerification.blocked", to: "challengeBlockerGuard" },
    {
      from: "routeVerifiedWorkspace",
      switch: {
        on: "$.route",
        cases: { pullRequest: "publish", defaultBranch: "finalizeDefaultBranch" },
      },
    },
    {
      from: "finalizeDefaultBranch",
      switch: {
        on: "$result.outcome",
        cases: {
          ok: "routeFinalizeDefaultBranchResult",
          timed_out: "timeoutFallbackGuard",
          failed: "propagateSupportedFailure",
        },
      },
    },
    {
      from: "routeFinalizeDefaultBranchResult",
      switch: {
        on: "$.status",
        cases: { completed: "finalize", blocked: "challengeBlockerGuard" },
      },
    },
    {
      from: "fix",
      switch: {
        on: "$result.outcome",
        cases: {
          ok: "selectVerificationPath",
          timed_out: "timeoutFallbackGuard",
          failed: "propagateSupportedFailure",
        },
      },
    },
    {
      from: "publish",
      switch: {
        on: "$result.outcome",
        cases: {
          ok: "selectReviewCommands",
          timed_out: "timeoutFallbackGuard",
          failed: "propagateSupportedFailure",
        },
      },
    },
    {
      from: "selectReviewCommands",
      switch: { on: "$.route", cases: { run: "runReview", reuse: "inspectComments" } },
    },
    {
      from: "runReview",
      switch: {
        on: "$.route",
        cases: {
          assess: "assessReview",
          repair: "repairReviewCommand",
          blocked: "blocked",
        },
      },
    },
    {
      from: "repairReviewCommand",
      switch: {
        on: "$.route",
        cases: { retry: "runReview", blocked: "blocked" },
      },
    },
    {
      from: "assessReview",
      switch: {
        on: "$result.outcome",
        cases: {
          ok: "routeReviewAssessment",
          timed_out: "recoverReviewAssessment",
          failed: "propagateSupportedFailure",
        },
      },
    },
    {
      from: "recoverReviewAssessment",
      switch: {
        on: "$result.outcome",
        cases: {
          ok: "routeReviewAssessment",
          timed_out: "reviewAssessmentRecoveryBlocked",
          failed: "propagateSupportedFailure",
        },
      },
    },
    { from: "reviewAssessmentRecoveryBlocked", to: "blocked" },
    {
      from: "routeReviewAssessment",
      switch: {
        on: "$.route",
        cases: {
          command_error: "repairReviewCommand",
          blocked: "blocked",
          critical: "triageReview",
          p2: "addressP2",
          clean: "inspectComments",
        },
      },
    },
    {
      from: "triageReview",
      switch: { on: "$.route", cases: { redesign: "redesign", fix: "fix" } },
    },
    {
      from: "addressP2",
      switch: {
        on: "$result.outcome",
        cases: {
          ok: "verifyP2",
          timed_out: "timeoutFallbackGuard",
          failed: "propagateSupportedFailure",
        },
      },
    },
    {
      from: "verifyP2",
      switch: {
        on: "$result.outcome",
        cases: {
          ok: "routeVerifyP2Result",
          timed_out: "timeoutFallbackGuard",
          failed: "propagateSupportedFailure",
        },
      },
    },
    {
      from: "routeVerifyP2Result",
      switch: { on: "$.passed", cases: { true: "inspectComments", false: "fix" } },
    },
    {
      from: "inspectComments",
      switch: {
        on: "$result.outcome",
        cases: {
          ok: "routeInspectCommentsResult",
          timed_out: "timeoutFallbackGuard",
          failed: "propagateSupportedFailure",
        },
      },
    },
    {
      from: "routeInspectCommentsResult",
      switch: {
        on: "$.route",
        cases: {
          redesign: "redesign",
          fix: "fix",
          ci: "inspectCi",
          blocked: "challengeBlockerGuard",
        },
      },
    },
    {
      from: "inspectCi",
      switch: {
        on: "$result.outcome",
        cases: {
          ok: "routeInspectCiResult",
          timed_out: "timeoutFallbackGuard",
          failed: "propagateSupportedFailure",
        },
      },
    },
    {
      from: "routeInspectCiResult",
      switch: {
        on: "$.route",
        cases: {
          green: "finalizeDelivery",
          failed: "classifyCi",
          pending: "trackCi",
          unavailable: "challengeBlockerGuard",
        },
      },
    },
    {
      from: "trackCi",
      switch: { on: "$.route", cases: { assess: "assessTrackedCi", repair: "repairCiCommand" } },
    },
    {
      from: "repairCiCommand",
      switch: {
        on: "$.route",
        cases: { retry: "trackCi", blocked: "challengeBlockerGuard" },
      },
    },
    {
      from: "assessTrackedCi",
      switch: {
        on: "$.route",
        cases: {
          green: "finalizeDelivery",
          failed: "classifyCi",
          pending: "opportunisticTest",
          unavailable: "challengeBlockerGuard",
        },
      },
    },
    {
      from: "opportunisticTest",
      switch: {
        on: "$result.outcome",
        cases: {
          ok: "inspectCi",
          timed_out: "timeoutFallbackGuard",
          failed: "propagateSupportedFailure",
        },
      },
    },
    {
      from: "classifyCi",
      switch: {
        on: "$.route",
        cases: {
          redesign: "redesign",
          fix: "fix",
          unrelated: "finalizeDelivery",
          blocked: "challengeBlockerGuard",
        },
      },
    },
    {
      from: "finalizeDelivery",
      switch: {
        on: "$result.outcome",
        cases: {
          ok: "routeFinalizeDeliveryResult",
          timed_out: "timeoutFallbackGuard",
          failed: "propagateSupportedFailure",
        },
      },
    },
    {
      from: "routeFinalizeDeliveryResult",
      switch: {
        on: "$.status",
        cases: { completed: "finalize", blocked: "challengeBlockerGuard" },
      },
    },
  ],
});

export default autoimplementWorkflow;
