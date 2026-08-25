#!/usr/bin/env node
import fs, { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SqliteControllerStore } from "../controllers/sqlite.js";
import { projectControllerStoreBaseDir } from "../controllers/store.js";
import { syncHerdrPlugin } from "../herdr/setup.js";
import { readHostStatus, type HostStatus } from "../host/ownership.js";
import {
  installHostService,
  restartHostService,
  startHostService,
  stopHostService,
  uninstallHostService,
} from "../host/service.js";
import { sanitizeText } from "../render/ansi.js";
import { validateHumanDecisionRequestIntegrity } from "../workflows/decision-presentation.js";
import { HumanDecisionStore } from "../workflows/human-decision.js";
import {
  selectRecentRuns,
  type ContinuationQueueFact,
  type WorkflowRunListItem,
} from "../workflows/run-discovery.js";
import {
  definitionSnapshotDigest,
  listRunProjections,
  readLastTraceEvent,
  readRunBundle,
  workflowRunsBaseDir,
  type WorkflowRunProjection,
} from "../workflows/store.js";
import type { HumanDecisionRequest, WorkflowSource } from "../workflows/types.js";
import {
  renderDoctorFindings,
  renderQueueDetailLines,
  renderRunDetailLines,
  renderRunProjectionLines,
  type WorkflowDoctorFinding,
} from "./render.js";
import { runViewer } from "./tui.js";

const USAGE = `omp-workflows — workflow runs and controller resources
  omp-workflows view [runId] [--dir <runsDir>] [--once]
  omp-workflows runs [--dir <runsDir>] [--project <dir>]
  omp-workflows doctor <runId> [--dir <runsDir>]
  omp-workflows cancel <runId> [--dir <runsDir>]
  omp-workflows controllers [--controller-dir <dir>]
  omp-workflows controller <controller> <key> [--controller-dir <dir>]
  omp-workflows host [foreground|install|start|stop|restart|status|uninstall] [--project <dir>] [--json]
  omp-workflows herdr sync [--json]
  omp-workflows herdr setup [--json]

Commands:
  view          Open the live workflow TUI. With --once, print a snapshot.
  runs          List recent workflow runs.
  cancel        Abandon a waiting human decision without an interactive session.
  doctor        Run deep, read-only integrity checks for one run bundle.
  controllers   List durable controller resources.
  controller    Show one resource, its effects, child workflows, and events.
  host          Run, install, control, or inspect the project workflow host.
  herdr         Synchronize the bundled Herdr plugin. setup is an alias for sync.

Options:
  --dir <runsDir>          Runs directory (default: ~/.pi/agent/workflows/runs)
  --controller-dir <dir>  Controller directory (default: project-scoped local store)
  --once                   Render once without the interactive TUI
  --project <dir>          Project directory for run filtering or the host (default: cwd)
  --json                   Print versioned JSON for host status or herdr sync
`;

export type CliArgs = {
  command: string;
  runId?: string;
  controllerName?: string;
  resourceKey?: string;
  herdrAction?: string;
  hostAction?: string;
  dir: string;
  controllerDir: string;
  controllerDirExplicit: boolean;
  once: boolean;
  json: boolean;
  project?: string | undefined;
  ompArgs?: string[] | undefined;
};

