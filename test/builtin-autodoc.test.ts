import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import autodocWorkflow from "../src/builtins/autodoc.workflow.js";
import type { VerificationCheck } from "../src/builtins/change-verification.workflow.js";
import {
  PREPARED_WORKSPACE_SCHEMA,
  type PreparedWorkspace,
} from "../src/builtins/workspace-preparation.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { digest } from "../src/workflows/human-decision.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function repository(name: string, checkSource = "process.exit(0)"): Promise<string> {
  const root = await makeTempDir(name);
  const created = path.join(root, "demo");
  await fs.mkdir(created);
  const repo = await fs.realpath(created);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(repo, "README.md"), "demo\n");
  await fs.writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify(
      {
        name: "autodoc-fixture",
        private: true,
        scripts: { check: `${process.execPath} -e ${JSON.stringify(checkSource)}` },
      },
      null,
      2,
    )}\n`,
  );
  await git(repo, ["add", "README.md", "package.json"]);
  await git(repo, ["commit", "-m", "init"]);
  return repo;
}

async function preparedWorkspace(
  name: string,
  checkSource = "process.exit(0)",
): Promise<PreparedWorkspace> {
  const repo = await repository(name, checkSource);
  const baseRevision = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["switch", "-c", "feat/docs"]);
  return {
    schema: PREPARED_WORKSPACE_SCHEMA,
    mode: "branch",
    repository: repo,
    baseBranch: "main",
    baseRevision,
    workBranch: "feat/docs",
    directDefaultBranchAuthorized: false,
    preExistingChangedPaths: [],
    evidence: ["prepared by test"],
    scope: `Only ${repo}`,
  };
}

function verificationCheck(workspace: PreparedWorkspace): VerificationCheck {
  return {
    id: "docs",
    command: "npm",
    args: ["run", "check"],
    cwd: workspace.worktreePath ?? workspace.repository,
    timeoutMs: 10_000,
    maxOutputChars: 100_000,
    readOnly: true,
    baseEligible: false,
    changedFileScope: false,
    findingFormat: "text",
  };
}

function ranInclude(state: { steps: { nodeId: string }[] }, mount: string): boolean {
  return state.steps.some((step) => step.nodeId === mount || step.nodeId.startsWith(`${mount}/`));
}

async function run(executor: ScriptedExecutor, input: unknown) {
  return await new WorkflowEngine({
    executor,
    outputRoot: await makeTempDir("builtin-autodoc"),
  }).run(autodocWorkflow, input);
}

describe("built-in autodoc", () => {
  it("rejects malformed input and agent contracts", async () => {
    const parse = autodocWorkflow.input;
    if (parse === undefined) throw new Error("missing autodoc input parser");
    expect(() => parse(null)).toThrow(/object/);
    expect(() => parse({ task: "" })).toThrow(/non-empty/);
    expect(() => parse({ task: "demo", documents: "bad" })).toThrow(/array/);
    expect(() => parse({ task: "demo", repository: "relative" })).toThrow(/absolute/);
    expect(() => parse({ task: "demo", workspaceMode: "legacy" })).toThrow(/workspaceMode/);
    expect(() =>
      parse({
        task: "demo",
        plan: {},
        documentation: { status: "stale", planDigest: digest({}), documents: [] },
      }),
    ).toThrow(/status/);
    expect(() =>
      parse({
        task: "demo",
        plan: {},
        documentation: { status: "current", planDigest: digest({}), documents: "bad" },
      }),
    ).toThrow(/array/);
    expect(parse({ task: "demo", repository: "/tmp/repository/../resolved" })).toMatchObject({
      repository: path.resolve("/tmp/repository/../resolved"),
    });

    const validate = async (nodeId: string, value: unknown) => {
      const node = autodocWorkflow.nodes[nodeId];
      if (node?.nodeType !== "agent" || node.validate === undefined) {
        throw new Error(`${nodeId} is not validated`);
      }
      return await node.validate(value, {
        input: { task: "demo", plan: {} },
        outputs: {},
        results: {},
        state: { steps: [] },
        signal: new AbortController().signal,
      } as never);
    };
    await expect(validate("locatePlan", { route: "other" })).rejects.toThrow(/route/);
    await expect(
      validate("locatePlan", { route: "found", sources: [], reason: "reason", evidence: null }),
    ).rejects.toThrow(/include the selected plan/);
    await expect(
      validate("locatePlan", {
        route: "blocked",
        sources: [3],
        reason: "reason",
        evidence: null,
      }),
    ).rejects.toThrow(/strings/);
    await expect(
      validate("inspectDocumentation", {
        route: "current",
        files: "bad",
        reason: "reason",
        evidence: null,
      }),
    ).rejects.toThrow(/array/);
    await expect(
      validate("inspectDocumentation", {
        route: "current",
        files: [],
        digests: { file: 3 },
        reason: "reason",
        evidence: null,
      }),
    ).rejects.toThrow(/values/);
    await expect(validate("updateDocumentation", { updated: false })).rejects.toThrow(/updated/);
  });

  it("reuses current documentation when its plan digest matches", async () => {
    const plan = { summary: "selected plan", steps: ["one"] };
    const documents = ["docs/spec.md", "docs/plans/plan.md"];
    const executor = new ScriptedExecutor();
    const { state } = await run(executor, {
      task: "implement feature",
      plan,
      documentation: {
        status: "current",
        planDigest: digest(plan),
        documents,
      },
    });

    expect(state.status).toBe("completed");
    expect(state.steps.map((step) => step.nodeId)).toEqual(["prepare", "finalize"]);
    expect(ranInclude(state, "workspace")).toBe(false);
    expect(ranInclude(state, "verification")).toBe(false);
    expect(executor.requests).toEqual([]);
    expect(state.finalOutput).toMatchObject({
      status: "ready",
      plan,
      planDigest: digest(plan),
      documentation: { state: "current", files: documents },
      verification: { route: "ready", reason: "Canonical documentation was already current." },
    });
  });

  it("inspects documentation when the supplied plan digest does not match", async () => {
    const plan = { summary: "selected plan" };
    const executor = new ScriptedExecutor().respond("inspectDocumentation", {
      output: {
        route: "current",
        files: ["docs/plan.md"],
        reason: "Current for the selected plan.",
        evidence: "checked",
      },
    });
    const { state } = await run(executor, {
      task: "implement feature",
      plan,
      documentation: {
        status: "current",
        planDigest: digest({ summary: "old plan" }),
        documents: ["docs/old-plan.md"],
      },
    });

    expect(state.status).toBe("completed");
    expect(executor.requests.map((request) => request.contract.nodeId)).toEqual([
      "inspectDocumentation",
    ]);
    expect(ranInclude(state, "workspace")).toBe(false);
    expect(ranInclude(state, "verification")).toBe(false);
  });

  it("adopts current canonical documentation without a write step", async () => {
    const executor = new ScriptedExecutor().respond("inspectDocumentation", {
      output: {
        route: "current",
        files: ["docs/spec.md", "docs/plans/plan.md"],
        reason: "The selected plan is already complete.",
        evidence: "checked",
      },
    });
    const { state } = await run(executor, {
      task: "implement feature",
      plan: { steps: ["one"] },
    });
    expect(state.status).toBe("completed");
    expect(state.steps.map((step) => step.nodeId)).not.toContain("updateDocumentation");
    expect(ranInclude(state, "workspace")).toBe(false);
    expect(ranInclude(state, "verification")).toBe(false);
    expect(state.finalOutput).toMatchObject({
      status: "ready",
      documentation: { state: "current" },
      verification: { route: "ready" },
    });
  });

  it("treats input.plan as the selected plan in the inspection prompt", async () => {
    const plan = { summary: "selected plan", excluded: ["redesign"] };
    const executor = new ScriptedExecutor().respond("inspectDocumentation", {
      output: {
        route: "current",
        files: ["docs/plan.md"],
        reason: "Current.",
        evidence: "checked",
      },
    });
    await run(executor, { task: "implement feature", plan });

    const prompt = executor.requests[0]?.prompt ?? "";
    expect(prompt).toContain("input.plan is the selected plan");
    expect(prompt).toContain(JSON.stringify(plan));
  });

  it("updates and verifies stale documentation", async () => {
    const workspace = await preparedWorkspace("builtin-autodoc-repository");
    const executor = new ScriptedExecutor()
      .respond("inspectDocumentation", {
        output: {
          route: "update",
          files: ["docs/spec.md", "docs/plans/plan.md"],
          reason: "The plan changed.",
          evidence: "stale digest",
        },
      })
      .respond("updateDocumentation", {
        output: {
          updated: true,
          files: ["docs/spec.md", "docs/plans/plan.md"],
          summary: "Recorded the selected plan.",
        },
      });
    const { state } = await run(executor, {
      task: "implement feature",
      plan: { steps: ["one"] },
      repository: workspace.repository,
      preparedWorkspace: workspace,
      verificationChecks: [verificationCheck(workspace)],
    });
    expect(state.status).toBe("completed");
    expect(ranInclude(state, "workspace")).toBe(true);
    expect(ranInclude(state, "verification")).toBe(true);
    expect(state.steps.map((step) => step.nodeId)).not.toContain("verifyDocumentation");
    expect(state.finalOutput).toMatchObject({
      status: "ready",
      documentation: { state: "updated" },
      verification: { route: "ready" },
      workspace,
    });
    const updatePrompt = executor.requests.find(
      (request) => request.contract.nodeId === "updateDocumentation",
    )?.prompt;
    expect(updatePrompt).toContain("Prepared workspace:");
    expect(updatePrompt).toContain(workspace.repository);
    expect(executor.requests.map((request) => request.contract.nodeId)).toEqual([
      "inspectDocumentation",
      "updateDocumentation",
    ]);
  });

  it("limits verification to named files and reports verification failures", async () => {
    const workspace = await preparedWorkspace(
      "builtin-autodoc-verification-repository",
      "process.exit(1)",
    );
    const files = ["docs/spec.md", "docs/plans/plan.md"];
    const executor = new ScriptedExecutor()
      .respond("inspectDocumentation", {
        output: {
          route: "update",
          files,
          reason: "The selected plan is stale.",
          evidence: "stale digest",
        },
      })
      .respond("updateDocumentation", {
        output: {
          updated: true,
          files,
          summary: "Recorded the selected plan.",
        },
      })
      .respond("verification/semanticRepair", {
        output: { changedFiles: [], result: "No in-scope repair was available." },
      });

    const { state } = await run(executor, {
      task: "implement feature",
      plan: { steps: ["one"] },
      repository: workspace.repository,
      preparedWorkspace: workspace,
      verificationChecks: [verificationCheck(workspace)],
    });

    expect(ranInclude(state, "workspace")).toBe(true);
    expect(ranInclude(state, "verification")).toBe(true);
    expect(state.steps.map((step) => step.nodeId)).not.toContain("verifyDocumentation");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      sourceNode: "autodoc/verification",
      evidence: {
        qualifiedNode: "autodoc/verification",
        changedFiles: files,
        relatedFailures: [{ checkId: "docs" }],
      },
    });
    expect(String((state.finalOutput as { reason?: string }).reason)).toMatch(
      /fingerprint repeated|repair attempt limit|Current-change failures/i,
    );
  });

  it("refuses a documentation mutation without a prepared repository", async () => {
    const executor = new ScriptedExecutor().respond("inspectDocumentation", {
      output: {
        route: "update",
        files: ["docs/spec.md"],
        reason: "The selected plan is stale.",
        evidence: "stale digest",
      },
    });
    const { state } = await run(executor, {
      task: "implement feature",
      plan: { steps: ["one"] },
    });
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      sourceNode: "autodoc/workspaceGuard",
      reason: "Updating canonical documentation requires an explicit repository path.",
      evidence: ["repository was not supplied", "preparedWorkspace was not supplied"],
    });
    expect(state.steps.map((step) => step.nodeId)).not.toContain("updateDocumentation");
    expect(ranInclude(state, "workspace")).toBe(false);
    expect(executor.requests.map((request) => request.contract.nodeId)).toEqual([
      "inspectDocumentation",
    ]);
  });

  it("finds an existing plan from context without devising one", async () => {
    const plan = { summary: "existing plan", steps: ["one"] };
    const executor = new ScriptedExecutor()
      .respond("locatePlan", {
        output: {
          route: "found",
          plan,
          sources: ["conversation"],
          reason: "One clear plan is present.",
          evidence: "current context",
        },
      })
      .respond("inspectDocumentation", {
        output: {
          route: "current",
          files: ["docs/plans/plan.md"],
          reason: "Current.",
          evidence: "checked",
        },
      });
    const { state } = await run(executor, { task: "implement feature" });
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({ status: "ready", plan });
    expect(executor.requests.map((request) => request.contract.nodeId)).toEqual([
      "locatePlan",
      "inspectDocumentation",
    ]);
    expect(ranInclude(state, "workspace")).toBe(false);
  });

  it("blocks when no selected plan exists", async () => {
    const executor = new ScriptedExecutor().respond("locatePlan", {
      output: {
        route: "blocked",
        sources: [],
        reason: "No clear selected plan exists.",
        evidence: null,
      },
    });
    const { state } = await run(executor, { task: "implement feature" });
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "No clear selected plan exists.",
    });
  });
});
