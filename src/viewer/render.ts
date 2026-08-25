import { ansi, fitWidth, sanitizeText } from "../render/ansi.js";
import { formatDuration, runElapsedMs } from "../render/format.js";
import { renderGraphLines } from "../render/graph-render.js";
import { decodeValueWith } from "../workflows/artifacts.js";
import {
  decisionDocumentSegments,
  decisionPresentationFingerprint,
  humanDecisionChannelRequest,
  validateHumanDecisionRequestIntegrity,
} from "../workflows/decision-presentation.js";
import {
  formatProgressLine,
  progressRecordsFromTrace,
  progressTracksFromRecords,
} from "../workflows/progress.js";
import {
  selectRecentRuns,
  summarizeRunBundle,
  type ContinuationQueueFact,
  type WorkflowRunListItem,
} from "../workflows/run-discovery.js";
import type { LoadedRunBundle } from "../workflows/store.js";
import type {
  HumanDecisionRequest,
  WorkflowRunStatus,
  WorkflowStepRecord,
} from "../workflows/types.js";

export { formatDuration, runElapsedMs };

/**
 * Replace `$artifact` references with a compact placeholder for display. The
 * terminal viewer shows summaries; full artifact contents are for replay
 * tooling.
 */
function withArtifactPlaceholders(value: unknown): unknown {
  return decodeValueWith(value, (ref) => `«artifact ${formatBytes(ref.bytes)} ${ref.path}»`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  return `${(bytes / 1024).toFixed(1)}KB`;
}

export type ViewportSize = {
  width: number;
  height: number;
};

const STATUS_COLORS: Record<WorkflowRunStatus, (text: string) => string> = {
  running: ansi.cyan,
  waiting: ansi.yellow,
  completed: ansi.green,
  failed: ansi.red,
  timed_out: ansi.red,
  cancelled: ansi.yellow,
};

export function statusLabel(status: WorkflowRunStatus): string {
  return STATUS_COLORS[status](status);
}

function projectedStatusLabel(status: string): string {
  if (status in STATUS_COLORS) {
    return statusLabel(status as WorkflowRunStatus);
  }
  if (status === "queued") return ansi.yellow(status);
  return ansi.red(sanitizeText(status));
}

/** One compact line per state-only run projection. */
export function renderRunProjectionLines(runs: WorkflowRunListItem[]): string[] {
  return runs.map((run) => {
    const title = run.runTitle ? ` — ${sanitizeText(run.runTitle)}` : "";
    const duration = run.durationMs === undefined ? "" : ` · ${formatDuration(run.durationMs)}`;
    const family =
      run.parentRunId === undefined
        ? ""
        : run.continuationRunId === undefined
          ? ` · continuation of ${sanitizeText(run.parentRunId)}`
          : ` · continuation ${sanitizeText(run.parentRunId)} → ${sanitizeText(run.continuationRunId)}`;
    const paused =
      run.paused === true
        ? ` · paused${run.pausedAgeMs === undefined ? "" : ` ${formatDuration(run.pausedAgeMs)}`}`
        : "";
    const node = run.currentNode ? ` · node ${sanitizeText(run.currentNode)}` : "";
    const failing = run.failingNode ? ` · failing ${sanitizeText(run.failingNode)}` : "";
    const warningCount = run.warnings?.length ?? 0;
    const warnings = warningCount > 0 ? ` · ${warningCount} warning(s)` : "";
    const error = run.errorSummary
      ? ` · ${sanitizeText(run.errorSummary).replaceAll(/\s+/g, " ").slice(0, 200)}`
      : "";
    return `${projectedStatusLabel(run.status)}  ${ansi.bold(sanitizeText(run.workflowName))}${title}  ${sanitizeText(run.runId)}${duration}${family}${paused}${node}${failing}${warnings}${error}`;
  });
}

export type WorkflowDoctorFinding = {
  severity: "ok" | "warning" | "error";
  code: string;
  message: string;
};

/** Sanitize and render read-only doctor findings for terminal output. */
export function renderDoctorFindings(
  runId: string,
  findings: readonly WorkflowDoctorFinding[],
): string[] {
  const lines = [ansi.bold(`Workflow doctor — ${sanitizeText(runId)}`)];
  for (const finding of findings) {
    const label =
      finding.severity === "ok"
        ? ansi.green("OK")
        : finding.severity === "warning"
          ? ansi.yellow("WARN")
          : ansi.red("ERROR");
    const code = sanitizeText(finding.code).replaceAll(/\s+/g, " ").slice(0, 80);
    const message = sanitizeText(finding.message).replaceAll(/\s+/g, " ").trim().slice(0, 500);
    lines.push(`[${label}] ${code}: ${message}`);
  }
  return lines;
}

function previewValue(rawValue: unknown, maxLength: number): string {
  if (rawValue === undefined) {
    return "";
  }
  const value = withArtifactPlaceholders(rawValue);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  // Model-controlled values must not carry escape sequences into the terminal.
  const singleLine = sanitizeText(text ?? "")
    .replaceAll(/\s+/g, " ")
    .trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}

export type ViewerRunEntry = {
  run: WorkflowRunListItem;
  bundle?: LoadedRunBundle;
};

export function projectViewerRuns(
  bundles: readonly LoadedRunBundle[],
  queueFacts: readonly ContinuationQueueFact[] = [],
): ViewerRunEntry[] {
  const bundlesById = new Map(bundles.map((bundle) => [bundle.state.runId, bundle]));
  return selectRecentRuns([...bundles], undefined, queueFacts).map((run) => {
    const physicalRunId = run.continuationRunId ?? run.runId;
    const bundle = bundlesById.get(physicalRunId);
    return { run, ...(bundle === undefined ? {} : { bundle }) };
  });
}

/** One line per run for the run picker. */
export function renderRunListLines(
  runs: readonly (WorkflowRunListItem | LoadedRunBundle)[],
  selectedIndex: number,
  size: ViewportSize,
  now: Date = new Date(),
  queueFacts: readonly ContinuationQueueFact[] = [],
): string[] {
  const bundles = runs.filter((run): run is LoadedRunBundle => "state" in run);
  const displayRuns: readonly WorkflowRunListItem[] =
    bundles.length === runs.length
      ? projectViewerRuns(bundles, queueFacts).map((entry) => entry.run)
      : runs.map((run) => ("state" in run ? summarizeRunBundle(run) : run));
  const lines: string[] = [];
  lines.push(ansi.bold("omp-workflows — runs"));
  lines.push(ansi.dim("↑/↓ select · enter open · q quit"));
  lines.push("");
  if (displayRuns.length === 0) {
    lines.push(ansi.dim("No workflow runs found."));
    return lines.map((line) => fitWidth(line, size.width));
  }
  const visible = Math.max(1, size.height - lines.length - 1);
  const effectiveSelectedIndex = Math.min(selectedIndex, displayRuns.length - 1);
  const start = Math.min(
    Math.max(0, effectiveSelectedIndex - Math.floor(visible / 2)),
    Math.max(0, displayRuns.length - visible),
  );
  for (const [offset, run] of displayRuns.slice(start, start + visible).entries()) {
    const index = start + offset;
    const marker = index === effectiveSelectedIndex ? ansi.cyan("›") : " ";
    const status = projectedStatusLabel(run.effectiveStatus ?? run.status);
    const title = run.runTitle ? ` — ${sanitizeText(run.runTitle)}` : "";
    const family =
      run.parentRunId === undefined
        ? ""
        : run.continuationRunId === undefined
          ? ` · continuation of ${sanitizeText(run.parentRunId)}`
          : ` · continuation ${sanitizeText(run.parentRunId)} → ${sanitizeText(run.continuationRunId)}`;
    const duration =
      run.durationMs !== undefined
        ? ` · ${formatDuration(run.durationMs)}`
        : run.startedAt
          ? ` · ${formatDuration(Math.max(0, now.getTime() - (Date.parse(run.startedAt) || now.getTime())))}`
          : "";
    const paused =
      run.paused === true
        ? ` · paused${run.pausedAgeMs === undefined ? "" : ` ${formatDuration(run.pausedAgeMs)}`}`
        : "";
    const node = run.currentNode ? ` · node ${sanitizeText(run.currentNode)}` : "";
    const failing = run.failingNode ? ` · failing ${sanitizeText(run.failingNode)}` : "";
    const warningCount = run.warnings?.length ?? 0;
    const warnings = warningCount > 0 ? ` · ${warningCount} warning(s)` : "";
    const error = run.errorSummary
      ? ` · ${sanitizeText(run.errorSummary).replaceAll(/\s+/g, " ").slice(0, 200)}`
      : "";
    lines.push(
      fitWidth(
        `${marker} ${status}  ${ansi.bold(sanitizeText(run.workflowName))}${title}  ${ansi.dim(
          `${sanitizeText(run.runId)}${duration}${family}${paused}${node}${failing}${warnings}${error}`,
        )}`,
        size.width,
      ),
    );
  }
  return lines;
}

/** Detail view for a run that is only present in the controller queue. */
export function renderQueueDetailLines(run: WorkflowRunListItem, size: ViewportSize): string[] {
  const lines: string[] = [];
  lines.push(ansi.bold(`Workflow run (queued) — ${sanitizeText(run.runId)}`));
  lines.push(ansi.dim("q back to list"));
  lines.push("");
  lines.push(`Workflow: ${ansi.bold(sanitizeText(run.workflowName))}`);
  lines.push(`Status:   ${projectedStatusLabel(run.effectiveStatus ?? run.status)}`);
  if (run.startedAt) {
    lines.push(`Queued:   ${sanitizeText(run.startedAt)}`);
  }
  if (run.project) {
    lines.push(`Project:  ${sanitizeText(run.project)}`);
  }
  if (run.parentRunId) {
    lines.push(`Parent:   ${sanitizeText(run.parentRunId)}`);
  }
  if (run.continuationRunId) {
    lines.push(`Continuation: ${sanitizeText(run.continuationRunId)}`);
  }
  if (run.errorCode) {
    lines.push(`Error code:   ${ansi.red(sanitizeText(run.errorCode))}`);
  }
  if (run.errorSummary) {
    lines.push(`Error:        ${ansi.red(sanitizeText(run.errorSummary))}`);
  }
  if (run.warnings && run.warnings.length > 0) {
    lines.push(`Warnings:     ${ansi.yellow(run.warnings.map(sanitizeText).join("; "))}`);
  }
  lines.push("");
  lines.push(
    ansi.dim("This run is tracked in the controller queue and has no on-disk bundle yet."),
  );
  return lines.map((line) => fitWidth(line, size.width));
}

function stepLine(
  step: WorkflowStepRecord,
  index: number,
  selectedStepIndex: number,
  width: number,
): string {
  const durationMs = Date.parse(step.finishedAt) - Date.parse(step.startedAt);
  const glyph = step.outcome === "ok" ? ansi.green("✓") : ansi.red("✗");
  const marker = index === selectedStepIndex ? ansi.cyan("›") : " ";
  const preview =
    step.error !== undefined
      ? ansi.red(previewValue(step.error, 60))
      : ansi.dim(previewValue(step.output, 60));
  return fitWidth(
    ` ${marker}${glyph} ${sanitizeText(step.nodeId)} ${ansi.dim(`(${sanitizeText(step.nodeType)}, ${formatDuration(durationMs)})`)} ${preview}`,
    width,
  );
}

/** Fallback node status list for bundles without a definition snapshot. */
function nodeStatusLine(bundle: LoadedRunBundle, nodeId: string, width: number, now: Date): string {
  const state = bundle.state;
  const nodeType = bundle.snapshot?.nodes[nodeId]?.nodeType ?? "?";
  const result = state.results[nodeId];
  let glyph = ansi.dim("·");
  let suffix = "";
  if (state.currentNode === nodeId) {
    glyph = ansi.cyan("◐");
    const startedAt = state.currentNodeStartedAt
      ? Date.parse(state.currentNodeStartedAt)
      : now.getTime();
    const detail = state.statusDetail ? ` · ${sanitizeText(state.statusDetail)}` : "";
    suffix = ansi.cyan(` running ${formatDuration(now.getTime() - startedAt)}${detail}`);
  } else if (state.waitingOn === nodeId) {
    glyph = ansi.yellow("⏸");
    const human = bundle.snapshot?.nodes[nodeId]?.humanDecision;
    const request = humanDecisionRequest(state.finalOutput);
    const requestAudience = request?.audience ?? human?.audience;
    suffix = ansi.yellow(
      human === undefined
        ? " waiting"
        : ` waiting for human · ${sanitizeText(requestAudience ?? "operator")}${request === null ? "" : ` · ${sanitizeText(request.presentation.summary)}`} · ${Object.values(
            human.choices,
          )
            .map((choice) => sanitizeText(choice.label))
            .join(
              " / ",
            )}${request === null ? "" : ` · ${sanitizeText(request.presentationDigest.slice(7, 19))}`}`,
    );
  } else if (result) {
    glyph = result.outcome === "ok" ? ansi.green("✓") : ansi.red("✗");
    const human = bundle.snapshot?.nodes[nodeId]?.humanDecision;
    const accepted = state.humanDecision;
    const selected =
      human !== undefined && accepted !== undefined && accepted.nodeId === nodeId
        ? human.choices[accepted.response.choice]
        : undefined;
    suffix = ansi.dim(
      ` ${formatDuration(result.durationMs)}${selected === undefined ? "" : ` · human: ${sanitizeText(selected.label)}`}`,
    );
  }
  return fitWidth(
    `  ${glyph} ${sanitizeText(nodeId)} ${ansi.dim(`[${sanitizeText(nodeType)}]`)}${suffix}`,
    width,
  );
}

/** Pretty-printed JSON body of the selected step for the inspector pane. */
function inspectorLines(step: WorkflowStepRecord, width: number): string[] {
  const lines: string[] = [];
  const request = step.error === undefined ? humanDecisionRequest(step.output) : null;
  if (request !== null) {
    const channelRequest = humanDecisionChannelRequest(request);
    for (const segment of decisionDocumentSegments(channelRequest)) {
      for (const raw of segment.text.split("\n")) {
        lines.push(fitWidth(`  ${sanitizeText(raw)}`, width));
      }
      lines.push("");
    }
    lines.push(
      fitWidth(ansi.dim(`  decision ${decisionPresentationFingerprint(channelRequest)}`), width),
    );
    return lines;
  }
  const body = step.error !== undefined ? step.error : withArtifactPlaceholders(step.output);
  const rendered =
    typeof body === "string" && step.error !== undefined ? body : JSON.stringify(body, null, 2);
  for (const raw of (rendered ?? "null").split("\n")) {
    lines.push(fitWidth(`  ${sanitizeText(raw)}`, width));
  }
  if (step.action) {
    const receipt = [
      step.action.actionType,
      step.action.command,
      ...(step.action.args ?? []),
      step.action.exitCode !== undefined ? `→ exit ${step.action.exitCode}` : "",
    ]
      .filter((part) => part !== undefined && part !== "")
      .join(" ");
    lines.push(fitWidth(ansi.dim(`  ${sanitizeText(receipt)}`), width));
  }
  return lines;
}

function humanDecisionRequest(value: unknown): HumanDecisionRequest | null {
  if (value === null || typeof value !== "object") return null;
  const schema = (value as { schema?: unknown }).schema;
  if (schema !== "pi-workflows.human-decision-request.v1") return null;
  try {
    return validateHumanDecisionRequestIntegrity(value as HumanDecisionRequest);
  } catch {
    return null;
  }
}

/**
 * Full-run detail view: header, graph pane, step timeline, inspector.
 * `scroll` shifts the viewport down over the full body; `selectedStepIndex`
 * scrubs the replay position (defaults to the latest step, i.e. live).
 */
export function renderRunDetailLines(
  bundle: LoadedRunBundle,
  size: ViewportSize,
  now: Date = new Date(),
  scroll = 0,
  selectedStepIndex: number | null = null,
): string[] {
  const state = bundle.state;
  const steps = state.steps;
  const selected = selectedStepIndex === null ? steps.length - 1 : selectedStepIndex;
  const lines: string[] = [];
  const title = state.runTitle ? ` — ${sanitizeText(state.runTitle)}` : "";
  lines.push(
    fitWidth(`${ansi.bold(`workflow ${sanitizeText(state.workflowName)}`)}${title}`, size.width),
  );
  const position =
    selectedStepIndex === null || steps.length === 0
      ? ""
      : ` · step ${Math.min(selected, steps.length - 1) + 1}/${steps.length}`;
  const paused = state.paused ? ` · ${ansi.yellow("paused")}` : "";
  const continuation = state.parentRunId
    ? ` · continuation ${sanitizeText(state.parentRunId)} → effective ${sanitizeText(state.runId)}`
    : "";
  lines.push(
    fitWidth(
      `${statusLabel(state.status)}${paused} · run ${sanitizeText(state.runId)}${continuation} · elapsed ${formatDuration(runElapsedMs(state, now))}${position}`,
      size.width,
    ),
  );
  lines.push(ansi.dim("q back · r refresh · ↑/↓ scroll · ←/→ replay steps"));
  lines.push("");

  const graph = renderGraphLines(bundle, selected, now, { nodeStyle: "box" }).map((line) =>
    fitWidth(line, size.width),
  );
  if (graph.length > 0) {
    lines.push(...graph);
  } else {
    // No definition snapshot: fall back to a flat executed-node list.
    for (const nodeId of Object.keys(state.results)) {
      lines.push(nodeStatusLine(bundle, nodeId, size.width, now));
    }
  }

  const progressRecords =
    bundle.traceEvents === undefined
      ? (state.updates ?? []).filter((update) => update.type === "progress")
      : progressRecordsFromTrace(bundle.traceEvents);
  const progress = progressTracksFromRecords(progressRecords, now);
  if (progress.length > 0) {
    lines.push("");
    lines.push(ansi.bold("progress"));
    for (const track of progress) {
      const depth = track.key.startsWith("agents/") ? track.key.split("/").length - 2 : 0;
      const indentation = "  ".repeat(Math.max(0, depth));
      lines.push(fitWidth(`${indentation}${formatProgressLine(track.estimate, now)}`, size.width));
      const latest = track.samples.at(-1);
      lines.push(
        fitWidth(
          ansi.dim(
            `${indentation}  ${track.estimate.sampleCount} samples · ${track.estimate.confidence ?? "no"} confidence · updated ${sanitizeText(latest?.at ?? "unknown")}`,
          ),
          size.width,
        ),
      );
    }
  }

  if (steps.length > 0) {
    lines.push("");
    lines.push(ansi.bold("steps"));
    for (const [index, step] of steps.entries()) {
      lines.push(stepLine(step, index, Math.min(selected, steps.length - 1), size.width));
    }
    const inspected = steps[Math.min(Math.max(selected, 0), steps.length - 1)];
    if (inspected) {
      lines.push("");
      lines.push(
        ansi.bold(`step output — ${sanitizeText(inspected.nodeId)} (${inspected.outcome})`),
      );
      lines.push(...inspectorLines(inspected, size.width));
    }
  }

  if (state.error) {
    lines.push("");
    lines.push(fitWidth(ansi.red(`error: ${sanitizeText(state.error)}`), size.width));
  }
  if (state.status === "completed" && state.finalOutput !== undefined) {
    lines.push("");
    lines.push(
      fitWidth(
        `${ansi.bold("output")} ${previewValue(state.finalOutput, size.width - 8)}`,
        size.width,
      ),
    );
  }
  const start = Math.max(0, Math.min(scroll, lines.length - size.height));
  return lines.slice(start, start + size.height);
}

/** Highest useful `scroll` value for the detail view of `bundle`. */
export function maxDetailScroll(
  bundle: LoadedRunBundle,
  size: ViewportSize,
  selectedStepIndex: number | null = null,
): number {
  const total = renderRunDetailLines(
    bundle,
    { width: size.width, height: Number.MAX_SAFE_INTEGER },
    new Date(),
    0,
    selectedStepIndex,
  ).length;
  return Math.max(0, total - size.height);
}