export function parseCliArgs(argv: string[]): CliArgs {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("-") ? (args.shift() as string) : "view";
  let dir = workflowRunsBaseDir();
  let controllerDir = projectControllerStoreBaseDir(process.cwd());
  let controllerDirExplicit = false;
  let once = false;
  let json = false;
  const positionals: string[] = [];
  let project: string | undefined;
  const ompArgs: string[] = [];

  while (args.length > 0) {
    const arg = args.shift() as string;
    if (arg === "--dir") {
      dir = requiredValue(args, "--dir");
    } else if (arg === "--controller-dir") {
      controllerDir = requiredValue(args, "--controller-dir");
      controllerDirExplicit = true;
    } else if (arg === "--project") {
      project = requiredValue(args, "--project");
    } else if (arg === "--once") {
      once = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      return { command: "help", dir, controllerDir, controllerDirExplicit, once, json };
    } else if (arg === "--") {
      ompArgs.push(...args.splice(0));
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (!controllerDirExplicit && project !== undefined) {
    controllerDir = projectControllerStoreBaseDir(project);
  }

  const hostAction = command === "host" ? (positionals[0] ?? "foreground") : undefined;
  if (json && command !== "herdr" && !(command === "host" && hostAction === "status")) {
    throw new Error("--json is available only for host status or herdr sync");
  }

  if (command === "host") {
    const actions = new Set([
      "foreground",
      "install",
      "start",
      "stop",
      "restart",
      "status",
      "uninstall",
    ]);
    if (positionals.length > 1 || hostAction === undefined || !actions.has(hostAction)) {
      throw new Error(
        "host requires foreground, install, start, stop, restart, status, or uninstall",
      );
    }
    if (hostAction !== "foreground" && ompArgs.length > 0) {
      throw new Error("Extra agent arguments are available only for host foreground");
    }
    return {
      command,
      hostAction,
      dir,
      controllerDir,
      controllerDirExplicit,
      once,
      json,
      project,
      ompArgs,
    };
  }

  if (command === "controller") {
    if (positionals.length !== 2) {
      throw new Error("controller requires <controller> and <key>");
    }
    return {
      command,
      controllerName: positionals[0] as string,
      resourceKey: positionals[1] as string,
      dir,
      controllerDir,
      controllerDirExplicit,
      once,
      json,
    };
  }
  if (command === "herdr") {
    if (positionals.length !== 1 || (positionals[0] !== "sync" && positionals[0] !== "setup")) {
      throw new Error("herdr requires the sync action");
    }
    return {
      command,
      herdrAction: positionals[0],
      dir,
      controllerDir,
      controllerDirExplicit,
      once,
      json,
    };
  }
  if (command === "doctor") {
    const runId = positionals[0];
    if (runId === undefined) {
      throw new Error("doctor requires <runId>");
    }
    if (positionals.length !== 1) {
      throw new Error(`Unexpected argument: ${positionals[1]}`);
    }
    return { command, runId, dir, controllerDir, controllerDirExplicit, once, json };
  }
  if (command === "cancel") {
    const runId = positionals[0];
    if (runId === undefined) {
      throw new Error("cancel requires <runId>");
    }
    if (positionals.length !== 1) {
      throw new Error(`Unexpected argument: ${positionals[1]}`);
    }
    return {
      command,
      runId,
      dir,
      controllerDir,
      controllerDirExplicit,
      once,
      json,
    };
  }
  if (positionals.length > 1) {
    throw new Error(`Unexpected argument: ${positionals[1]}`);
  }
  return {
    command,
    ...(positionals[0] !== undefined ? { runId: positionals[0] } : {}),
    dir,
    controllerDir,
    controllerDirExplicit,
    once,
    json,
    ...(project !== undefined ? { project } : {}),
  };
}

function printProjectionWarnings(warnings: readonly string[]): void {
  if (warnings.length === 0) return;
  const rendered = warnings
    .slice(0, 8)
    .map((warning) => `- ${sanitizeText(warning).replaceAll(/\s+/g, " ").trim().slice(0, 500)}`)
    .join("\n");
  const omitted = warnings.length - Math.min(warnings.length, 8);
  process.stdout.write(
    `Run discovery warnings:\n${rendered}${omitted > 0 ? `\n- ${omitted} more warning(s) omitted` : ""}\n`,
  );
}

async function printRuns(
  dir: string,
  controllerDir: string,
  includeQueueFacts: boolean,
  project?: string,
): Promise<void> {
  const { items: projections, warnings } = await listRunProjections(dir);
  const queueFacts = includeQueueFacts ? readQueueFacts(controllerDir) : [];
  const selected = selectRecentRuns(
    projections,
    project === undefined ? undefined : { project },
    queueFacts,
  );
  if (selected.length === 0) {
    process.stdout.write(`No workflow runs found in ${dir}\n`);
  } else {
    process.stdout.write(`${renderRunProjectionLines(selected).join("\n")}\n`);
  }
  printProjectionWarnings(warnings);
  if (project !== undefined) {
    const allLive = selectRecentRuns(projections, { liveOnly: true }, queueFacts);
    const projectLive = selectRecentRuns(projections, { liveOnly: true, project }, queueFacts);
    const outside = allLive.length - projectLive.length;
    if (outside > 0) {
      process.stdout.write(`${outside} other live run(s) outside this project.\n`);
    }
  }
}

function selectRequestedRun(
  projections: readonly WorkflowRunProjection[],
  families: readonly WorkflowRunListItem[],
  runId: string,
): WorkflowRunListItem | undefined {
  const exact = projections.find((projection) => projection.runId === runId);
  const family = families.find(
    (candidate) => candidate.parentRunId === runId && candidate.continuationRunId !== undefined,
  );
  const projectedExact = families.find((candidate) => candidate.runId === runId);
  return exact === undefined
    ? projectedExact
    : exact.parentRunId === undefined
      ? (family ?? exact)
      : exact;
}

async function printOnce(
  dir: string,
  runId: string | undefined,
  controllerDir: string,
  includeQueueFacts: boolean,
): Promise<void> {
  const { items: projections, warnings } = await listRunProjections(dir);
  const queueFacts = includeQueueFacts ? readQueueFacts(controllerDir) : [];
  const families = selectRecentRuns(projections, undefined, queueFacts);
  const size = { width: process.stdout.columns ?? 100, height: 1_000 };
  if (runId === undefined) {
    const lines = renderRunProjectionLines(families);
    process.stdout.write(`omp-workflows — runs\n${lines.join("\n")}\n`);
    printProjectionWarnings(warnings);
    return;
  }
  const selected = selectRequestedRun(projections, families, runId);
  if (selected === undefined) {
    throw new Error(`Run not found: ${runId}`);
  }
  const persisted = projections.find((projection) => projection.runId === selected.runId);
  if (persisted === undefined || persisted.runDir.length === 0) {
    process.stdout.write(`${renderQueueDetailLines(selected, size).join("\n")}\n`);
    return;
  }
  const bundle = await readRunBundle(persisted.runDir, { includeTrace: true });
  if (!bundle) {
    throw new Error(`Run bundle unreadable: ${persisted.runDir}`);
  }
  process.stdout.write(`${renderRunDetailLines(bundle, size).join("\n")}\n`);
}

async function runInteractiveView(
  dir: string,
  runId: string | undefined,
  controllerDir: string,
  includeQueueFacts: boolean,
): Promise<void> {
  if (runId === undefined) {
    await runViewer({
      runsDir: dir,
      queueFacts: () => (includeQueueFacts ? readQueueFacts(controllerDir) : []),
    });
    return;
  }
  const { items: projections } = await listRunProjections(dir);
  const families = selectRecentRuns(
    projections,
    undefined,
    includeQueueFacts ? readQueueFacts(controllerDir) : [],
  );
  const selected = selectRequestedRun(projections, families, runId);
  if (selected === undefined) {
    throw new Error(`Run not found: ${runId}`);
  }
  const persisted = projections.find((projection) => projection.runId === selected.runId);
  if (persisted === undefined || persisted.runDir.length === 0) {
    const size = { width: process.stdout.columns ?? 100, height: process.stdout.rows ?? 24 };
    process.stdout.write(`${renderQueueDetailLines(selected, size).join("\n")}\n`);
    return;
  }
  await runViewer({
    runsDir: dir,
    runId: selected.runId,
    queueFacts: () => (includeQueueFacts ? readQueueFacts(controllerDir) : []),
  });
}

export type DoctorEvidence = {
  queueFacts?: readonly ContinuationQueueFact[];
  hostStatus?: HostStatus;
  hostWarning?: string;
};

/** Deep, read-only integrity assessment for one persisted run bundle. */
export async function diagnoseRun(
  dir: string,
  runId: string,
  evidence: DoctorEvidence = {},
): Promise<WorkflowDoctorFinding[]> {
  const findings: WorkflowDoctorFinding[] = [];
  const { items: projections } = await listRunProjections(dir);
  const projection = projections.find((candidate) => candidate.runId === runId);
  if (projection === undefined) {
    return [{ severity: "error", code: "bundle.not_found", message: `Run not found: ${runId}` }];
  }
  for (const warning of projection.warnings) {
    findings.push({ severity: "warning", code: "projection.warning", message: warning });
  }

  const bundle = await readRunBundle(projection.runDir, { includeTrace: true });
  if (bundle === null) {
    findings.push({
      severity: "error",
      code: "bundle.unreadable",
      message: `Run bundle is unreadable: ${projection.runDir}`,
    });
    return findings;
  }

  const { manifest, state, snapshot } = bundle;
  const manifestStateMismatches: string[] = [];
  if (manifest.runId !== state.runId) manifestStateMismatches.push("runId");
  if (manifest.workflowName !== state.workflowName) manifestStateMismatches.push("workflowName");
  if (manifest.status !== state.status) manifestStateMismatches.push("status");
  if (manifest.startedAt !== state.startedAt) manifestStateMismatches.push("startedAt");
  if ((manifest.finishedAt ?? null) !== (state.finishedAt ?? null)) {
    manifestStateMismatches.push("finishedAt");
  }
  if (
    JSON.stringify(manifest.workflowSource ?? null) !== JSON.stringify(state.workflowSource ?? null)
  ) {
    manifestStateMismatches.push("workflowSource");
  }
  if ((manifest.definitionDigest ?? null) !== (state.definitionDigest ?? null)) {
    manifestStateMismatches.push("definitionDigest");
  }
  findings.push(
    manifestStateMismatches.length === 0
      ? {
          severity: "ok",
          code: "manifest_state.consistent",
          message: "Manifest and state identity fields agree.",
        }
      : {
          severity: "error",
          code: "manifest_state.mismatch",
          message: `Manifest and state disagree on ${manifestStateMismatches.join(", ")}.`,
        },
  );

  if (snapshot === null) {
    findings.push({
      severity: "error",
      code: "snapshot.missing",
      message: "Definition snapshot is missing or unreadable.",
    });
  } else {
    const snapshotDigest = definitionSnapshotDigest(snapshot);
    if (snapshot.name !== state.workflowName) {
      findings.push({
        severity: "error",
        code: "snapshot.name_mismatch",
        message: `Snapshot workflow ${snapshot.name} does not match state workflow ${state.workflowName}.`,
      });
    } else {
      findings.push({
        severity: "ok",
        code: "snapshot.identity",
        message: `Definition snapshot ${snapshotDigest} matches workflow ${state.workflowName}.`,
      });
    }
    if (state.definitionDigest !== undefined && state.definitionDigest !== snapshotDigest) {
      findings.push({
        severity: "error",
        code: "snapshot.digest_mismatch",
        message: `State digest ${state.definitionDigest} does not match snapshot digest ${snapshotDigest}.`,
      });
    }
    if (state.currentNode !== undefined && snapshot.nodes[state.currentNode] === undefined) {
      findings.push({
        severity: "warning",
        code: "snapshot.current_node_missing",
        message: `Current node ${state.currentNode} is not present in the definition snapshot.`,
      });
    }
  }

  const source: WorkflowSource | undefined = state.workflowSource;
  if (source?.kind === "builtin") {
    findings.push({
      severity: "ok",
      code: "builtin.identity",
      message: `Built-in identity is ${source.id}@${source.revision}.`,
    });
  } else if (source?.kind === "file") {
    findings.push({
      severity: "ok",
      code: "file.identity",
      message: `File identity hash is ${source.hash}.`,
    });
  } else {
    findings.push({
      severity: "warning",
      code: "source.missing",
      message: "Run has no immutable workflow source identity.",
    });
  }

  if (bundle.traceIntegrity?.malformed === true) {
    findings.push({
      severity: "error",
      code: "trace.malformed",
      message: "Trace contains a malformed NDJSON record before its tail.",
    });
  }
  if (bundle.traceIntegrity?.tornTail === true) {
    findings.push({
      severity: "warning",
      code: "trace.torn_tail",
      message: "Trace has an incomplete final NDJSON record.",
    });
  }
  const trace = bundle.traceEvents ?? [];
  let expectedSeq = 1;
  let traceSequenceValid = true;
  for (const event of trace) {
    if (event.seq !== expectedSeq || event.runId !== state.runId) {
      traceSequenceValid = false;
      break;
    }
    expectedSeq += 1;
  }
  findings.push(
    traceSequenceValid
      ? {
          severity: "ok",
          code: "trace.sequence",
          message: `Trace sequence is contiguous across ${trace.length} event(s).`,
        }
      : {
          severity: "error",
          code: "trace.sequence",
          message: "Trace sequence is non-contiguous or contains a foreign run id.",
        },
  );
  const lastTraceEvent = await readLastTraceEvent(bundle.runDir, manifest.paths.trace);
  const lastTraceSeq = lastTraceEvent?.seq ?? 0;
  if (state.traceSeq !== lastTraceSeq) {
    findings.push({
      severity: "error",
      code: "trace.state_disagreement",
      message: `State traceSeq ${state.traceSeq} does not match trace tail ${lastTraceSeq}.`,
    });
  } else {
    findings.push({
      severity: "ok",
      code: "trace.state_agreement",
      message: `State agrees with trace tail sequence ${lastTraceSeq}.`,
    });
  }
  const terminalStatusByEvent: Record<string, string> = {
    run_completed: "completed",
    run_failed: "failed",
    run_interrupted: "failed",
    run_timed_out: "timed_out",
    run_cancelled: "cancelled",
    run_waiting: "waiting",
  };
  const tailStatus = lastTraceEvent ? terminalStatusByEvent[lastTraceEvent.type] : undefined;
  if (tailStatus !== undefined && tailStatus !== state.status) {
    findings.push({
      severity: "error",
      code: "trace.status_disagreement",
      message: `Trace tail implies ${tailStatus}, but state status is ${state.status}.`,
    });
  }

  const sessionSeverity = bundle.sessionIntegrity.status === "invalid" ? "error" : "ok";
  findings.push({
    severity: sessionSeverity,
    code: "session.integrity",
    message:
      bundle.sessionIntegrity.diagnostics.length === 0
        ? `Session capture status is ${bundle.sessionIntegrity.status}.`
        : `${bundle.sessionIntegrity.status}: ${bundle.sessionIntegrity.diagnostics.join("; ")}`,
  });
  for (const segment of bundle.sessionSegments) {
    findings.push({
      severity: segment.integrity.status === "invalid" ? "error" : "ok",
      code: "session.segment_integrity",
      message:
        segment.integrity.diagnostics.length === 0
          ? `Segment ${segment.attemptId} status is ${segment.integrity.status}.`
          : `Segment ${segment.attemptId}: ${segment.integrity.diagnostics.join("; ")}`,
    });
  }

  const queueFacts = evidence.queueFacts ?? [];
  const childIds = new Set(
    projections
      .filter((candidate) => candidate.parentRunId === runId)
      .map((candidate) => candidate.runId),
  );
  for (const fact of queueFacts) {
    if (fact.parentRunId === runId) childIds.add(fact.runId);
  }
  if (state.parentRunId !== undefined) {
    const parentExists = projections.some((candidate) => candidate.runId === state.parentRunId);
    findings.push({
      severity: parentExists ? "ok" : "error",
      code: "continuation.parent",
      message: parentExists
        ? `Continuation parent ${state.parentRunId} is present.`
        : `Continuation parent ${state.parentRunId} is missing.`,
    });
  }
  if (childIds.size > 1) {
    findings.push({
      severity: "error",
      code: "continuation.duplicate_children",
      message: `Parent has multiple continuation children: ${[...childIds].join(", ")}.`,
    });
  } else if (childIds.size === 1) {
    findings.push({
      severity: "ok",
      code: "continuation.child",
      message: `Continuation child is ${[...childIds][0]}.`,
    });
  }
  const currentQueueFact = queueFacts.find((fact) => fact.runId === runId);
  if (currentQueueFact !== undefined) {
    findings.push({
      severity: "ok",
      code: "queue.evidence",
      message: `Queue status is ${currentQueueFact.status ?? "unknown"}.`,
    });
  }
  if (evidence.hostStatus !== undefined) {
    findings.push({
      severity: evidence.hostStatus.classification === "healthy" ? "ok" : "warning",
      code: "host.evidence",
      message: `Project host is ${evidence.hostStatus.classification}: ${evidence.hostStatus.detail}`,
    });
  } else if (evidence.hostWarning !== undefined) {
    findings.push({
      severity: "warning",
      code: "host.evidence_unavailable",
      message: evidence.hostWarning.slice(0, 500),
    });
  }

  if (state.status === "waiting") {
    const output = state.finalOutput;
    if (
      typeof output === "object" &&
      output !== null &&
      "schema" in output &&
      output.schema === "pi-workflows.human-decision-request.v1"
    ) {
      try {
        const request = validateHumanDecisionRequestIntegrity(output as HumanDecisionRequest);
        if (request.runId !== runId) {
          throw new Error(`request belongs to run ${request.runId}`);
        }
        findings.push({
          severity: "ok",
          code: "decision.integrity",
          message: `Waiting human decision ${request.decisionId} is valid.`,
        });
      } catch (error) {
        findings.push({
          severity: "error",
          code: "decision.integrity",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      findings.push({
        severity: "ok",
        code: "decision.not_applicable",
        message: "Run is waiting at a plain checkpoint, not a human decision.",
      });
    }
  }

  const startedMs = Date.parse(state.startedAt);
  const updatedMs = Date.parse(state.updatedAt);
  const finishedMs = state.finishedAt === undefined ? undefined : Date.parse(state.finishedAt);
  if (
    Number.isNaN(startedMs) ||
    Number.isNaN(updatedMs) ||
    (finishedMs !== undefined && Number.isNaN(finishedMs))
  ) {
    findings.push({
      severity: "error",
      code: "timing.invalid",
      message: "Run contains an invalid lifecycle timestamp.",
    });
  } else if (updatedMs < startedMs || (finishedMs !== undefined && finishedMs < startedMs)) {
    findings.push({
      severity: "error",
      code: "timing.order",
      message: "Run lifecycle timestamps are out of order.",
    });
  } else {
    findings.push({
      severity: "ok",
      code: "timing.order",
      message: "Run lifecycle timestamps are ordered.",
    });
  }

  const lastFailure = [...state.steps]
    .reverse()
    .find((step) => step.outcome === "failed" || step.outcome === "timed_out");
  if (lastFailure !== undefined) {
    findings.push({
      severity: "warning",
      code: "step.last_failure",
      message: `${lastFailure.nodeId} ${lastFailure.outcome}: ${(lastFailure.error ?? "no error text").slice(0, 500)}`,
    });
  }
  return findings.slice(0, 100);
}

function readQueueFacts(controllerDir: string): ContinuationQueueFact[] {
  const store = openControllerStore(controllerDir);
  if (store === undefined) return [];
  try {
    return store.listWorkflowRuns().map((row) => ({
      runId: row.runId,
      parentRunId: row.parentRunId,
      status: row.status,
      startedAt: row.startedAt ?? row.createdAt,
      workflowName: row.workflowName,
      input: row.input,
      ...(row.errorMessage === null ? {} : { errorSummary: row.errorMessage.slice(0, 500) }),
      ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
    }));
  } finally {
    store.close();
  }
}

async function printDoctor(
  dir: string,
  runId: string,
  controllerDir: string,
  includeQueueFacts: boolean,
): Promise<void> {
  const queueFacts = includeQueueFacts ? readQueueFacts(controllerDir) : [];
  const { items } = await listRunProjections(dir);
  const projection = items.find((candidate) => candidate.runId === runId);
  let hostStatus: HostStatus | undefined;
  let hostWarning: string | undefined;
  if (projection?.project !== undefined) {
    try {
      hostStatus = readHostStatus(projection.project);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      hostWarning = `Host evidence unavailable for historical project ${projection.project}: ${detail}`;
    }
  }
  const findings = await diagnoseRun(dir, runId, {
    queueFacts,
    ...(hostStatus !== undefined ? { hostStatus } : {}),
    ...(hostWarning !== undefined ? { hostWarning } : {}),
  });
  process.stdout.write(`${renderDoctorFindings(runId, findings).join("\n")}\n`);
}

function printControllers(controllerDir: string): void {
  const store = openControllerStore(controllerDir);
  if (store === undefined) {
    process.stdout.write(`No controller resources found in ${controllerDir}\n`);
    return;
  }
  try {
    const resources = store.listResources();
    if (resources.length === 0) {
      process.stdout.write(`No controller resources found in ${controllerDir}\n`);
      return;
    }
    for (const resource of resources) {
      const condition =
        resource.status.conditions.find((item) => item.type === "Ready") ??
        resource.status.conditions[0];
      const conditionText =
        condition === undefined
          ? "unknown"
          : `${String(condition.status)}:${sanitizeText(condition.reason)}`;
      process.stdout.write(
        `${sanitizeText(resource.metadata.controller)}  ${sanitizeText(resource.metadata.key)}  generation=${resource.metadata.generation}  ready=${conditionText}\n`,
      );
    }
  } finally {
    store.close();
  }
}

function printController(controllerDir: string, controller: string, key: string): void {
  const store = openControllerStore(controllerDir);
  if (store === undefined) {
    throw new Error(`Controller store not found in ${controllerDir}`);
  }
  try {
    const resource = store.getResource({ controller, key });
    if (resource === undefined) {
      throw new Error(`Controller resource not found: ${controller}/${key}`);
    }
    const value = {
      resource,
      effects: store.listEffects(resource.metadata.uid),
      workflows: store.listWorkflows(resource.metadata.uid),
      events: store.listEvents({ controller, key, limit: 50 }),
    };
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } finally {
    store.close();
  }
}

async function cancelWaitingRun(dir: string, runId: string): Promise<void> {
  const bundle = await readRunBundle(path.join(dir, runId));
  if (bundle === null) {
    throw new Error(`Run not found: ${runId}`);
  }
  if (bundle.state.status !== "waiting") {
    throw new Error(`Workflow run ${runId} is ${bundle.state.status}, not waiting.`);
  }
  const output = bundle.state.finalOutput;
  if (output === null || typeof output !== "object" || !("schema" in output)) {
    throw new Error(`Workflow run ${runId} is waiting at a plain checkpoint.`);
  }
  if (output.schema !== "pi-workflows.human-decision-request.v1") {
    throw new Error(`Workflow run ${runId} is waiting at a plain checkpoint.`);
  }
  const persistedRequest = output as HumanDecisionRequest;
  const request = validateHumanDecisionRequestIntegrity(persistedRequest);
  if (request.runId !== runId) {
    throw new Error(`Human decision request does not belong to run ${runId}.`);
  }
  await new HumanDecisionStore(dir).cancel(request, "cancelled");
  process.stdout.write(
    `Cancelled waiting human decision ${request.decisionId} for run ${runId}.\n`,
  );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }

  try {
    const includeQueueFacts =
      args.controllerDirExplicit ||
      args.project !== undefined ||
      path.resolve(args.dir) === path.resolve(workflowRunsBaseDir());
    if (args.command === "help") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (args.command === "runs") {
      await printRuns(args.dir, args.controllerDir, includeQueueFacts, args.project);
      return 0;
    }
    if (args.command === "doctor") {
      if (args.runId === undefined) {
        throw new Error("doctor requires <runId>");
      }
      await printDoctor(args.dir, args.runId, args.controllerDir, includeQueueFacts);
      return 0;
    }
    if (args.command === "controllers") {
      printControllers(args.controllerDir);
      return 0;
    }
    if (args.command === "controller") {
      printController(
        args.controllerDir,
        args.controllerName as string,
        args.resourceKey as string,
      );
      return 0;
    }
    if (args.command === "host") {
      return await runHostCommand(args);
    }
    if (args.command === "herdr") {
      const result = syncHerdrPlugin(packageRoot());
      process.stdout.write(args.json ? `${JSON.stringify(result)}\n` : `${result.message}\n`);
      return 0;
    }
    if (args.command === "cancel") {
      if (args.runId === undefined) {
        throw new Error("cancel requires <runId>");
      }
      await cancelWaitingRun(args.dir, args.runId);
      return 0;
    }
    if (args.command === "view") {
      if (args.once || !process.stdout.isTTY) {
        await printOnce(args.dir, args.runId, args.controllerDir, includeQueueFacts);
        return 0;
      }
      await runInteractiveView(args.dir, args.runId, args.controllerDir, includeQueueFacts);
      return 0;
    }
    process.stderr.write(`Unknown command: ${args.command}\n\n${USAGE}`);
    return 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runHostCommand(args: CliArgs): Promise<number> {
  const project = args.project ?? process.cwd();
  switch (args.hostAction ?? "foreground") {
    case "foreground":
      return await runHost(project, args.ompArgs);
    case "install": {
      const service = installHostService(project);
      const status = readHostStatus(project);
      process.stdout.write(
        `Installed ${service.name} for ${service.project}; lingering is ${status.lingeringEnabled ? "enabled" : "disabled"}.\n`,
      );
      return 0;
    }
    case "start": {
      const service = startHostService(project);
      process.stdout.write(`Started ${service.name}.\n`);
      return 0;
    }
    case "stop": {
      const service = stopHostService(project);
      process.stdout.write(`Stopped ${service.name}.\n`);
      return 0;
    }
    case "restart": {
      const service = restartHostService(project);
      process.stdout.write(`Restarted ${service.name}.\n`);
      return 0;
    }
    case "uninstall": {
      const service = uninstallHostService(project);
      process.stdout.write(`Uninstalled ${service.name}; durable workflow state was preserved.\n`);
      return 0;
    }
    case "status": {
      const status = readHostStatus(project);
      if (args.json) {
        process.stdout.write(`${JSON.stringify(status)}\n`);
        return 0;
      }
      process.stdout.write(`${renderHostStatus(status)}\n`);
      return 0;
    }
    default:
      throw new Error(`Unknown host action: ${args.hostAction}`);
  }
}

function renderHostStatus(status: HostStatus): string {
  const counts = status.counts;
  const lines = [
    `Host: ${status.classification}`,
    `Project digest: ${status.projectDigest}`,
    `Lingering: ${status.lingeringEnabled ? "enabled" : "disabled"}`,
    `Detail: ${status.detail}`,
  ];
  if (status.owner !== null && status.heartbeatAt !== null) {
    lines.push(`Owner: pid ${status.owner.pid}, heartbeat ${status.heartbeatAt}`);
  }
  lines.push(
    `Work: active=${counts.active} waiting=${counts.waiting} parked=${counts.parked} failed=${counts.failed} controllers=${counts.controllers}`,
    `Pending decisions: ${status.pendingDecisionCount}`,
  );
  return lines.join("\n");
}
async function runHost(project: string, ompArgs: string[] | undefined): Promise<number> {
  const { WorkflowHost } = await import("../host/runner.js");
  const host = new WorkflowHost({
    cwd: project,
    ompArgs: ompArgs ?? [],
    onLog: (message) => process.stdout.write(`[host] ${message}\n`),
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void host.stop().finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await host.start();
  await new Promise<void>(() => undefined);
  return 0;
}

function openControllerStore(controllerDir: string): SqliteControllerStore | undefined {
  const file = path.join(controllerDir, "controller.sqlite");
  if (!fs.existsSync(file)) {
    return undefined;
  }
  return new SqliteControllerStore(file, { readOnly: true });
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function requiredValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value) {
    throw new Error(`${option} requires a path`);
  }
  return value;
}

const entryPath = process.argv[1];
const resolvedEntry = entryPath !== undefined ? realpathSyncSafe(entryPath) : undefined;
if (resolvedEntry !== undefined && import.meta.url === pathToFileURL(resolvedEntry).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}

function realpathSyncSafe(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}
