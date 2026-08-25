import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import { projectControllerStoreBaseDir } from "../src/controllers/store.js";
import { diagnoseRun, main, parseCliArgs } from "../src/viewer/cli.js";
import { checkpoint, compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import {
  HumanDecisionStore,
  choice,
  defineHumanChoices,
  humanDecision,
} from "../src/workflows/human-decision.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { HumanDecisionRequest } from "../src/workflows/types.js";
import { ScriptedExecutor, makeTempDir } from "./helpers.js";

async function makeCompletedRun(outputRoot: string): Promise<string> {
  const workflow = defineWorkflow({
    name: "cli-demo",
    startAt: "one",
    nodes: { one: compute({ run: () => ({ ok: true }) }) },
    edges: [],
  });
  const engine = new WorkflowEngine({ executor: new ScriptedExecutor(), outputRoot });
  const { state } = await engine.run(workflow, {});
  return state.runId;
}
async function bindRunToProject(outputRoot: string, runId: string, cwd: string): Promise<void> {
  const store = new WorkflowRunStore(outputRoot);
  await store.writeSessionBinding(store.runDirFor(runId), {
    schema: "pi-workflows.session-binding.v1",
    runId,
    piSessionId: `session-${runId}`,
    cwd,
    boundAt: new Date().toISOString(),
  });
}

const decisionChoices = defineHumanChoices({
  continue: choice({ label: "Continue" }),
  stop: choice({ label: "Stop" }),
});

async function makeWaitingHumanDecisionRun(outputRoot: string): Promise<HumanDecisionRequest> {
  const workflow = defineWorkflow({
    name: "cli-human-decision",
    startAt: "approve",
    nodes: {
      approve: humanDecision({
        audience: "operator",
        choices: decisionChoices,
        request: () => ({
          title: "Approve",
          subject: { task: "test CLI cancellation" },
          presentation: {
            schema: "pi-workflows.decision-presentation.v1",
            summary: "Approve this test decision.",
            blocks: [],
          },
        }),
      }),
    },
    edges: [],
  });
  const engine = new WorkflowEngine({ executor: new ScriptedExecutor(), outputRoot });
  const { state } = await engine.run(workflow, {});
  return state.finalOutput as HumanDecisionRequest;
}

async function makeWaitingCheckpointRun(outputRoot: string): Promise<string> {
  const workflow = defineWorkflow({
    name: "cli-checkpoint",
    startAt: "review",
    nodes: { review: checkpoint({ summary: "Review" }) },
    edges: [],
  });
  const engine = new WorkflowEngine({ executor: new ScriptedExecutor(), outputRoot });
  const { state } = await engine.run(workflow, {});
  return state.runId;
}

const continuationWorkflow = defineWorkflow({
  name: "cli-continuation",
  startAt: "review",
  nodes: {
    review: checkpoint({ summary: "Review" }),
    finish: compute({ run: () => ({ continued: true }) }),
  },
  edges: [{ from: "review", to: "finish" }],
});

async function makeContinuationFamily(
  outputRoot: string,
): Promise<{ parentRunId: string; childRunId: string }> {
  const parentRunId = "cli-parent";
  const childRunId = "cli-child";
  const engine = new WorkflowEngine({ executor: new ScriptedExecutor(), outputRoot });
  await engine.run(continuationWorkflow, {}, { runId: parentRunId });
  await engine.continueRun(continuationWorkflow, parentRunId, {}, { runId: childRunId });
  return { parentRunId, childRunId };
}

let stdout: string;
let stderr: string;

beforeEach(() => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("parseCliArgs", () => {
  it("defaults to view with the standard runs dir", () => {
    const args = parseCliArgs([]);
    expect(args.command).toBe("view");
    expect(args.dir).toContain(path.join(".pi", "agent", "workflows", "runs"));
    expect(args.once).toBe(false);
  });

  it("requires exactly one doctor run id", () => {
    expect(parseCliArgs(["doctor", "run-1", "--dir", "/runs"])).toMatchObject({
      command: "doctor",
      runId: "run-1",
      dir: "/runs",
    });
    expect(() => parseCliArgs(["doctor"])).toThrow(/doctor requires <runId>/);
    expect(() => parseCliArgs(["doctor", "one", "two"])).toThrow(/Unexpected argument/);
  });

  it("parses command, run id, dir, and once", () => {
    const args = parseCliArgs(["view", "run-123", "--dir", "/tmp/runs", "--once"]);
    expect(args).toMatchObject({
      command: "view",
      runId: "run-123",
      dir: "/tmp/runs",
      once: true,
    });
  });

  it("parses runs, controller, and help commands", () => {
    expect(parseCliArgs(["runs"]).command).toBe("runs");
    expect(
      parseCliArgs([
        "controller",
        "pull-request",
        "repo#1",
        "--controller-dir",
        "/tmp/controllers",
      ]),
    ).toMatchObject({
      command: "controller",
      controllerName: "pull-request",
      resourceKey: "repo#1",
      controllerDir: "/tmp/controllers",
    });
    expect(parseCliArgs(["--help"]).command).toBe("help");
    expect(parseCliArgs(["herdr", "sync", "--json"])).toMatchObject({
      command: "herdr",
      herdrAction: "sync",
      json: true,
    });
    expect(parseCliArgs(["herdr", "setup"])).toMatchObject({
      command: "herdr",
      herdrAction: "setup",
      json: false,
    });
  });
  it("parses a project filter for runs", () => {
    expect(parseCliArgs(["runs", "--project", "/repo"])).toMatchObject({
      command: "runs",
      project: "/repo",
    });
  });

  it("parses the cancel command with its run and runs directory", () => {
    expect(parseCliArgs(["cancel", "run-123", "--dir", "/tmp/runs"])).toMatchObject({
      command: "cancel",
      runId: "run-123",
      dir: "/tmp/runs",
    });
    expect(() => parseCliArgs(["cancel"])).toThrow(/cancel requires <runId>/);
    expect(() => parseCliArgs(["cancel", "run-123", "extra"])).toThrow(/Unexpected argument/);
  });

  it("parses the host command with project and passthrough args", () => {
    expect(parseCliArgs(["host"])).toMatchObject({ command: "host" });
    expect(parseCliArgs(["host", "--project", "/repo"])).toMatchObject({
      command: "host",
      project: "/repo",
    });
    expect(parseCliArgs(["host", "--", "--provider", "mock"])).toMatchObject({
      command: "host",
      ompArgs: ["--provider", "mock"],
    });
    expect(() => parseCliArgs(["host", "--project"])).toThrow(/--project requires/);
  });

  it("rejects unknown flags, extra values, and missing option values", () => {
    expect(() => parseCliArgs(["view", "--nope"])).toThrow(/Unknown argument/);
    expect(() => parseCliArgs(["view", "--dir"])).toThrow(/--dir requires/);
    expect(() => parseCliArgs(["controllers", "--controller-dir"])).toThrow(/requires/);
    expect(() => parseCliArgs(["runs", "one", "two"])).toThrow(/Unexpected/);
  });
});

describe("omp-workflows CLI", () => {
  it("prints usage for help", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(stdout).toContain("omp-workflows — workflow runs and controller resources");
  });

  it("lists runs", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli");
    const runId = await makeCompletedRun(outputRoot);
    expect(await main(["runs", "--dir", outputRoot])).toBe(0);
    expect(stdout).toContain(runId);
    expect(stdout).toContain("completed");
  });

  it("reports bounded malformed bundle warnings while listing runs", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli-warnings");
    const badDir = path.join(outputRoot, "broken-run");
    await fs.mkdir(badDir);
    await fs.writeFile(path.join(badDir, "manifest.json"), "{not-json");

    expect(await main(["runs", "--dir", outputRoot])).toBe(0);
    expect(stdout).toContain("broken-run");
    expect(stdout).toContain("Run discovery warnings:");
    expect(stdout).toContain("unreadable_bundle");
  });

  it("filters runs by project and reports other live runs", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli-project");
    const project = await makeTempDir("pi-workflows-cli-project-cwd");
    const otherProject = await makeTempDir("pi-workflows-cli-other-cwd");
    const projectRunId = await makeCompletedRun(outputRoot);
    const outsideRunId = await makeWaitingCheckpointRun(outputRoot);
    await bindRunToProject(outputRoot, projectRunId, project);
    await bindRunToProject(outputRoot, outsideRunId, otherProject);

    expect(await main(["runs", "--dir", outputRoot, "--project", project])).toBe(0);
    expect(stdout).toContain(projectRunId);
    expect(stdout).not.toContain(outsideRunId);
    expect(stdout).toContain("1 other live run(s) outside this project.");
  });

  it("reports an empty runs dir", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli");
    expect(await main(["runs", "--dir", outputRoot])).toBe(0);
    expect(stdout).toContain("No workflow runs found");
  });

  it("renders a run detail snapshot with --once", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli");
    const runId = await makeCompletedRun(outputRoot);
    expect(await main(["view", runId, "--dir", outputRoot, "--once"])).toBe(0);
    expect(stdout).toContain("workflow cli-demo");
    expect(stdout).toContain("ƒ compute");
    expect(stdout).toContain("✓ completed");
    expect(stdout).toContain("one");
  });

  it("renders the run list with --once and no run id", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli");
    await makeCompletedRun(outputRoot);
    expect(await main(["view", "--dir", outputRoot, "--once"])).toBe(0);
    expect(stdout).toContain("omp-workflows — runs");
  });

  it("collapses continuation families while preserving exact child selection without writes", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli-family");
    const controllerDir = await makeTempDir("pi-workflows-cli-family-controller");
    const { parentRunId, childRunId } = await makeContinuationFamily(outputRoot);
    const parentStatePath = path.join(outputRoot, parentRunId, "state.json");
    const childStatePath = path.join(outputRoot, childRunId, "state.json");
    const parentBefore = await fs.readFile(parentStatePath, "utf8");
    const childBefore = await fs.readFile(childStatePath, "utf8");

    expect(await main(["runs", "--dir", outputRoot, "--controller-dir", controllerDir])).toBe(0);
    expect(stdout).toContain(`continuation ${parentRunId} → ${childRunId}`);
    expect(stdout.match(/cli-continuation/g)).toHaveLength(1);

    stdout = "";
    expect(
      await main([
        "view",
        childRunId,
        "--dir",
        outputRoot,
        "--controller-dir",
        controllerDir,
        "--once",
      ]),
    ).toBe(0);
    expect(stdout).toContain(`run ${childRunId}`);
    expect(stdout).toContain(`continuation ${parentRunId} → effective ${childRunId}`);

    stdout = "";
    expect(
      await main([
        "view",
        parentRunId,
        "--dir",
        outputRoot,
        "--controller-dir",
        controllerDir,
        "--once",
      ]),
    ).toBe(0);
    expect(stdout).toContain(`run ${childRunId}`);
    expect(stdout).toContain(`continuation ${parentRunId} → effective ${childRunId}`);
    await expect(fs.readFile(parentStatePath, "utf8")).resolves.toBe(parentBefore);
    await expect(fs.readFile(childStatePath, "utf8")).resolves.toBe(childBefore);
  });

  it("includes a queued continuation from the controller store without writes", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli-queued-family");
    const controllerDir = await makeTempDir("pi-workflows-cli-queued-controller");
    const parentRunId = await makeWaitingCheckpointRun(outputRoot);
    const parentStatePath = path.join(outputRoot, parentRunId, "state.json");
    const parentBefore = await fs.readFile(parentStatePath, "utf8");
    const databasePath = path.join(controllerDir, "controller.sqlite");
    const store = new SqliteControllerStore(databasePath);
    store.enqueueWorkflowRun({
      runId: "queued-child",
      workflowName: "cli-checkpoint",
      workflowSourceRef: "/historical/cli-checkpoint.workflow.ts",
      input: { answer: "continue" },
      runnerId: "runner-cli",
      claimToken: "claim-cli",
      leaseMs: 1_000,
      parentRunId,
      now: "2026-08-25T00:00:00.000Z",
    });
    store.close();
    const databaseBefore = await fs.readFile(databasePath);

    expect(await main(["runs", "--dir", outputRoot, "--controller-dir", controllerDir])).toBe(0);
    expect(stdout).toContain("queued-child");
    expect(stdout).toContain(`continuation ${parentRunId} → queued-child`);
    expect(stdout.trim().split("\n")).toHaveLength(1);

    stdout = "";
    expect(
      await main([
        "view",
        "queued-child",
        "--dir",
        outputRoot,
        "--controller-dir",
        controllerDir,
        "--once",
      ]),
    ).toBe(0);
    expect(stdout).toContain("Workflow run (queued) — queued-child");
    expect(stdout).toContain(`Parent:   ${parentRunId}`);
    await expect(fs.readFile(parentStatePath, "utf8")).resolves.toBe(parentBefore);
    await expect(fs.readFile(databasePath)).resolves.toEqual(databaseBefore);
  });
  it("reads queued continuations from the selected project's controller store", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli-project-queued-family");
    const controllerBase = await makeTempDir("pi-workflows-cli-project-controller-base");
    const project = await makeTempDir("pi-workflows-cli-selected-project");
    vi.stubEnv("PI_WORKFLOWS_CONTROLLER_DIR", controllerBase);
    const parentRunId = await makeWaitingCheckpointRun(outputRoot);
    await bindRunToProject(outputRoot, parentRunId, project);
    const controllerDir = projectControllerStoreBaseDir(project);
    await fs.mkdir(controllerDir, { recursive: true });
    const store = new SqliteControllerStore(path.join(controllerDir, "controller.sqlite"));
    store.enqueueWorkflowRun({
      runId: "project-queued-child",
      workflowName: "cli-checkpoint",
      workflowSourceRef: "/historical/cli-checkpoint.workflow.ts",
      input: { answer: "continue" },
      runnerId: "session-project",
      claimToken: "claim-project",
      leaseMs: 1_000,
      parentRunId,
      now: "2026-08-25T00:00:00.000Z",
    });
    store.close();

    expect(await main(["runs", "--dir", outputRoot, "--project", project])).toBe(0);
    expect(stdout).toContain("project-queued-child");
    expect(stdout).toContain(`continuation ${parentRunId} → project-queued-child`);
  });

  it("reports deep doctor findings for trace and human-decision corruption", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli-doctor");
    const completedRunId = await makeCompletedRun(outputRoot);
    await fs.appendFile(path.join(outputRoot, completedRunId, "trace.ndjson"), "not-json\n");

    const completedFindings = await diagnoseRun(outputRoot, completedRunId);
    expect(completedFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "error", code: "trace.malformed" }),
        expect.objectContaining({ severity: "ok", code: "manifest_state.consistent" }),
      ]),
    );
    expect(await main(["doctor", completedRunId, "--dir", outputRoot])).toBe(0);
    expect(stdout).toContain("trace.malformed");

    stdout = "";
    const request = await makeWaitingHumanDecisionRun(outputRoot);
    const statePath = path.join(outputRoot, request.runId, "state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(
      statePath,
      JSON.stringify({
        ...state,
        finalOutput: { ...request, subject: { task: "tampered" } },
      }),
    );

    const waitingFindings = await diagnoseRun(outputRoot, request.runId);
    expect(waitingFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "error", code: "decision.integrity" }),
      ]),
    );
  });

  it("warns when historical project host evidence is unavailable and completes doctor checks", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli-doctor-project");
    const controllerDir = await makeTempDir("pi-workflows-cli-doctor-controller");
    const historicalProject = await makeTempDir("pi-workflows-cli-doctor-moved-project");
    const runId = await makeCompletedRun(outputRoot);
    await bindRunToProject(outputRoot, runId, historicalProject);
    await fs.rm(historicalProject, { recursive: true });
    const statePath = path.join(outputRoot, runId, "state.json");
    const stateBefore = await fs.readFile(statePath, "utf8");

    expect(
      await main(["doctor", runId, "--dir", outputRoot, "--controller-dir", controllerDir]),
    ).toBe(0);
    expect(stdout).toContain("host.evidence_unavailable");
    expect(stdout).toContain("manifest_state.consistent");
    expect(stdout).toContain("trace.sequence");
    expect(stdout.length).toBeLessThan(20_000);
    await expect(fs.readFile(statePath, "utf8")).resolves.toBe(stateBefore);
  });

  it("cancels a waiting human decision through the immutable cancellation fence", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli-cancel");
    const request = await makeWaitingHumanDecisionRun(outputRoot);

    expect(await main(["cancel", request.runId, "--dir", outputRoot])).toBe(0);
    expect(stdout).toContain(`Cancelled waiting human decision ${request.decisionId}`);
    await expect(
      new HumanDecisionStore(outputRoot).readCancellation(request.decisionId),
    ).resolves.toMatchObject({
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      reason: "cancelled",
    });
  });

  it("rejects cancellation of missing, non-waiting, and plain-checkpoint runs", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli-cancel-invalid");
    const completedRunId = await makeCompletedRun(outputRoot);
    const checkpointRunId = await makeWaitingCheckpointRun(outputRoot);

    expect(await main(["cancel", "missing-run", "--dir", outputRoot])).toBe(1);
    expect(stderr).toContain("Run not found: missing-run");
    stderr = "";
    expect(await main(["cancel", completedRunId, "--dir", outputRoot])).toBe(1);
    expect(stderr).toContain("not waiting");
    stderr = "";
    expect(await main(["cancel", checkpointRunId, "--dir", outputRoot])).toBe(1);
    expect(stderr).toContain("waiting at a plain checkpoint");
  });

  it("lists and inspects controller resources without modifying the store", async () => {
    const controllerDir = await makeTempDir("pi-workflows-cli-controllers");
    const store = new SqliteControllerStore(path.join(controllerDir, "controller.sqlite"));
    const resource = store.putResource({
      controller: "pull-request",
      key: "repo#1",
      spec: { head: "abc" },
      initialStatus: { phase: "new" },
    });
    store.updateStatus({
      ref: { controller: "pull-request", key: "repo#1" },
      expectedResourceVersion: resource.metadata.resourceVersion,
      status: {
        observedGeneration: 1,
        controllerStatus: { phase: "ready" },
        conditions: [
          {
            type: "Ready",
            status: true,
            reason: "Complete",
            observedGeneration: 1,
            lastTransitionTime: "2026-08-04T00:00:00.000Z",
          },
        ],
      },
    });
    store.recordEvent({
      controller: "pull-request",
      key: "repo#1",
      type: "created",
      payload: { uid: resource.metadata.uid },
    });
    store.putResource({ controller: "other", key: "item", spec: {}, initialStatus: {} });
    store.close();

    expect(await main(["controllers", "--controller-dir", controllerDir])).toBe(0);
    expect(stdout).toContain("pull-request  repo#1  generation=1  ready=true:Complete");
    stdout = "";
    expect(
      await main(["controller", "pull-request", "repo#1", "--controller-dir", controllerDir]),
    ).toBe(0);
    expect(stdout).toContain('"resource"');
    expect(stdout).toContain('"type": "created"');
  });

  it("prints the versioned Herdr sync result as JSON", async () => {
    const temp = await makeTempDir("pi-workflows-cli-herdr");
    const bin = path.join(temp, "bin");
    await fs.mkdir(bin);
    const root = path.resolve(import.meta.dirname, "..");
    const packageVersion = JSON.parse(
      await fs.readFile(path.join(root, "package.json"), "utf8"),
    ) as {
      version: string;
    };
    const herdr = path.join(bin, "herdr");
    await fs.writeFile(
      herdr,
      `#!/usr/bin/env node\nconst path = require("node:path");\nconst root = process.env.TEST_HERDR_ROOT;\nconst pkg = require(path.join(root, "package.json"));\nprocess.stdout.write(JSON.stringify({ result: { plugins: [{ plugin_id: "ericjuta.omp-workflows", plugin_root: root, manifest_path: path.join(root, "herdr-plugin.toml"), version: pkg.version, enabled: true }] } }));\n`,
    );
    await fs.chmod(herdr, 0o755);
    vi.stubEnv("TEST_HERDR_ROOT", root);
    vi.stubEnv("PATH", `${bin}:${process.env["PATH"] ?? ""}`);

    expect(await main(["herdr", "sync", "--json"])).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      schema: "pi-workflows.herdr-sync.v1",
      status: "unchanged",
      changed: false,
      expectedVersion: packageVersion.version,
      effectiveVersion: packageVersion.version,
      enabled: true,
    });
  });

  it("reports missing and empty controller stores", async () => {
    const controllerDir = await makeTempDir("pi-workflows-cli-controllers");
    expect(await main(["controllers", "--controller-dir", controllerDir])).toBe(0);
    expect(stdout).toContain("No controller resources found");
    stderr = "";
    expect(await main(["controller", "demo", "one", "--controller-dir", controllerDir])).toBe(1);
    expect(stderr).toContain("Controller store not found");

    const store = new SqliteControllerStore(path.join(controllerDir, "controller.sqlite"));
    store.close();
    stdout = "";
    expect(await main(["controllers", "--controller-dir", controllerDir])).toBe(0);
    expect(stdout).toContain("No controller resources found");
  });

  it("fails cleanly for unknown runs, bad args, and unknown commands", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli");
    expect(await main(["view", "nope", "--dir", outputRoot, "--once"])).toBe(1);
    expect(stderr).toContain("Run not found");

    expect(await main(["view", "--bogus"])).toBe(2);
    expect(stderr).toContain("Unknown argument");

    expect(await main(["controller", "missing"])).toBe(2);
    expect(stderr).toContain("requires <controller> and <key>");

    stderr = "";
    expect(await main(["herdr", "wrong"])).toBe(2);
    expect(stderr).toContain("herdr requires the sync action");

    stderr = "";
    expect(await main(["runs", "--json"])).toBe(2);
    expect(stderr).toContain("--json is available only for host status or herdr sync");

    stderr = "";
    expect(await main(["frobnicate"])).toBe(2);
    expect(stderr).toContain("Unknown command");
  });
});
