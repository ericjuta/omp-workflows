import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repositoryId } from "../src/builtins/autoimplement-command-batches.js";
import monitor from "../src/builtins/monitor.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { HumanDecisionStore } from "../src/workflows/human-decision.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { HumanDecisionRequest, HumanDecisionResponse } from "../src/workflows/types.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

const execFileAsync = promisify(execFile);
let originalPath = "";
let repository = "";
let baseRevision = "";
let headRevision = "";

function repairCheck() {
  return {
    route: "act",
    goalState: "incomplete",
    workState: "failed",
    observation: "A deterministic test fails.",
    report: "A repair is available.",
    targetStateId: "test-a:one",
    authorizedActions: ["repair test-a in the current repository"],
    reason: "Repair is authorized.",
    action: {
      kind: "repair",
      incomplete: "test-a must pass",
      evidence: { test: "test-a" },
      nextAction: "Fix the deterministic test",
      authority: {
        status: "authorized",
        basis: "The task authorizes repair in the current repository.",
        allowedMutations: ["source and tests in the current repository"],
        forbiddenMutations: ["unrelated repositories"],
        costLimit: "No paid resources",
        providerRuntime: "Keep the current runtime",
        requiredChecks: ["run test-a"],
        stopConditions: ["stop if the defect requires a protected contract change"],
        allowedRecoveryActions: ["repair this deterministic defect"],
        repository,
        baseBranch: "main",
        merge: true,
        repairApproval: { mode: "required" },
      },
      cost: {
        paidAction: false,
        status: "not-applicable",
        evidence: "The repair uses local resources.",
      },
      defect: {
        sharedCodeOrDataDefect: true,
        paidWorkers: "stopped",
        evidence: "No affected paid worker is active.",
      },
      verification: "Run test-a and confirm it passes.",
      failureId: "test-a",
      targetStateId: "test-a:one",
    },
  };
}

function stopCheck() {
  return {
    route: "stop",
    goalState: "complete",
    workState: "stopped",
    observation: "The test passes.",
    report: "The repair is verified.",
    targetStateId: "test-a:two",
    authorizedActions: [],
    reason: "Complete.",
  };
}

function designResponses(executor: ScriptedExecutor, rounds: number): ScriptedExecutor {
  const repeated = <T>(value: T): Array<{ output: T }> =>
    Array.from({ length: rounds }, () => ({ output: structuredClone(value) }));
  return executor
    .respond(
      "planChange/design/captureIntent",
      ...repeated({ originalUserInstructions: "Fix the deterministic test." }),
    )
    .respond(
      "planChange/design/frame",
      ...repeated({
        problem: "test failure",
        success: ["passes"],
        inScope: ["repository"],
        outOfScope: [],
        constraints: [],
        controlBoundary: "repository",
      }),
    )
    .respond(
      "planChange/design/solutions",
      ...repeated({ solution: "fix", rationale: "owned", parts: ["code"], tradeoffs: [] }),
    )
    .respond(
      "planChange/design/holyGrail",
      ...repeated({ ideal: "correct", outsideDependencies: [], additionalValue: [] }),
    )
    .respond(
      "planChange/design/select",
      ...repeated({
        status: "ready",
        selected: "fix",
        why: "in scope",
        relationshipToIdeal: "same",
        excluded: [],
        compromises: [],
      }),
    )
    .respond(
      "planChange/design/plan",
      ...Array.from({ length: rounds }, (_, index) => ({
        output: {
          summary: index === 0 ? "first plan" : "revised plan",
          steps: [
            { change: index === 0 ? "first" : "revised", where: "src", verification: "test" },
          ],
          contracts: [],
          tests: ["test"],
          risks: [],
          boundaries: [],
        },
      })),
    )
    .respond(
      "planChange/documentation/inspectDocumentation",
      ...repeated({
        route: "current",
        files: ["docs/spec.md", "docs/plans/plan.md"],
        reason: "Current.",
        evidence: "checked",
      }),
    );
}

