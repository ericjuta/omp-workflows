import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repositoryId } from "../src/builtins/autoimplement-command-batches.js";
import monitor from "../src/builtins/monitor.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { WorkflowNotificationRequest } from "../src/workflows/types.js";
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
    observation: "A deterministic test fails in target state one.",
    report: "A fixable test failure was found.",
    targetStateId: "test-a:state-one",
    authorizedActions: ["repair test-a in the current repository"],
    reason: "Repair is authorized and in scope.",
    action: {
      kind: "repair",
      incomplete: "test-a must pass",
      evidence: { test: "test-a", state: "one" },
      nextAction: "Fix the deterministic test failure",
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
        repairApproval: { mode: "skip" },
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
      targetStateId: "test-a:state-one",
    },
  };
}

function stopCheck() {
  return {
    route: "stop",
    goalState: "complete",
    workState: "stopped",
    observation: "The test passes in target state two.",
    report: "The repair is verified.",
    targetStateId: "test-a:state-two",
    authorizedActions: [],
    reason: "The monitored success condition is true.",
  };
}

function repairExecutor(secondCheck: unknown): ScriptedExecutor {
  return new ScriptedExecutor()
    .respond("check", { output: repairCheck() }, { output: secondCheck })
    .respond("planChange/design/captureIntent", {
      output: { originalUserInstructions: "Fix the deterministic test failure." },
    })
    .respond("planChange/design/frame", {
      output: {
        problem: "test failure",
        success: ["test passes"],
        inScope: ["repo"],
        outOfScope: [],
        constraints: [],
        controlBoundary: "repo",
      },
    })
    .respond("planChange/design/solutions", {
      output: { solution: "fix code", rationale: "owned", parts: ["code"], tradeoffs: [] },
    })
    .respond("planChange/design/holyGrail", {
      output: { ideal: "correct code", outsideDependencies: [], additionalValue: [] },
    })
    .respond("planChange/design/select", {
      output: {
        status: "ready",
        selected: "fix code",
        why: "in scope",
        relationshipToIdeal: "same",
        excluded: [],
        compromises: [],
      },
    })
    .respond("planChange/design/plan", {
      output: {
        summary: "fix test",
        steps: [{ change: "fix", where: "src", verification: "test-a" }],
        contracts: [],
        tests: ["test-a"],
        risks: [],
        boundaries: [],
      },
    })
    .respond("planChange/documentation/inspectDocumentation", {
      output: {
        route: "current",
        files: ["docs/spec.md", "docs/plans/plan.md"],
        reason: "The repair plan is documented.",
        evidence: "checked",
      },
    })
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
            pr: "https://github.com/example/repository/pull/2",
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
      output: { route: "ci", summary: "clear", evidence: [] },
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
        pr: "https://github.com/example/repository/pull/2",
        reportComment: "https://github.com/example/repository/pull/2#issuecomment-1",
        reason: "merged",
      },
    });
}

beforeEach(async () => {
  originalPath = process.env.PATH ?? "";
  const commandDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workflows-monitor-commands-"));
  repository = await fs.realpath(await makeTempDir("pi-workflows-monitor-repo"));
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
        name: "monitor-repair-fixture",
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
  await fs.writeFile(path.join(commandDir, "omp-reviewer"), "#!/bin/sh\necho clean\n", {
    mode: 0o755,
  });
  await fs.writeFile(path.join(commandDir, "omp"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  process.env.PATH = `${commandDir}:${originalPath}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("monitor automatic repair", () => {
  it("devises, implements, and then checks the target again", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const engine = new WorkflowEngine({
      executor: repairExecutor(stopCheck()),
      store: new WorkflowRunStore(await makeTempDir("pi-workflows-monitor-repair")),
      notificationSink: {
        notify(request) {
          notifications.push(request);
          return { notificationId: `n${notifications.length}`, targetSessionId: "s1" };
        },
      },
    });

    const { state } = await engine.run(monitor, {
      task: "Monitor and repair test-a",
      stopWhen: "test-a passes",
      maxChecks: 3,
      repair: {
        authorized: true,
        scope: "current repository",
        repository,
        merge: true,
        approval: { mode: "skip" },
      },
    });

    expect(state.status, state.error).toBe("completed");
    expect(state.steps.map((step) => step.nodeId)).toContain("planChange/design/frame");
    expect(state.steps.map((step) => step.nodeId)).toContain("implementation/implement");
    expect(state.steps.filter((step) => step.nodeId === "check")).toHaveLength(2);
    expect(notifications[0]?.content).toContain("A fixable test failure was found.");
    expect(notifications[1]?.content).toContain("The repair is verified.");
    expect(notifications[1]?.content).toContain("Goal: complete");
    expect(state.workflowSources?.map((item) => item.mountPath.join("/"))).toEqual([
      "implementation",
      "implementation/documentation",
      "implementation/documentation/verification",
      "implementation/documentation/workspace",
      "implementation/localVerification",
      "implementation/redesign",
      "implementation/redesign/approval",
      "implementation/redesign/design",
      "implementation/redesign/documentation",
      "implementation/redesign/documentation/verification",
      "implementation/redesign/documentation/workspace",
      "implementation/workspace",
      "planChange",
      "planChange/approval",
      "planChange/design",
      "planChange/documentation",
      "planChange/documentation/verification",
      "planChange/documentation/workspace",
    ]);
    expect(state.definitionDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects repair authorization when the repository is missing", async () => {
    const engine = new WorkflowEngine({
      executor: repairExecutor(stopCheck()),
      store: new WorkflowRunStore(await makeTempDir("pi-workflows-monitor-missing-repo")),
      notificationSink: {
        notify() {
          return { notificationId: "n1", targetSessionId: "s1" };
        },
      },
    });
    await expect(
      engine.run(monitor, {
        task: "Monitor and repair test-a",
        stopWhen: "test-a passes",
        maxChecks: 3,
        repair: {
          authorized: true,
          scope: "current repository",
          merge: true,
          approval: { mode: "skip" },
        },
      }),
    ).rejects.toThrow("repair repository must be a string");
  });

  it("stops when the same target evidence returns after repair", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const engine = new WorkflowEngine({
      executor: repairExecutor(repairCheck()),
      store: new WorkflowRunStore(await makeTempDir("pi-workflows-monitor-no-progress")),
      notificationSink: {
        notify(request) {
          notifications.push(request);
          return { notificationId: `n${notifications.length}`, targetSessionId: "s1" };
        },
      },
    });

    const { state } = await engine.run(monitor, {
      task: "Monitor and repair test-a",
      stopWhen: "test-a passes",
      maxChecks: 3,
      repair: {
        authorized: true,
        scope: "current repository",
        repository,
        merge: true,
        approval: { mode: "skip" },
      },
    });

    expect(state.status, state.error).toBe("completed");
    expect(state.steps.filter((step) => step.nodeId === "implementation")).toHaveLength(1);
    expect(state.steps.map((step) => step.nodeId)).toContain("repairBlocked");
    expect(state.finalOutput).toMatchObject({
      reason: "The same issue returned after a completed repair with no changed target evidence.",
    });
    expect(notifications.at(-1)?.content).toContain("Automatic repair stopped");
  });
});
