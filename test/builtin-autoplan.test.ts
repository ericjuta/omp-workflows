import { describe, expect, it } from "vitest";
import autoplanWorkflow from "../src/builtins/autoplan.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

const ORIGINAL_USER_INSTRUCTIONS =
  "  Solve the complete demo request.\n\nKeep the queued requirement exactly.  ";

function commonExecutor(selection: Record<string, unknown>) {
  return new ScriptedExecutor()
    .respond("captureIntent", {
      output: { originalUserInstructions: ORIGINAL_USER_INSTRUCTIONS },
    })
    .respond("frame", {
      output: {
        problem: "demo",
        success: ["tests pass"],
        inScope: ["current repository"],
        outOfScope: ["upstream library"],
        constraints: [],
        controlBoundary: "current repository",
      },
    })
    .respond("solutions", {
      output: {
        solution: "use the public extension point",
        rationale: "owned and maintainable",
        parts: ["adapter"],
        tradeoffs: ["one local layer"],
      },
    })
    .respond("holyGrail", {
      output: {
        ideal: "upstream supports it directly",
        outsideDependencies: ["upstream release"],
        additionalValue: ["less local code"],
      },
    })
    .respond("select", { output: selection });
}

describe("built-in autoplan", () => {
  it("selects a practical plan and records plan lineage", async () => {
    const previousPlan = { summary: "old plan" };
    const executor = commonExecutor({
      status: "ready",
      selected: "use the public extension point",
      why: "it stays in scope",
      relationshipToIdeal: "can be removed if upstream later supports it",
      excluded: ["upstream change"],
      compromises: ["local adapter"],
    }).respond("plan", {
      output: {
        summary: "add adapter",
        steps: [{ change: "add adapter", where: "src", verification: "tests" }],
        contracts: [],
        tests: ["unit test"],
        risks: [],
        boundaries: ["no upstream patch"],
      },
    });
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoplan"),
    });

    const { state } = await engine.run(autoplanWorkflow, {
      problem: "solve demo",
      previousPlan,
      newEvidence: { failure: "old plan failed" },
    });

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "ready",
      originalUserInstructions: ORIGINAL_USER_INSTRUCTIONS,
      changed: true,
      planDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      previousPlanDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    const prompts = Object.fromEntries(
      executor.requests.map((request) => [request.contract.nodeId, request.prompt]),
    );
    expect(executor.requests[0]?.contract.nodeId).toBe("captureIntent");
    expect(prompts.captureIntent).toContain(
      "Include everything that the user has instructed for the intended purpose in the given context.",
    );
    expect(prompts.captureIntent).toContain(
      "Do not summarize, rewrite, explain, label, omit, or add instructions.",
    );
    expect(prompts.captureIntent).toContain("Do not return an array or message objects.");
    expect(prompts.frame).toContain("State the goal and describe what success looks like");
    expect(prompts.solutions).toContain("Design the best practical solution");
    expect(prompts.solutions).toContain("Long term elegant and production ready");
    expect(prompts.holyGrail).toContain("Describe the Holy grail");
    expect(prompts.holyGrail).toContain("Is this the Holy grail");
    expect(prompts.select).toContain("Select the right solution yourself");
    expect(prompts.select).toContain("Holy grail");
    expect(prompts.plan).toContain("name the change, its location, and the evidence");
    for (const nodeId of ["frame", "solutions", "holyGrail", "select", "plan"]) {
      expect(prompts[nodeId]).toContain(ORIGINAL_USER_INSTRUCTIONS);
    }
  });

  it("blocks only when no in-scope solution exists", async () => {
    const executor = commonExecutor({
      status: "blocked",
      selected: "none",
      why: "the required interface is unavailable",
      relationshipToIdeal: "the ideal requires external authority",
      excluded: ["unapproved upstream change"],
      compromises: [],
      blocker: "No public interface can meet the success criteria.",
    });
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoplan-blocked"),
    });

    const { state } = await engine.run(autoplanWorkflow, { problem: "solve demo" });

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      originalUserInstructions: ORIGINAL_USER_INSTRUCTIONS,
      reason: "No public interface can meet the success criteria.",
    });
    expect(state.steps.some((step) => step.nodeId === "plan")).toBe(false);
  });

  it("rejects empty original user instructions", async () => {
    const executor = new ScriptedExecutor().respond("captureIntent", {
      output: { originalUserInstructions: " \n\t " },
    });
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoplan-empty-intent"),
    });

    const { state } = await engine.run(autoplanWorkflow, { problem: "demo" });
    expect(state.error).toMatch(/originalUserInstructions must be a non-empty string/);
  });

  it("projects the complete selected plan into the final presentation", async () => {
    const finalDetail = `final detail ${"x".repeat(60_000)}`;
    const finalOutput = {
      status: "ready",
      plan: { summary: "complete plan", finalDetail },
    };
    const presentation = autoplanWorkflow.presentationPrompt;
    expect(typeof presentation).toBe("function");
    if (typeof presentation !== "function") throw new Error("expected presentation function");

    const prompt = await presentation({
      state: { finalOutput } as never,
      finalOutput,
      signal: new AbortController().signal,
    });

    expect(prompt).toContain(finalDetail);
    expect(prompt).toContain("holy grail");
    expect(prompt).toContain("Do not impose a character or sentence limit");
    expect(prompt?.length).toBeGreaterThan(50_000);
  });
});