function completedRepairExecutor(rounds = 1): ScriptedExecutor {
  return designResponses(
    new ScriptedExecutor().respond("check", { output: repairCheck() }, { output: stopCheck() }),
    rounds,
  )
    .respond("implementation/implement", {
      output: {
        status: "implemented",
        summary: "fixed",
        files: ["src/a.ts"],
        issueKind: null,
        evidence: "change",
      },
    })
    .respond("implementation/classifyImplementation", {
      output: { route: "verify", summary: "ready", evidence: "change" },
    })
    .respond("implementation/planVerification", {
      output: {
        commands: [
          {
            id: "verify",
            command: "npm",
            args: ["test"],
            cwd: repository,
            timeoutMs: 60_000,
            maxOutputChars: 100_000,
          },
        ],
        untested: [],
      },
    })
    .respond("implementation/publish", {
      output: {
        repositories: [
          {
            repository,
            branch: "feat/fix",
            baseBranch: "main",
            baseRevision,
            headRevision,
            pr: "https://github.com/example/repository/pull/1",
            pushed: true,
          },
        ],
      },
    })
    .respond("implementation/assessReview", {
      output: {
        repositories: [
          {
            id: repositoryId(repository),
            invocationSucceeded: true,
            p0: [],
            p1: [],
            p2: [],
            lower: [],
            reason: "clean",
          },
        ],
        reason: "clean",
      },
    })
    .respond("implementation/inspectComments", {
      output: { route: "ci", summary: "none", evidence: [] },
    })
    .respond("implementation/inspectCi", {
      output: {
        targets: [
          {
            id: repositoryId(repository),
            route: "green",
            reason: "green",
            relatedFailures: [],
            unrelatedFailures: [],
          },
        ],
      },
    })
    .respond("implementation/finalizeDelivery", {
      output: {
        status: "completed",
        merged: true,
        pr: "https://github.com/example/repository/pull/1",
        reportComment: "reported",
        reason: "merged",
      },
    });
}

function makeEngine(executor: ScriptedExecutor, store: WorkflowRunStore): WorkflowEngine {
  return new WorkflowEngine({
    executor,
    store,
    notificationSink: {
      notify() {
        return { notificationId: "notification", targetSessionId: "session" };
      },
    },
  });
}

async function answer(
  store: WorkflowRunStore,
  executor: ScriptedExecutor,
  parentRunId: string,
  response: HumanDecisionResponse,
) {
  const parent = await import("../src/workflows/store.js").then(
    async ({ readRunBundle }) => await readRunBundle(store.runDirFor(parentRunId)),
  );
  if (parent === null) throw new Error("missing waiting bundle");
  const request = parent.state.finalOutput as HumanDecisionRequest;
  if (request?.choices === undefined) {
    throw new Error(`Invalid human decision request: ${JSON.stringify(request)}`);
  }
  const accepted = await new HumanDecisionStore(store.outputRoot).accept(request, {
    decisionId: request.decisionId,
    requestDigest: request.requestDigest,
    ...response,
    source: { channel: "pi", actorId: "person", eventId: `event-${parentRunId}` },
    idempotencyKey: `event-${parentRunId}`,
  });
  return await makeEngine(executor, store).continueRun(
    monitor,
    parentRunId,
    {},
    { humanDecision: accepted.decision },
  );
}

