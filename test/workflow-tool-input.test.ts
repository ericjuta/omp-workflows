import { describe, expect, it } from "vitest";
import { parseToolInput } from "../src/workflows/tool-input-parse.js";
import {
  parseWorkflowSubmissionInput,
  parseWorkflowToolInput,
  WorkflowActionSchemas,
  WorkflowSubmissionToolParameters,
  WorkflowToolParameters,
} from "../src/workflows/tool-input.js";

const update = {
  type: "progress",
  key: "items",
  data: { completed: 2, total: 5 },
};

describe("workflow tool input", () => {
  it.each([
    { action: "list" },
    { action: "list", offset: 10 },
    { action: "list", kind: "definitions" },
    { action: "list", kind: "runs", offset: 5 },
    { action: "start", workflow: "monitor" },
    { action: "start", workflow: "monitor", input: { task: "check" } },
    { action: "status" },
    { action: "status", runId: "run-1" },
    { action: "pause" },
    { action: "resume" },
    { action: "cancel" },
    { action: "cancel", runId: "run-1" },
    { action: "answer", input: { approved: true } },
    { action: "answer", input: null, runId: "run-1" },
    { action: "update", step: "check", attempt: "try-1", update },
    { action: "submit", step: "check", attempt: "try-1", output: { result: "ok" } },
  ])("accepts the exact $action input", (input) => {
    expect(parseWorkflowToolInput(input)).toEqual(input);
  });

  it("removes OMP host invocation intent before action validation", () => {
    expect(parseWorkflowToolInput({ i: "Listing Workflows", action: "list" })).toEqual({
      action: "list",
    });
    expect(
      parseWorkflowSubmissionInput({
        i: "Submitting Workflow Step",
        action: "submit",
        step: "check",
        attempt: "try-1",
        output: { result: "ok" },
      }),
    ).toEqual({
      action: "submit",
      step: "check",
      attempt: "try-1",
      output: { result: "ok" },
    });
    expect(() =>
      parseWorkflowToolInput({ i: "Listing Workflows", action: "list", extra: true }),
    ).toThrow("Invalid workflow tool input");
    expect(() =>
      parseWorkflowSubmissionInput({
        i: "Submitting Workflow Step",
        action: "submit",
        step: "check",
        attempt: "try-1",
        output: null,
        extra: true,
      }),
    ).toThrow("Invalid workflow submission tool input");
  });

  it.each([
    { action: "unknown" },
    { action: "start" },
    { action: "answer" },
    { action: "update", step: "check", attempt: "try-1" },
    { action: "submit", step: "check", attempt: "try-1" },
    { action: "pause", runId: "run-1" },
    { action: "list", workflow: "monitor" },
    { action: "list", kind: "other" },
    {
      action: "update",
      step: "check",
      attempt: "try-1",
      update: { type: "progress", key: "items", data: [] },
    },
  ])("rejects invalid action input %#", (input) => {
    expect(() => parseWorkflowToolInput(input)).toThrow("Invalid workflow tool input");
  });

  it("keeps the RPC bridge limited to update and submit", () => {
    expect(
      parseWorkflowSubmissionInput({ action: "update", step: "check", attempt: "try-1", update }),
    ).toEqual({ action: "update", step: "check", attempt: "try-1", update });
    expect(
      parseWorkflowSubmissionInput({
        action: "submit",
        step: "check",
        attempt: "try-1",
        output: null,
      }),
    ).toEqual({ action: "submit", step: "check", attempt: "try-1", output: null });
    expect(() => parseWorkflowSubmissionInput({ action: "start", workflow: "monitor" })).toThrow(
      "Invalid workflow submission tool input",
    );
  });

  it("enumerates every action key on the provider schema", () => {
    expect(WorkflowToolParameters.properties.action).toMatchObject({
      type: "string",
      enum: Object.keys(WorkflowActionSchemas),
    });
  });

  it("publishes provider-compatible object roots", () => {
    expect(WorkflowToolParameters).toMatchObject({
      type: "object",
      required: ["action"],
      properties: {
        action: {
          enum: Object.keys(WorkflowActionSchemas),
        },
      },
    });
    expect(WorkflowToolParameters).not.toHaveProperty("anyOf");
    expect(Object.keys(WorkflowToolParameters.properties).sort()).toEqual([
      "action",
      "attempt",
      "input",
      "kind",
      "offset",
      "output",
      "runId",
      "step",
      "update",
      "workflow",
    ]);

    expect(WorkflowSubmissionToolParameters).toMatchObject({
      type: "object",
      required: ["action"],
      properties: { action: { enum: ["update", "submit"] } },
    });
    expect(WorkflowSubmissionToolParameters).not.toHaveProperty("anyOf");
    expect(Object.keys(WorkflowSubmissionToolParameters.properties).sort()).toEqual([
      "action",
      "attempt",
      "output",
      "step",
      "update",
    ]);
  });

  it("parses through a host safeParse when the schema provides one", () => {
    const schema = {
      safeParse(value: unknown) {
        if (value === "ok") return { success: true as const, data: { action: "list" } };
        return { success: false as const };
      },
    };
    expect(parseToolInput(schema as never, "ok", "workflow")).toEqual({
      action: "list",
    });
    expect(() => parseToolInput(schema as never, "bad", "workflow")).toThrow(
      "Invalid workflow tool input: invalid value",
    );
  });
});
