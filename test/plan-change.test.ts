import path from "node:path";
import { describe, expect, it } from "vitest";
import planChangeWorkflow from "../src/builtins/plan-change.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { digest } from "../src/workflows/human-decision.js";
import type { HumanDecisionRequest } from "../src/workflows/types.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

function planningExecutor(plan: unknown): ScriptedExecutor {
  return new ScriptedExecutor()
    .respond("design/captureIntent", {
      output: { originalUserInstructions: "change the implementation" },
    })
    .respond("design/frame", {
      output: {
        problem: "change the implementation",
        success: ["complete"],
        inScope: ["repository"],
        outOfScope: [],
        constraints: [],
        controlBoundary: "repository",
      },
    })
    .respond("design/solutions", {
      output: {
        solution: "use the selected plan",
        rationale: "it is in scope",
        parts: ["implement"],
        tradeoffs: [],
      },
    })
    .respond("design/holyGrail", {
      output: { ideal: "complete", outsideDependencies: [], additionalValue: [] },
    })
    .respond("design/select", {
      output: {
        status: "ready",
        selected: "use the selected plan",
        why: "it is practical",
        relationshipToIdeal: "same result",
        excluded: [],
        compromises: [],
      },
    })
    .respond("design/plan", { output: plan })
    .respond("documentation/inspectDocumentation", {
      output: {
        route: "current",
        files: ["docs/plan.md"],
        digests: {},
        reason: "The selected plan is current.",
        evidence: "checked",
      },
    });
}

describe("plan-change workflow", () => {
  it("budgets enough graph steps for the supported 20-replan limit", () => {
    expect(planChangeWorkflow.maxSteps).toBeGreaterThanOrEqual(300);
  });

  it("rejects unknown input fields before applying approval defaults", async () => {
    const parseInput = planChangeWorkflow.input;
    if (parseInput === undefined) throw new Error("plan-change input parser is missing");
    expect(parseInput({ task: "change the implementation", repository: "." })).toMatchObject({
      repository: path.resolve("."),
    });
    const engine = new WorkflowEngine({
      outputRoot: await makeTempDir("plan-change-invalid"),
      executor: planningExecutor({ summary: "plan", steps: ["one"] }),
    });
    await expect(
      engine.run(planChangeWorkflow, {
        task: "change the implementation",
        approvals: { mode: "required" },
      }),
    ).rejects.toThrow(/unknown field approvals/);
  });

  it("uses the shared skip policy without creating a human decision", async () => {
    const result = await new WorkflowEngine({
      outputRoot: await makeTempDir("plan-change-skip"),
      executor: planningExecutor({ summary: "plan", steps: ["one"] }),
    }).run(planChangeWorkflow, {
      task: "change the implementation",
      approval: { mode: "skip" },
    });
    expect(result.state.status).toBe("completed");
    expect(result.state.finalOutput).toMatchObject({
      status: "ready",
      plan: { summary: "plan", steps: ["one"] },
      documents: ["docs/plan.md"],
      approval: { provenance: "skipped" },
    });
    expect(result.state.steps.map((step) => step.nodeId)).not.toContain("approval/approve");
  });

  it("passes a matching current-document receipt to autodoc", async () => {
    const plan = { summary: "documented plan", steps: ["one"] };
    const result = await new WorkflowEngine({
      outputRoot: await makeTempDir("plan-change-documented"),
      executor: planningExecutor(plan),
    }).run(planChangeWorkflow, {
      task: "change the implementation",
      documentation: {
        status: "current",
        planDigest: digest(plan),
        documents: ["docs/current-plan.md"],
      },
      approval: { mode: "skip" },
    });

    expect(result.state.status).toBe("completed");
    expect(result.state.finalOutput).toMatchObject({
      status: "ready",
      documents: ["docs/current-plan.md"],
      documentation: { state: "current", files: ["docs/current-plan.md"] },
    });
    expect(result.state.steps.map((step) => step.nodeId)).not.toContain(
      "documentation/inspectDocumentation",
    );
  });

  it("uses the default autonomous policy for a new plan", async () => {
    const result = await new WorkflowEngine({
      outputRoot: await makeTempDir("plan-change-auto"),
      executor: planningExecutor({ summary: "plan", steps: ["one"] }),
    }).run(planChangeWorkflow, { task: "change the implementation" });
    expect(result.state.status).toBe("waiting");
    const request = result.state.finalOutput as HumanDecisionRequest;
    expect(request).toMatchObject({
      audience: "operator",
      defaultResponse: { choice: "continue" },
    });
    expect(Date.parse(request.expiresAt ?? "") - Date.parse(request.createdAt)).toBe(600_000);
  });

  it("blocks an unchanged plan before documentation or approval", async () => {
    const plan = { summary: "same", steps: ["one"] };
    const result = await new WorkflowEngine({
      outputRoot: await makeTempDir("plan-change-unchanged"),
      executor: planningExecutor(plan),
    }).run(planChangeWorkflow, {
      task: "change the implementation",
      previousPlan: plan,
      approval: { mode: "required" },
    });
    expect(result.state.status).toBe("completed");
    expect(result.state.finalOutput).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("same plan"),
    });
    expect(result.state.steps.map((step) => step.nodeId)).not.toContain(
      "documentation/inspectDocumentation",
    );
    expect(result.state.steps.map((step) => step.nodeId)).not.toContain("approval/approve");
  });
});