beforeEach(async () => {
  originalPath = process.env.PATH ?? "";
  repository = await fs.realpath(await makeTempDir("monitor-approval-repository"));
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: repository,
  });
  const trackedFile = path.join(repository, "tracked.txt");
  await fs.writeFile(trackedFile, "base\n");
  await fs.writeFile(
    path.join(repository, "package.json"),
    `${JSON.stringify(
      {
        name: "monitor-approval-fixture",
        private: true,
        scripts: { test: "true", check: "true" },
      },
      null,
      2,
    )}\n`,
  );
  await execFileAsync("git", ["add", "tracked.txt", "package.json"], { cwd: repository });
  await execFileAsync("git", ["commit", "-q", "-m", "base"], { cwd: repository });
  baseRevision = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim();
  await execFileAsync("git", ["checkout", "-q", "-b", "feat/fix"], { cwd: repository });
  await fs.writeFile(trackedFile, "published\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: repository });
  await execFileAsync("git", ["commit", "-q", "-m", "published"], { cwd: repository });
  headRevision = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim();
  const commands = await fs.mkdtemp(path.join(os.tmpdir(), "monitor-approval-commands-"));
  await fs.writeFile(path.join(commands, "omp-reviewer"), "#!/bin/sh\necho clean\n", {
    mode: 0o755,
  });
  await fs.writeFile(path.join(commands, "omp"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  process.env.PATH = `${commands}:${originalPath}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("monitor human repair approval", () => {
  it("continues only after the verified human continue answer", async () => {
    const executor = completedRepairExecutor();
    const store = new WorkflowRunStore(await makeTempDir("monitor-approval-runs"));
    const first = await makeEngine(executor, store).run(monitor, {
      task: "Monitor and repair",
      stopWhen: "test passes",
      maxChecks: 3,
      repair: {
        authorized: true,
        repository,
        merge: true,
        approval: { mode: "required", audience: "operator", maxReplans: 3 },
      },
    });
    if (first.state.status !== "waiting") {
      throw new Error(
        `${first.state.error ?? "unknown"}\n${first.state.steps.map((step) => step.nodeId).join("\n")}`,
      );
    }
    expect(first.state.waitingOn).toBe("planChange/approval/approve");
    expect(first.state.steps.some((step) => step.nodeId === "implementation/implement")).toBe(
      false,
    );
    const continued = await answer(store, executor, first.state.runId, {
      choice: "continue",
    });
    expect(continued.state.status).toBe("completed");
    expect(continued.state.steps.some((step) => step.nodeId === "implementation/implement")).toBe(
      true,
    );
    expect(continued.state.steps.filter((step) => step.nodeId === "check")).toHaveLength(2);
    expect(
      continued.state.steps.filter((step) => step.nodeId.endsWith("approval/approve")),
    ).toHaveLength(1);
    expect(
      continued.state.steps.some(
        (step) => step.nodeId === "implementation/redesign/approval/approve",
      ),
    ).toBe(false);
  });

  it("stops truthfully when the operator rejects the repair", async () => {
    const executor = completedRepairExecutor();
    const store = new WorkflowRunStore(await makeTempDir("monitor-stop-runs"));
    const first = await makeEngine(executor, store).run(monitor, {
      task: "Monitor and repair",
      stopWhen: "test passes",
      maxChecks: 3,
      repair: {
        authorized: true,
        repository,
        approval: { mode: "required", audience: "operator", maxReplans: 3 },
      },
    });
    const stopped = await answer(store, executor, first.state.runId, {
      choice: "stop",
    });
    expect(stopped.state.status).toBe("completed");
    expect(stopped.state.finalOutput).toMatchObject({
      reason: "The operator stopped the proposed plan change.",
    });
    expect(stopped.state.steps.some((step) => step.nodeId === "implementation/implement")).toBe(
      false,
    );
  });

  it("feeds exact replan text to autoplan, documents the revision, and asks again", async () => {
    const executor = completedRepairExecutor(2);
    const store = new WorkflowRunStore(await makeTempDir("monitor-replan-runs"));
    const first = await makeEngine(executor, store).run(monitor, {
      task: "Monitor and repair",
      stopWhen: "test passes",
      maxChecks: 3,
      repair: {
        authorized: true,
        repository,
        merge: true,
        approval: { mode: "required", audience: "operator", maxReplans: 3 },
      },
    });
    const firstDigest = (first.state.finalOutput as { subject?: { planDigest?: string } }).subject
      ?.planDigest;
    const exact = "  use the smaller repair\nkeep this exact  ";
    const replanned = await answer(store, executor, first.state.runId, {
      choice: "replan",
      input: { instructions: exact },
    });
    expect(replanned.state.status).toBe("waiting");
    expect(replanned.state.waitingOn).toBe("planChange/approval/approve");
    expect(
      (replanned.state.finalOutput as { subject?: { planDigest?: string } }).subject?.planDigest,
    ).not.toBe(firstDigest);
    const frameRequests = executor.requests.filter(
      (request) => request.contract.nodeId === "planChange/design/frame",
    );
    expect(frameRequests).toHaveLength(2);
    expect(frameRequests[1]?.prompt).toContain(JSON.stringify(exact).slice(1, -1));
    const completed = await answer(store, executor, replanned.state.runId, {
      choice: "continue",
    });
    expect(completed.state.status).toBe("completed");
    const steps = completed.state.steps.map((step) => step.nodeId);
    expect(steps.filter((step) => step === "planChange/documentation/finalize")).toHaveLength(2);
    expect(steps).toContain("implementation/implement");
  });
});
