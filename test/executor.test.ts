import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyAssistantTurn,
  ConversationStepExecutor,
  submissionInstruction,
  type PromptDelivery,
} from "../src/extension/executor.js";
import type { AgentStepRequest } from "../src/workflows/types.js";

function makeRequest(overrides: Partial<AgentStepRequest> = {}): AgentStepRequest {
  return {
    contract: {
      runId: "r1",
      workflowName: "w",
      nodeId: "step1",
      attemptId: "a1",
      expectedOutput: `{ "x": 1 }`,
    },
    prompt: "Do the step",
    presentation: { runTitle: "Run one", statusDetail: "Doing the step" },
    accept: async (output) => ({ ok: true, value: output }),
    ...overrides,
  };
}

function makeExecutor(
  options: {
    maxNudges?: number;
    maxActivationRetries?: number;
    activationTimeoutMs?: number;
    maxProviderRetries?: number;
  } = {},
) {
  const sent: PromptDelivery[] = [];
  const executor = new ConversationStepExecutor({
    sendPrompt: (delivery) => {
      sent.push(delivery);
      delivery.onSent(delivery.streaming);
    },
    ...options,
  });
  return { executor, sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ConversationStepExecutor", () => {
  it("delivers the prompt and resolves on an accepted submission", async () => {
    const { executor, sent } = makeExecutor();
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      contract: {
        runId: "r1",
        workflowName: "w",
        nodeId: "step1",
        attemptId: "a1",
        expectedOutput: `{ "x": 1 }`,
      },
      presentation: { runTitle: "Run one", statusDetail: "Doing the step" },
      kind: "step",
      streaming: false,
    });
    expect(sent[0]?.prompt).toContain("Do the step");
    expect(sent[0]?.prompt).toContain(submissionInstruction(makeRequest().contract));
    expect(executor.pendingStepId).toBe("step1");

    const result = await executor.submit("step1", "a1", { x: 1 });
    expect(result).toEqual({
      accepted: true,
      message: 'Output accepted for step "step1".',
    });
    await expect(stepPromise).resolves.toEqual({ output: { x: 1 } });
    expect(executor.pendingStepId).toBeNull();
  });

  it("exposes the pending step tool policy", async () => {
    const { executor } = makeExecutor();
    expect(executor.pendingToolPolicy).toBeUndefined();

    const request = makeRequest({
      contract: {
        ...makeRequest().contract,
        toolPolicy: "observation-only",
      },
    });
    const stepPromise = executor.runAgentStep(request, new AbortController().signal);
    expect(executor.pendingToolPolicy).toBe("observation-only");

    await executor.submit("step1", "a1", { x: 1 });
    await stepPromise;
    expect(executor.pendingToolPolicy).toBeUndefined();
  });

  it("attaches the recorded conversation range to accepted submissions", async () => {
    const sent: PromptDelivery[] = [];
    const recorded: string[] = [];
    const executor = new ConversationStepExecutor({
      sendPrompt: (delivery) => {
        sent.push(delivery);
        delivery.onSent(delivery.streaming);
        // The prompt entry and the assistant reply land after the mark.
        recorded.push("p1", "a1");
      },
      conversation: {
        mark: () => recorded.length,
        rangeSince: (mark) =>
          recorded.length > mark
            ? {
                firstEntryId: recorded[mark] as string,
                lastEntryId: recorded.at(-1) as string,
              }
            : undefined,
      },
    });
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);
    await executor.submit("step1", "a1", { x: 1 });
    await expect(stepPromise).resolves.toEqual({
      output: { x: 1 },
      conversation: { firstEntryId: "p1", lastEntryId: "a1" },
    });
  });

  it("marks deliveries as streaming when the agent is mid-run", async () => {
    const { executor, sent } = makeExecutor();
    executor.setStreaming(true);
    void executor.runAgentStep(makeRequest(), new AbortController().signal);
    expect(sent[0]?.streaming).toBe(true);
    await executor.submit("step1", "a1", {});
  });

  it("rejects submissions when no step is pending", async () => {
    const { executor } = makeExecutor();
    const result = await executor.submit("step1", "a1", {});
    expect(result.accepted).toBe(false);
    expect(result.message).toMatch(/No workflow step/);
  });

  it("rejects submissions for the wrong step id", async () => {
    const { executor } = makeExecutor();
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);

    const result = await executor.submit("other", "a1", {});
    expect(result.accepted).toBe(false);
    expect(result.message).toMatch(/pending step is "step1"/);

    await executor.submit("step1", "a1", {});
    await stepPromise;
  });

  it("rejects submissions with a stale attempt id", async () => {
    const { executor } = makeExecutor();
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);

    const stale = await executor.submit("step1", "a0", {});
    expect(stale.accepted).toBe(false);
    expect(stale.message).toMatch(/Stale attempt id "a0".*pending attempt is "a1"/);
    expect(executor.pendingStepId).toBe("step1");

    await executor.submit("step1", "a1", {});
    await stepPromise;
  });

  it("surfaces validation errors and keeps the step pending", async () => {
    const { executor } = makeExecutor();
    const request = makeRequest({
      accept: async (output) =>
        (output as { ok?: boolean }).ok === true
          ? { ok: true, value: output }
          : { ok: false, error: "bad shape" },
    });
    const stepPromise = executor.runAgentStep(request, new AbortController().signal);

    const rejected = await executor.submit("step1", "a1", { ok: false });
    expect(rejected.accepted).toBe(false);
    expect(rejected.message).toMatch(/bad shape/);
    expect(executor.pendingStepId).toBe("step1");

    const accepted = await executor.submit("step1", "a1", { ok: true });
    expect(accepted.accepted).toBe(true);
    await stepPromise;
  });

  it("rejects the step when the signal aborts", async () => {
    const { executor } = makeExecutor();
    const abort = new AbortController();
    const stepPromise = executor.runAgentStep(makeRequest(), abort.signal);
    abort.abort(new Error("timed out"));
    await expect(stepPromise).rejects.toThrow(/timed out/);
    expect(executor.pendingStepId).toBeNull();
  });

  it("reports an engine abort exactly once", async () => {
    const aborted: { attemptId: string; reason: unknown }[] = [];
    const abort = new AbortController();
    const executor = new ConversationStepExecutor({
      sendPrompt: () => undefined,
      onAbort: (contract, reason) => aborted.push({ attemptId: contract.attemptId, reason }),
    });
    const stepPromise = executor.runAgentStep(makeRequest(), abort.signal);

    abort.abort(new Error("timed out"));
    abort.abort(new Error("again"));

    await expect(stepPromise).rejects.toThrow(/timed out/);
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.attemptId).toBe("a1");
    expect(aborted[0]?.reason).toEqual(new Error("timed out"));
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { executor, sent } = makeExecutor();
    const abort = new AbortController();
    abort.abort(new Error("gone"));
    await expect(executor.runAgentStep(makeRequest(), abort.signal)).rejects.toThrow(/gone/);
    expect(sent).toEqual([]);
  });

  it("refuses concurrent steps", async () => {
    const { executor } = makeExecutor();
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);
    await expect(
      executor.runAgentStep(makeRequest(), new AbortController().signal),
    ).rejects.toThrow(/already awaiting/);
    await executor.submit("step1", "a1", {});
    await stepPromise;
  });

  it("nudges on settle up to the budget, then fails the step", async () => {
    const { executor, sent } = makeExecutor({ maxNudges: 2 });
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);
    executor.setStreaming(true);

    expect(executor.handleAgentSettled()).toBe(true);
    expect(executor.handleAgentSettled()).toBe(true);
    expect(sent).toHaveLength(3);
    expect(sent[1]?.prompt).toMatch(/Reminder: workflow step "step1"/);
    expect(sent[1]?.prompt).toContain(`{ "x": 1 }`);
    expect(sent[1]).toMatchObject({
      kind: "reminder",
      contract: { nodeId: "step1", attemptId: "a1" },
      presentation: { runTitle: "Run one", statusDetail: "Doing the step" },
    });

    expect(executor.handleAgentSettled()).toBe(false);
    await expect(stepPromise).rejects.toThrow(/without submitting step "step1"/);
    expect(executor.pendingStepId).toBeNull();
  });

  it("re-establishes attempt ownership for nudge and resume deliveries", async () => {
    const owners: string[] = [];
    const deliveries: PromptDelivery[] = [];
    const executor = new ConversationStepExecutor({
      sendPrompt: (delivery) => {
        deliveries.push(delivery);
        delivery.onSent(delivery.streaming);
      },
      conversation: {
        beginAttempt: (contract) => owners.push(contract.attemptId),
        mark: () => 0,
        rangeSince: () => undefined,
      },
    });
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);
    executor.setStreaming(true);
    expect(executor.handleAgentSettled()).toBe(true);
    executor.hold();
    expect(executor.handleAgentSettled()).toBe(false);
    executor.release();
    expect(owners).toEqual(["a1", "a1", "a1"]);
    expect(deliveries.map((delivery) => delivery.kind)).toEqual(["step", "reminder", "resume"]);
    expect(deliveries.every((delivery) => delivery.contract.attemptId === "a1")).toBe(true);
    const instruction = submissionInstruction(makeRequest().contract);
    expect(deliveries.every((delivery) => delivery.prompt.includes(instruction))).toBe(true);
    expect(deliveries.every((delivery) => !delivery.prompt.includes('"runId"'))).toBe(true);
    await executor.submit("step1", "a1", {});
    await stepPromise;
  });

  it("does not nudge or fail before the pending step sees an agent start", async () => {
    const { executor, sent } = makeExecutor({ maxNudges: 0 });
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);

    expect(executor.handleAgentSettled()).toBe(false);
    expect(sent).toHaveLength(1);
    expect(executor.pendingStepId).toBe("step1");

    await executor.submit("step1", "a1", {});
    await expect(stepPromise).resolves.toEqual({ output: {} });
  });

  it("does not arm activation until a deferred delivery is actually sent", async () => {
    vi.useFakeTimers();
    const sent: PromptDelivery[] = [];
    const executor = new ConversationStepExecutor({
      activationTimeoutMs: 100,
      sendPrompt: (delivery) => {
        sent.push(delivery);
        if (sent.length > 1) delivery.onSent(false);
      },
    });
    executor.setStreaming(true);
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);

    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toHaveLength(1);
    executor.setStreaming(false);
    sent[0]?.onSent(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.map((delivery) => delivery.kind)).toEqual(["step", "resume"]);

    executor.setStreaming(true);
    await executor.submit("step1", "a1", {});
    await stepPromise;
  });

  it("re-delivers once when a sent prompt never receives agent_start, then fails", async () => {
    vi.useFakeTimers();
    const { executor, sent } = makeExecutor({
      activationTimeoutMs: 100,
      maxActivationRetries: 1,
    });
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);
    const rejected = expect(stepPromise).rejects.toThrow(/without an agent_start acknowledgement/);

    expect(sent.map((delivery) => delivery.kind)).toEqual(["step"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.map((delivery) => delivery.kind)).toEqual(["step", "resume"]);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(executor.pendingStepId).toBeNull();
  });

  it("cancels activation wake for a late agent_start without duplicating the turn", async () => {
    vi.useFakeTimers();
    const { executor, sent } = makeExecutor({ activationTimeoutMs: 100 });
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);

    await vi.advanceTimersByTimeAsync(99);
    executor.setStreaming(true);
    await vi.advanceTimersByTimeAsync(101);
    expect(sent).toHaveLength(1);

    await executor.submit("step1", "a1", {});
    await stepPromise;
  });

  it("stays quiet while held and re-arms activation only after resume delivery", async () => {
    vi.useFakeTimers();
    const { executor, sent } = makeExecutor({ activationTimeoutMs: 100 });
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);

    executor.hold();
    await vi.advanceTimersByTimeAsync(500);
    expect(sent.map((delivery) => delivery.kind)).toEqual(["step"]);

    executor.release();
    expect(sent.map((delivery) => delivery.kind)).toEqual(["step", "resume"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.map((delivery) => delivery.kind)).toEqual(["step", "resume", "resume"]);
    executor.setStreaming(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(3);

    await executor.submit("step1", "a1", {});

    await stepPromise;
  });
  it("does not reprompt an active turn on ordinary pause and resume", async () => {
    const { executor, sent } = makeExecutor();
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);
    executor.setStreaming(true);

    executor.hold("pause");
    executor.release();
    expect(sent.map((delivery) => delivery.kind)).toEqual(["step"]);

    executor.hold("pause");
    executor.setStreaming(false);
    expect(executor.handleAgentSettled()).toBe(false);
    executor.release();
    expect(sent.map((delivery) => delivery.kind)).toEqual(["step", "resume"]);

    await executor.submit("step1", "a1", {});
    await stepPromise;
  });
  it("clears activation wake after an accepted submission", async () => {
    vi.useFakeTimers();
    const { executor, sent } = makeExecutor({ activationTimeoutMs: 100 });
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);

    await executor.submit("step1", "a1", {});
    await stepPromise;
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toHaveLength(1);
  });

  it("clears activation wake when the attempt aborts", async () => {
    vi.useFakeTimers();
    const { executor, sent } = makeExecutor({ activationTimeoutMs: 100 });
    const abort = new AbortController();
    const stepPromise = executor.runAgentStep(makeRequest(), abort.signal);
    const rejected = expect(stepPromise).rejects.toThrow(/cancelled/);

    abort.abort(new Error("cancelled"));
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(sent).toHaveLength(1);
  });

  it("fails actionably after the bounded provider retry is exhausted", async () => {
    const { executor, sent } = makeExecutor({ maxProviderRetries: 1 });
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);
    const rejected = expect(stepPromise).rejects.toThrow(/persisted after 1 retry/);
    executor.setStreaming(true);
    executor.setStreaming(false);
    executor.handleAgentSettled({
      kind: "provider_retryable",
      diagnostic: "HTTP 503 service unavailable",
    });

    executor.setStreaming(true);
    executor.setStreaming(false);
    expect(
      executor.handleAgentSettled({
        kind: "provider_retryable",
        diagnostic: "HTTP 503 service unavailable",
      }),
    ).toBe(false);

    await rejected;
    expect(sent.map((delivery) => delivery.kind)).toEqual(["step", "resume"]);
  });

  it("retries provider failure without consuming a semantic nudge", async () => {
    const { executor, sent } = makeExecutor({ maxNudges: 1, maxProviderRetries: 1 });
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);
    executor.setStreaming(true);
    executor.setStreaming(false);

    expect(
      executor.handleAgentSettled({
        kind: "provider_retryable",
        diagnostic: "HTTP 429 rate limited",
      }),
    ).toBe(true);
    expect(sent.map((delivery) => delivery.kind)).toEqual(["step", "resume"]);

    executor.setStreaming(true);
    executor.setStreaming(false);
    expect(executor.handleAgentSettled()).toBe(true);
    expect(sent.map((delivery) => delivery.kind)).toEqual(["step", "resume", "reminder"]);

    await executor.submit("step1", "a1", {});
    await stepPromise;
  });

  it("fails a terminal provider error without sending a no-submit reminder", async () => {
    const { executor, sent } = makeExecutor({ maxNudges: 1 });
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);
    const rejected = expect(stepPromise).rejects.toThrow(/model .*not found/i);
    executor.setStreaming(true);
    executor.setStreaming(false);

    expect(
      executor.handleAgentSettled({
        kind: "provider_terminal",
        diagnostic: "HTTP 404 model alpha not found",
      }),
    ).toBe(false);
    await rejected;
    expect(sent).toHaveLength(1);
  });

  it.each([
    [
      {
        role: "assistant",
        stopReason: "error",
        diagnostics: [{ details: { status: 404 } }],
        errorMessage: "missing",
      },
      "provider_terminal",
    ],
    [
      {
        role: "assistant",
        stopReason: "error",
        diagnostics: [{ details: { statusCode: 401 } }],
        errorMessage: "unauthorized",
      },
      "provider_terminal",
    ],
    [
      {
        role: "assistant",
        stopReason: "error",
        diagnostics: [{ error: { code: "forbidden", message: "denied" } }],
      },
      "provider_terminal",
    ],
    [
      {
        role: "assistant",
        stopReason: "error",
        diagnostics: [{ details: { statusCode: 429 } }],
        errorMessage: "busy",
      },
      "provider_retryable",
    ],
    [
      {
        role: "assistant",
        stopReason: "error",
        diagnostics: [{ details: { httpStatus: 503 } }],
        errorMessage: "down",
      },
      "provider_retryable",
    ],
    [
      {
        role: "assistant",
        stopReason: "error",
        diagnostics: [{ error: { code: "ECONNRESET", message: "socket" } }],
      },
      "provider_retryable",
    ],
    [
      { role: "assistant", stopReason: "error", errorMessage: "maximum context length exceeded" },
      "context_overflow",
    ],
    [{ role: "assistant", stopReason: "aborted" }, "user_abort"],
    [{ role: "assistant", stopReason: "stop" }, "semantic_settle"],
  ] as const)("classifies assistant lifecycle outcome %#", (message, kind) => {
    expect(classifyAssistantTurn([message])).toMatchObject({ kind });
  });
  it.each([
    'request failed with {"api_key":"sk-live-secret"}',
    String.raw`request failed with {\"api_key\":\"sk-live-secret\"}`,
    "request failed\nAuthorization: Bearer live-secret\nx-api-key: another-secret",
  ])("redacts quoted and header credentials from provider diagnostics", (errorMessage) => {
    const outcome = classifyAssistantTurn([
      {
        role: "assistant",
        stopReason: "error",
        diagnostics: [{ details: { statusCode: 503 } }],
        errorMessage,
      },
    ]);
    expect(outcome).toMatchObject({ kind: "provider_retryable" });
    if (outcome.kind !== "provider_retryable") throw new Error("expected retryable outcome");
    expect(outcome.diagnostic).toContain("[redacted]");
    expect(outcome.diagnostic).not.toContain("sk-live-secret");
    expect(outcome.diagnostic).not.toContain("live-secret");
    expect(outcome.diagnostic).not.toContain("another-secret");
  });

  it("does nothing on settle without a pending step", () => {
    const { executor, sent } = makeExecutor();
    expect(executor.handleAgentSettled()).toBe(false);
    expect(sent).toEqual([]);
  });
});
