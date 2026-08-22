import { describe, expect, it } from "vitest";
import { parseHitlToolInput } from "../src/host/hitl-tool.js";

describe("parseHitlToolInput", () => {
  it("accepts the current decision or one valid run id", () => {
    expect(parseHitlToolInput({})).toEqual({});
    expect(parseHitlToolInput({ runId: "run-123" })).toEqual({ runId: "run-123" });
  });

  it("removes the OMP invocation intent before validation", () => {
    expect(parseHitlToolInput({ i: "Opening HITL decision", runId: "run-123" })).toEqual({
      runId: "run-123",
    });
  });

  it("rejects answers and malformed run ids", () => {
    expect(() => parseHitlToolInput({ choice: "continue" })).toThrow(/hitl tool input/);
    expect(() => parseHitlToolInput({ runId: "bad run" })).toThrow(/hitl tool input/);
  });
});
