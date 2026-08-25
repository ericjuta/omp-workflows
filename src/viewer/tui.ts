import type { ContinuationQueueFact } from "../workflows/run-discovery.js";
import { listRunBundles, readRunBundle } from "../workflows/store.js";
import type { LoadedRunBundle } from "../workflows/store.js";
import {
  maxDetailScroll,
  projectViewerRuns,
  renderQueueDetailLines,
  renderRunDetailLines,
  renderRunListLines,
  type ViewerRunEntry,
  type ViewportSize,
} from "./render.js";
import { watchRunsDir } from "./watch.js";

const ALT_SCREEN_ON = "\u001b[?1049h\u001b[?25l";
const ALT_SCREEN_OFF = "\u001b[?25h\u001b[?1049l";
const CLEAR = "\u001b[2J\u001b[H";

type ViewerMode =
  | { view: "list" }
  | { view: "detail"; runDir: string }
  | { view: "queue"; runId: string };

export type ViewerOptions = {
  runsDir: string;
  runId?: string | undefined;
  queueFacts?: () => readonly ContinuationQueueFact[];
  /** Redraw interval for elapsed timers while a run is active. */
  tickMs?: number;
};

function viewportSize(): ViewportSize {
  return {
    width: process.stdout.columns ?? 80,
    height: process.stdout.rows ?? 24,
  };
}

/**
 * Interactive live viewer. Watches the runs directory and re-renders as run
 * bundles change on disk. Returns when the user quits.
 */
export async function runViewer(options: ViewerOptions): Promise<void> {
  let mode: ViewerMode = { view: "list" };
  let bundles: LoadedRunBundle[] = [];
  let visibleRuns: ViewerRunEntry[] = [];
  let selectedIndex = 0;
  let detailScroll = 0;
  /** Replay position; null follows the latest step live. */
  let selectedStep: number | null = null;
  let detailStepCount = 0;

  if (options.runId) {
    bundles = await listRunBundles(options.runsDir);
    const exactBundle = bundles.find((bundle) => bundle.state.runId === options.runId);
    const match =
      exactBundle?.state.parentRunId === undefined
        ? projectViewerRuns(bundles, options.queueFacts?.() ?? []).find(
            (entry) =>
              entry.run.runId === options.runId ||
              entry.run.parentRunId === options.runId ||
              entry.run.continuationRunId === options.runId,
          )
        : projectViewerRuns([exactBundle])[0];
    if (!match) {
      throw new Error(`Run not found: ${options.runId}`);
    }
    mode = { view: "detail", runDir: match.bundle?.runDir ?? "" };
    if (match.bundle === undefined) mode = { view: "queue", runId: match.run.runId };
  }

  const draw = async () => {
    bundles = await listRunBundles(options.runsDir);
    const size = viewportSize();
    visibleRuns = projectViewerRuns(bundles, options.queueFacts?.() ?? []);
    selectedIndex = Math.min(selectedIndex, Math.max(0, visibleRuns.length - 1));
    const lines =
      mode.view === "list"
        ? renderRunListLines(
            visibleRuns.map((entry) => entry.run),
            selectedIndex,
            size,
          )
        : mode.view === "detail"
          ? await renderDetail(mode.runDir, size)
          : renderQueueMode(mode.runId, size);
    process.stdout.write(CLEAR + lines.join("\n"));
  };

  const renderQueueMode = (runId: string, size: ViewportSize): string[] => {
    const current = visibleRuns.find((entry) => entry.run.runId === runId);
    if (current?.bundle !== undefined) {
      mode = { view: "detail", runDir: current.bundle.runDir };
      void draw();
      return ["Workflow bundle became available; opening it…"];
    }
    return current === undefined
      ? ["Queued workflow disappeared. Press q to go back."]
      : renderQueueDetailLines(current.run, size);
  };

  const renderDetail = async (runDir: string, size: ViewportSize): Promise<string[]> => {
    const bundle = await readRunBundle(runDir, { includeTrace: true });
    if (!bundle) {
      return ["Run bundle disappeared. Press q to go back."];
    }
    detailStepCount = bundle.state.steps.length;
    if (selectedStep !== null && selectedStep >= detailStepCount - 1) {
      // Scrubbed to (or past) the end: snap back to following live updates.
      selectedStep = null;
    }
    detailScroll = Math.min(detailScroll, maxDetailScroll(bundle, size, selectedStep));
    return renderRunDetailLines(bundle, size, new Date(), detailScroll, selectedStep);
  };

  process.stdout.write(ALT_SCREEN_ON);
  const stopWatching = watchRunsDir(options.runsDir, () => {
    void draw();
  });
  const ticker = setInterval(() => {
    void draw();
  }, options.tickMs ?? 1_000);

  const rawModeSupported = process.stdin.isTTY === true;
  if (rawModeSupported) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  try {
    await new Promise<void>((resolve) => {
      const onKey = (data: Buffer) => {
        const key = data.toString("utf8");
        if (key === "q" || key === "\u0003" || key === "\u001b") {
          if (mode.view !== "list" && key === "q") {
            mode = { view: "list" };
            void draw();
            return;
          }
          resolve();
          return;
        }
        handleNavigationKey(key);
      };

      const handleNavigationKey = (key: string) => {
        if (mode.view !== "list") {
          if (key === "r") {
            void draw();
          } else if (key === "\u001b[A" || key === "k") {
            detailScroll = Math.max(0, detailScroll - 1);
            void draw();
          } else if (key === "\u001b[B" || key === "j") {
            // Clamped against the content height in renderDetail.
            detailScroll += 1;
            void draw();
          } else if (key === "\u001b[D" || key === "h") {
            const current = selectedStep ?? detailStepCount - 1;
            selectedStep = Math.max(0, current - 1);
            void draw();
          } else if (key === "\u001b[C" || key === "l") {
            // renderDetail snaps back to live once this reaches the end.
            selectedStep = selectedStep === null ? null : selectedStep + 1;
            void draw();
          }
          return;
        }
        if (key === "\u001b[A" || key === "k") {
          selectedIndex = Math.max(0, selectedIndex - 1);
          void draw();
        } else if (key === "\u001b[B" || key === "j") {
          selectedIndex = Math.min(Math.max(0, visibleRuns.length - 1), selectedIndex + 1);
          void draw();
        } else if (key === "\r" || key === "\n") {
          const selected = visibleRuns[selectedIndex];
          if (selected) {
            mode = { view: "detail", runDir: selected.bundle?.runDir ?? "" };
            if (selected.bundle === undefined) {
              mode = { view: "queue", runId: selected.run.runId };
            }
            detailScroll = 0;
            selectedStep = null;
            void draw();
          }
        }
      };

      process.stdin.on("data", onKey);
      void draw();
    });
  } finally {
    clearInterval(ticker);
    stopWatching();
    if (rawModeSupported) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    process.stdout.write(ALT_SCREEN_OFF);
  }
}
