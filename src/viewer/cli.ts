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
import { listRunBundles, readRunBundle, workflowRunsBaseDir } from "../workflows/store.js";
import type { HumanDecisionRequest } from "../workflows/types.js";
import {
  formatDuration,
  renderRunDetailLines,
  renderRunListLines,
  runElapsedMs,
  statusLabel,
} from "./render.js";
import { runViewer } from "./tui.js";

const USAGE = `omp-workflows — workflow runs and controller resources
  omp-workflows view [runId] [--dir <runsDir>] [--once]
  omp-workflows runs [--dir <runsDir>]
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
  controllers   List durable controller resources.
  controller    Show one resource, its effects, child workflows, and events.
  host          Run, install, control, or inspect the project workflow host.
  herdr         Synchronize the bundled Herdr plugin. setup is an alias for sync.

Options:
  --dir <runsDir>          Runs directory (default: ~/.pi/agent/workflows/runs)
  --controller-dir <dir>  Controller directory (default: project-scoped local store)
  --once                   Render once without the interactive TUI
  --project <dir>          Project directory for the host (default: cwd)
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
    } else if (arg === "--project") {
      project = requiredValue(args, "--project");
    } else if (arg === "--once") {
      once = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      return { command: "help", dir, controllerDir, once, json };
    } else if (arg === "--") {
      ompArgs.push(...args.splice(0));
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      positionals.push(arg);
    }
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
    return { command, hostAction, dir, controllerDir, once, json, project, ompArgs };
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
      once,
      json,
    };
  }
  if (command === "herdr") {
    if (positionals.length !== 1 || (positionals[0] !== "sync" && positionals[0] !== "setup")) {
      throw new Error("herdr requires the sync action");
    }
    return { command, herdrAction: positionals[0], dir, controllerDir, once, json };
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
    once,
    json,
  };
}

async function printRuns(dir: string): Promise<void> {
  const bundles = await listRunBundles(dir);
  if (bundles.length === 0) {
    process.stdout.write(`No workflow runs found in ${dir}\n`);
    return;
  }
  for (const bundle of bundles) {
    const state = bundle.state;
    const title = state.runTitle ? ` — ${sanitizeText(state.runTitle)}` : "";
    process.stdout.write(
      `${statusLabel(state.status)}  ${sanitizeText(state.workflowName)}${title}  ${state.runId}  ${formatDuration(
        runElapsedMs(state),
      )}\n`,
    );
  }
}

async function printOnce(dir: string, runId: string | undefined): Promise<void> {
  const bundles = await listRunBundles(dir);
  const size = { width: process.stdout.columns ?? 100, height: 1_000 };
  if (runId === undefined) {
    process.stdout.write(`${renderRunListLines(bundles, 0, size).join("\n")}\n`);
    return;
  }
  const match = bundles.find((bundle) => bundle.state.runId === runId);
  if (!match) {
    throw new Error(`Run not found: ${runId}`);
  }
  const bundle = await readRunBundle(match.runDir, { includeTrace: true });
  if (!bundle) {
    throw new Error(`Run bundle unreadable: ${match.runDir}`);
  }
  process.stdout.write(`${renderRunDetailLines(bundle, size).join("\n")}\n`);
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
    if (args.command === "help") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (args.command === "runs") {
      await printRuns(args.dir);
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
        await printOnce(args.dir, args.runId);
        return 0;
      }
      await runViewer({ runsDir: args.dir, runId: args.runId });
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
