import { describe, expect, it } from "vitest";
import {
  WORKFLOW_START_CHANNEL,
  WORKFLOW_START_RESULT_CHANNEL,
  parseWorkflowStartRequest,
} from "../src/workflows/external-start.js";

describe("external workflow starts", () => {
  it("uses stable event channel names", () => {
    expect(WORKFLOW_START_CHANNEL).toBe("pi-workflows:start");
    expect(WORKFLOW_START_RESULT_CHANNEL).toBe("pi-workflows:start-result");
  });

  it("normalizes a valid request", () => {
    expect(
      parseWorkflowStartRequest({ requestId: " request-1 ", ref: " ./flow.ts ", input: 42 }),
    ).toEqual({ requestId: "request-1", ref: "./flow.ts", input: 42 });
  });

  it.each([
    undefined,
    null,
    {},
    { requestId: "request-1", ref: "flow" },
    { requestId: "", ref: "flow", input: {} },
    { requestId: "request-1", ref: "", input: {} },
    { requestId: "x".repeat(201), ref: "flow", input: {} },
    { requestId: "request-1", ref: "x".repeat(4_097), input: {} },
  ])("rejects malformed requests", (request) => {
    expect(parseWorkflowStartRequest(request)).toBeUndefined();
  });
});
