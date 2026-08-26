import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import autoimplementWorkflow from "../src/builtins/autoimplement.workflow.js";
import {
  PREPARED_WORKSPACE_SCHEMA,
  type PreparedWorkspace,
} from "../src/builtins/workspace-preparation.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { digest } from "../src/workflows/human-decision.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

const execFileAsync = promisify(execFile);
let originalPath = "";
let repository = "";
let prepared: PreparedWorkspace;

beforeEach(async () => {
  originalPath = process.env.PATH ?? "";
  const commandDir = await makeTempDir("autoimplement-plan-discovery-commands");
  for (const name of ["omp", "omp-reviewer"]) {
    await fs.writeFile(path.join(commandDir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  process.env.PATH = `${commandDir}:${originalPath}`;
  repository = await fs.realpath(await makeTempDir("autoimplement-plan-discovery-repository"));
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  await fs.writeFile(path.join(repository, "README.md"), "demo\n");
  await fs.writeFile(
    path.join(repository, "package.json"),
    `${JSON.stringify(
      {
        name: "plan-discovery-fixture",
        private: true,
        scripts: { test: "true", check: "true" },
      },
      null,
      2,
    )}\n`,
  );
  await execFileAsync("git", ["add", "README.md", "package.json"], { cwd: repository });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repository });
  const baseRevision = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim();
  await execFileAsync("git", ["switch", "-q", "-c", "feat/demo"], { cwd: repository });
  prepared = {
    schema: PREPARED_WORKSPACE_SCHEMA,
    mode: "branch",
    repository,
    baseBranch: "main",
    baseRevision,
    workBranch: "feat/demo",
    directDefaultBranchAuthorized: false,
    preExistingChangedPaths: [],
    evidence: ["prepared by test"],
    scope: `Only ${repository}`,
  };
});

afterEach(() => {
  process.env.PATH = originalPath;
});

function documentedPlan(plan: unknown) {
  return {
    plan,
    documentation: { status: "current" as const, planDigest: digest(plan), documents: [] },
    approval: { mode: "skip" as const },
    preparedWorkspace: prepared,
  };
}

function blockedImplementation(executor: ScriptedExecutor): ScriptedExecutor {
  return executor
    .respond("implement", {
      output: {
        status: "blocked",
        summary: "stop after startup test",
        files: [],
        issueKind: null,
        evidence: "test boundary",
      },
    })
    .respond("classifyImplementation", {
      output: { route: "blocked", summary: "test boundary", evidence: "done" },
    });
}

async function run(executor: ScriptedExecutor, input: unknown) {
  return await new WorkflowEngine({
    executor,
    outputRoot: await makeTempDir("autoimplement-plan-discovery"),
  }).run(autoimplementWorkflow, {
    repository,
    preparedWorkspace: prepared,
    ...(input as Record<string, unknown>),
  });
}

describe("autoimplement existing-plan startup", () => {
  it("uses a current plan from context without initial autoplan or autodoc", async () => {
    const plan = { summary: "existing", steps: ["implement"] };
    const executor = blockedImplementation(
      new ScriptedExecutor().respond("findPlan", {
        output: {
          route: "found",
          plan,
          documentation: "current",
          documents: ["docs/plans/plan.md"],
          reason: "The conversation has one clear current plan.",
          evidence: "context",
        },
      }),
    );
    const { state } = await run(executor, { task: "implement existing plan" });
    const steps = state.steps.map((step) => step.nodeId);
    expect(steps).toContain("findPlan");
    expect(steps).toContain("implement");
    expect(steps.some((step) => step.startsWith("redesign/"))).toBe(false);
    expect(steps.some((step) => step.startsWith("documentation/"))).toBe(false);
  });

  it("runs standalone autodoc for an undocumented existing plan", async () => {
    const plan = { summary: "existing", steps: ["implement"] };
    const executor = blockedImplementation(
      new ScriptedExecutor()
        .respond("findPlan", {
          output: {
            route: "found",
            plan,
            documentation: "stale",
            documents: ["docs/spec.md", "docs/plans/plan.md"],
            reason: "The implementation plan is stale.",
            evidence: "digest changed",
          },
        })
        .respond("documentation/inspectDocumentation", {
          output: {
            route: "update",
            files: ["docs/spec.md", "docs/plans/plan.md"],
            reason: "The documents are stale.",
            evidence: "digest changed",
          },
        })
        .respond("documentation/updateDocumentation", {
          output: {
            updated: true,
            files: ["docs/spec.md", "docs/plans/plan.md"],
            summary: "Recorded the selected plan.",
          },
        }),
    );
    const { state } = await run(executor, {
      task: "implement existing plan",
      verificationChecks: [
        {
          id: "docs",
          command: "npm",
          args: ["run", "check"],
          cwd: repository,
          timeoutMs: 10_000,
          maxOutputChars: 100_000,
          readOnly: true,
          baseEligible: false,
          changedFileScope: false,
          findingFormat: "text" as const,
        },
      ],
    });
    const steps = state.steps.map((step) => step.nodeId);
    expect(steps).toContain("documentation/updateDocumentation");
    expect(steps.some((step) => step.startsWith("redesign/"))).toBe(false);
    expect(steps.indexOf("documentation/finalize")).toBeLessThan(steps.indexOf("implement"));
  });

  it("blocks instead of devising when no clear plan exists", async () => {
    const executor = new ScriptedExecutor().respond("findPlan", {
      output: {
        route: "blocked",
        documents: [],
        reason: "No clear selected plan exists.",
        evidence: null,
      },
    });
    const { state } = await run(executor, { task: "implement something" });
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "No clear selected plan exists.",
    });
    expect(state.steps.some((step) => step.nodeId.startsWith("redesign/"))).toBe(false);
    expect(state.steps.some((step) => step.nodeId === "implement")).toBe(false);
  });

  it("lets an explicit documented plan bypass discovery and autodoc", async () => {
    const executor = blockedImplementation(new ScriptedExecutor());
    const plan = { summary: "explicit", steps: ["implement"] };
    const { state } = await run(executor, {
      task: "implement explicit plan",
      ...documentedPlan(plan),
    });
    const steps = state.steps.map((step) => step.nodeId);
    expect(steps).not.toContain("findPlan");
    expect(steps.some((step) => step.startsWith("documentation/"))).toBe(false);
    expect(steps[0]).toBe("prepare");
    expect(steps).toContain("implement");
  });

  it("inspects documentation when an explicit plan has no current-document evidence", async () => {
    const plan = { summary: "explicit", steps: ["implement"] };
    const executor = blockedImplementation(
      new ScriptedExecutor().respond("documentation/inspectDocumentation", {
        output: {
          route: "current",
          files: ["docs/plans/plan.md"],
          digests: { "docs/plans/plan.md": `sha256:${"a".repeat(64)}` },
          reason: "The canonical plan is current.",
          evidence: "checked",
        },
      }),
    );
    const { state } = await run(executor, {
      task: "implement explicit plan",
      plan,
    });
    expect(state.steps.map((step) => step.nodeId)).toContain("documentation/inspectDocumentation");
    expect(state.steps.some((step) => step.nodeId.startsWith("redesign/"))).toBe(false);
  });

  it("does not gate an existing plan even when later plan changes require approval", async () => {
    const executor = blockedImplementation(new ScriptedExecutor());
    const plan = { summary: "explicit", steps: ["implement"] };
    const { state } = await run(executor, {
      task: "implement selected plan",
      ...documentedPlan(plan),
      approval: { mode: "required" },
    });
    expect(state.steps.some((step) => step.nodeId === "implement")).toBe(true);
    expect(state.steps.some((step) => step.nodeId.includes("approval/approve"))).toBe(false);
  });

  it("documents every evidence-driven redesign before implementation resumes", async () => {
    const revised = { summary: "revised", steps: ["change approach"] };
    const executor = new ScriptedExecutor()
      .respond(
        "implement",
        {
          output: {
            status: "issue",
            summary: "new design evidence",
            files: [],
            issueKind: "design",
            evidence: "API cannot support old plan",
          },
        },
        {
          output: {
            status: "blocked",
            summary: "stop after redesign test",
            files: [],
            issueKind: null,
            evidence: "done",
          },
        },
      )
      .respond(
        "classifyImplementation",
        {
          output: {
            route: "redesign",
            summary: "The API evidence invalidates the plan.",
            evidence: "API cannot support old plan",
          },
        },
        { output: { route: "blocked", summary: "done", evidence: "done" } },
      )
      .respond("redesign/design/captureIntent", {
        output: { originalUserInstructions: "Revise the existing plan in scope." },
      })
      .respond("redesign/design/frame", {
        output: {
          problem: "API mismatch",
          success: ["works"],
          inScope: ["repository"],
          outOfScope: [],
          constraints: [],
          controlBoundary: "repository",
        },
      })
      .respond("redesign/design/solutions", {
        output: { solution: "revised", rationale: "in scope", parts: ["code"], tradeoffs: [] },
      })
      .respond("redesign/design/holyGrail", {
        output: { ideal: "revised", outsideDependencies: [], additionalValue: [] },
      })
      .respond("redesign/design/select", {
        output: {
          status: "ready",
          selected: "revised",
          why: "in scope",
          relationshipToIdeal: "same",
          excluded: [],
          compromises: [],
        },
      })
      .respond("redesign/design/plan", { output: revised })
      .respond("redesign/documentation/inspectDocumentation", {
        output: {
          route: "update",
          files: ["docs/plans/plan.md"],
          reason: "The plan changed.",
          evidence: "new plan digest",
        },
      })
      .respond("redesign/documentation/updateDocumentation", {
        output: {
          updated: true,
          files: ["docs/plans/plan.md"],
          summary: "Recorded the revised plan.",
        },
      })
      .respond("redesign/documentation/verification/planChecks", {
        output: {
          checks: [
            {
              id: "docs",
              command: "npm",
              args: ["run", "check"],
              cwd: repository,
              timeoutMs: 10_000,
              maxOutputChars: 100_000,
              readOnly: true,
              baseEligible: false,
              changedFileScope: false,
              findingFormat: "text",
            },
          ],
        },
      });
    const oldPlan = { summary: "old", steps: ["old"] };
    const { state } = await run(executor, {
      task: "implement and redesign",
      ...documentedPlan(oldPlan),
      verificationChecks: [
        {
          id: "docs",
          command: "npm",
          args: ["run", "check"],
          cwd: repository,
          timeoutMs: 10_000,
          maxOutputChars: 100_000,
          readOnly: true,
          baseEligible: false,
          changedFileScope: false,
          findingFormat: "text" as const,
        },
      ],
    });
    const steps = state.steps.map((step) => step.nodeId);
    const redesigned = steps.indexOf("redesign/design/plan");
    const documented = steps.indexOf("redesign/documentation/finalize");
    const implementations = steps
      .map((step, index) => ({ step, index }))
      .filter((entry) => entry.step === "implement");
    expect(redesigned).toBeGreaterThanOrEqual(0);
    expect(documented).toBeGreaterThan(redesigned);
    expect(implementations[1]?.index).toBeGreaterThan(documented);
    const implementationRequests = executor.requests.filter(
      (request) => request.contract.nodeId === "implement",
    );
    expect(implementationRequests[1]?.prompt).toContain(JSON.stringify(revised));
    expect(implementationRequests[1]?.prompt).not.toContain(
      JSON.stringify({ summary: "old", steps: ["old"] }),
    );
  });
});
