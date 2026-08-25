import path from "node:path";
import { describe, expect, it } from "vitest";
import autodocWorkflow from "../src/builtins/autodoc.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { digest } from "../src/workflows/human-decision.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

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
    await expect(validate("verifyDocumentation", { passed: "yes" })).rejects.toThrow(/boolean/);
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
    expect(executor.requests).toEqual([]);
    expect(state.finalOutput).toMatchObject({
      status: "ready",
      plan,
      planDigest: digest(plan),
      documentation: { state: "current", files: documents },
      verification: { passed: true },
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
    expect(state.finalOutput).toMatchObject({
      status: "ready",
      documentation: { state: "current" },
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
    const repository = await makeTempDir("builtin-autodoc-repository");
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
      })
      .respond("verifyDocumentation", {
        output: {
          passed: true,
          commands: [{ command: "docs-check", outcome: "passed" }],
          failures: [],
        },
      });
    const { state } = await run(executor, {
      task: "implement feature",
      plan: { steps: ["one"] },
      repository,
    });
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "ready",
      documentation: { state: "updated" },
      verification: { passed: true },
    });
    for (const nodeId of ["updateDocumentation", "verifyDocumentation"]) {
      const prompt = executor.requests.find(
        (request) => request.contract.nodeId === nodeId,
      )?.prompt;
      expect(prompt).toContain(`Prepared repository: ${repository}`);
      expect(prompt).toContain("Preserve every pre-existing untracked and ignored file");
      expect(prompt).toContain("Never run git clean");
    }
  });

  it("limits verification to named files and reports verification failures", async () => {
    const repository = await makeTempDir("builtin-autodoc-verification-repository");
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
      .respond("verifyDocumentation", {
        output: {
          passed: false,
          commands: [{ command: "simpledoc check docs/spec.md", outcome: "failed" }],
          failures: ["docs/spec.md has a broken link"],
        },
      });

    const { state } = await run(executor, {
      task: "implement feature",
      plan: { steps: ["one"] },
      repository,
    });
    const verifyRequest = executor.requests.find(
      (request) => request.contract.nodeId === "verifyDocumentation",
    );

    expect(verifyRequest?.prompt).toContain(`Target documentation files: ${JSON.stringify(files)}`);
    expect(verifyRequest?.prompt).toContain("not repo-wide SimpleDoc");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "docs/spec.md has a broken link",
      evidence: ["docs/spec.md has a broken link"],
    });
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
    expect(state.status).toBe("failed");
    expect(state.error).toContain("autodoc mutation repository");
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
