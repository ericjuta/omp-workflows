import { redactSensitiveText } from "../workflows/text.js";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
  AgentToolPolicy,
  ConversationRange,
} from "../workflows/types.js";

export type SubmissionResult =
  | { accepted: true; message: string }
  | { accepted: false; message: string };

export type PromptDeliveryKind = "step" | "reminder" | "resume";

export type PromptDelivery = {
  prompt: string;
  contract: AgentStepRequest["contract"];
  presentation?: AgentStepRequest["presentation"];
  kind: PromptDeliveryKind;
  /** True when the agent is known to be mid-run, so delivery must be queued. */
  streaming: boolean;
  /** Report that the coordinator actually sent this generation. */
  onSent: (agentAlreadyActive: boolean) => void;
};

export type AssistantTurnOutcome =
  | { kind: "semantic_settle" }
  | { kind: "user_abort" }
  | {
      kind: "provider_retryable" | "provider_terminal" | "context_overflow";
      diagnostic: string;
    };

/**
 * Bracketing hooks for conversation linkage: a mark is taken when the step
 * prompt is first delivered, and the recorded entry range since that mark is
 * attached to the accepted submission.
 */
export type ConversationHooks = {
  beginAttempt?: (contract: AgentStepRequest["contract"]) => void;
  mark: () => number;
  rangeSince: (mark: number) => ConversationRange | undefined;
};

export type ConversationStepExecutorOptions = {
  /** Deliver a prompt into the pi conversation. */
  sendPrompt: (delivery: PromptDelivery) => void;
  /** Reminders sent when the agent settles without submitting. Default 2. */
  maxNudges?: number;
  /** Prompt activation re-deliveries before failing. Default 1. */
  maxActivationRetries?: number;
  /** Time to wait for agent_start after an actual delivery. Default 10 seconds. */
  activationTimeoutMs?: number;
  /** Provider/transport re-deliveries before failing. Default 1. */
  maxProviderRetries?: number;
  /** Conversation linkage hooks, wired to the session recorder. */
  conversation?: ConversationHooks;
  /** Called when the engine aborts a pending agent step. */
  onAbort?: (contract: AgentStepRequest["contract"], reason: unknown) => void;
};

type PendingStep = {
  request: AgentStepRequest;
  resolve: (submission: AgentStepSubmission) => void;
  reject: (error: unknown) => void;
  nudgesSent: number;
  providerRetriesSent: number;
  activationRetriesSent: number;
  deliveryGeneration: number;
  deliveredAt: number | null;
  activationTimer: NodeJS.Timeout | null;
  seenAgentStart: boolean;
  /** Conversation mark taken when the prompt was first delivered. */
  mark: number | null;
  cleanup: () => void;
  /** Resolves when this step stops being the pending step. */
  cleared: Promise<void>;
  markCleared: () => void;
};

const DEFAULT_MAX_NUDGES = 2;
const DEFAULT_MAX_ACTIVATION_RETRIES = 1;
const DEFAULT_ACTIVATION_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PROVIDER_RETRIES = 1;
const MAX_ASSISTANT_DIAGNOSTIC_CHARS = 500;
const SUBMISSION_INSTRUCTION_LEAD =
  "Submit this step with the `workflow` tool using this exact envelope:";

/** Exact model-visible contract for completing the current workflow attempt. */
export function submissionInstruction(contract: AgentStepRequest["contract"]): string {
  return [
    SUBMISSION_INSTRUCTION_LEAD,
    `{"action": "submit", "step": ${JSON.stringify(contract.nodeId)}, "attempt": ${JSON.stringify(contract.attemptId)}, "output": <your result>}`,
    `Expected output: ${contract.expectedOutput ?? "a JSON object with your result"}`,
    "The step is complete only after the workflow tool accepts the output.",
    "If the tool reports a validation error, correct the output and call it again.",
  ].join("\n");
}

/**
 * AgentStepExecutor that runs steps inside the current pi conversation. The
 * engine hands it a prompt; it delivers the prompt as a model-facing workflow
 * message and resolves once the model submits an accepted output through the `workflow`
 * tool. If the agent settles without submitting, it nudges the model a
 * bounded number of times before failing the step.
 */
export class ConversationStepExecutor implements AgentStepExecutor {
  private readonly sendPrompt: (delivery: PromptDelivery) => void;
  private readonly maxNudges: number;
  private readonly maxActivationRetries: number;
  private readonly activationTimeoutMs: number;
  private readonly maxProviderRetries: number;
  private readonly conversation: ConversationHooks | undefined;
  private readonly onAbort: ConversationStepExecutorOptions["onAbort"];
  private pending: PendingStep | null = null;
  private streaming = false;
  private heldByUser = false;
  private resumeRequiresPrompt = false;

  constructor(options: ConversationStepExecutorOptions) {
    this.sendPrompt = options.sendPrompt;
    this.maxNudges = options.maxNudges ?? DEFAULT_MAX_NUDGES;
    this.maxActivationRetries = options.maxActivationRetries ?? DEFAULT_MAX_ACTIVATION_RETRIES;
    this.activationTimeoutMs = options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
    this.maxProviderRetries = options.maxProviderRetries ?? DEFAULT_MAX_PROVIDER_RETRIES;
    this.conversation = options.conversation;
    this.onAbort = options.onAbort;
  }

  /** Track agent streaming state (wire to agent_start / agent_settled). */
  setStreaming(streaming: boolean): void {
    this.streaming = streaming;
    const pending = this.pending;
    if (streaming && pending !== null && pending.deliveredAt !== null) {
      pending.seenAgentStart = true;
      this.clearActivationTimer(pending);
    }
  }

  get pendingStepId(): string | null {
    return this.pending?.request.contract.nodeId ?? null;
  }

  get pendingToolPolicy(): AgentToolPolicy | undefined {
    return this.pending?.request.contract.toolPolicy;
  }

  get canRetryProviderFailure(): boolean {
    return (
      this.pending !== null &&
      this.pending.seenAgentStart &&
      !this.heldByUser &&
      this.pending.providerRetriesSent < this.maxProviderRetries
    );
  }
  /** Hold the pending step without stealing the conversation while paused. */
  hold(kind: "interrupted" | "pause" = "interrupted"): void {
    this.heldByUser = true;
    if (kind === "interrupted") this.resumeRequiresPrompt = true;
    if (this.pending) this.clearActivationTimer(this.pending);
  }

  get held(): boolean {
    return this.heldByUser;
  }

  /** Release a hold, re-delivering only when the previous turn was interrupted or settled. */
  release(): void {
    if (!this.heldByUser) return;
    this.heldByUser = false;
    const pending = this.pending;
    const redeliver = this.resumeRequiresPrompt;
    this.resumeRequiresPrompt = false;
    if (pending === null) return;
    if (!redeliver) {
      if (!pending.seenAgentStart && pending.deliveredAt !== null) {
        this.scheduleActivationWake(pending, pending.deliveryGeneration);
      }
      return;
    }
    try {
      this.conversation?.beginAttempt?.(pending.request.contract);
      this.deliverPrompt(pending, pending.request.prompt, "resume");
    } catch (error) {
      this.clearPending();
      pending.reject(error);
    }
  }

  async runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission> {
    if (this.pending) {
      throw new Error("Another workflow step is already awaiting output");
    }
    return await new Promise<AgentStepSubmission>((resolve, reject) => {
      const onAbort = () => {
        const reason: unknown = signal.reason ?? new Error("Workflow step aborted");
        if (this.pending?.request !== request) {
          return;
        }
        this.clearPending();
        try {
          this.onAbort?.(request.contract, reason);
        } finally {
          reject(reason);
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      let markCleared!: () => void;
      const cleared = new Promise<void>((resolveCleared) => {
        markCleared = resolveCleared;
      });
      this.conversation?.beginAttempt?.(request.contract);
      const pending: PendingStep = {
        request,
        resolve,
        reject,
        nudgesSent: 0,
        providerRetriesSent: 0,
        activationRetriesSent: 0,
        deliveryGeneration: 0,
        deliveredAt: null,
        activationTimer: null,
        seenAgentStart: false,
        mark: this.conversation?.mark() ?? null,
        cleanup: () => signal.removeEventListener("abort", onAbort),
        cleared,
        markCleared,
      };
      this.pending = pending;
      if (signal.aborted) {
        onAbort();
        return;
      }
      try {
        this.deliverPrompt(pending, request.prompt, "step");
      } catch (error) {
        // A failed delivery must not leave the step installed, or every
        // subsequent agent node would fail with "already awaiting output".
        this.clearPending();
        reject(error);
      }
    });
  }

  /** Called by the `workflow` tool when the model submits a step output. */
  async submit(stepId: string, attemptId: string, output: unknown): Promise<SubmissionResult> {
    const pending = this.pending;
    if (!pending) {
      return {
        accepted: false,
        message:
          "No workflow step is awaiting output. Do not call the workflow tool outside an active workflow step.",
      };
    }
    const expected = pending.request.contract.nodeId;
    if (stepId !== expected) {
      return {
        accepted: false,
        message: `Wrong step id ${JSON.stringify(stepId)}; the pending step is ${JSON.stringify(expected)}.`,
      };
    }
    // Loops revisit the same node id, so a delayed duplicate submission from
    // an earlier attempt would otherwise be accepted as this attempt's output.
    const expectedAttempt = pending.request.contract.attemptId;
    if (attemptId !== expectedAttempt) {
      return {
        accepted: false,
        message: `Stale attempt id ${JSON.stringify(attemptId)} for step ${JSON.stringify(
          stepId,
        )}; the pending attempt is ${JSON.stringify(expectedAttempt)}. Use the attempt id from the latest step contract.`,
      };
    }
    // Race validation against the step being cleared: a hung `validate`
    // callback must not leave this tool call (and therefore pi) blocked after
    // a timeout or cancel already resolved the run.
    const result = await Promise.race([
      pending.request.accept(output),
      pending.cleared.then(() => null),
    ]);
    // The step may have timed out or been cancelled (and a newer step
    // installed) while validation was awaited; a stale submission must not
    // clear or resolve the newer pending step.
    if (result === null || this.pending !== pending) {
      return {
        accepted: false,
        message: `Step ${JSON.stringify(stepId)} is no longer awaiting output.`,
      };
    }
    if (!result.ok) {
      return {
        accepted: false,
        message: `Output rejected for step ${JSON.stringify(stepId)}: ${result.error}`,
      };
    }
    this.clearPending();
    const conversation =
      pending.mark !== null ? this.conversation?.rangeSince(pending.mark) : undefined;
    pending.resolve({
      output: result.value,
      ...(conversation !== undefined ? { conversation } : {}),
    });
    return {
      accepted: true,
      message: [
        `Output accepted for step ${JSON.stringify(stepId)}.`,
        "If the workflow continues, the next step arrives as a new workflow message. End your turn now.",
      ].join(" "),
    };
  }

  /**
   * Handle the settled assistant turn. Provider failures retry or fail without
   * spending the semantic no-submit nudge budget.
   */
  handleAgentSettled(outcome: AssistantTurnOutcome = { kind: "semantic_settle" }): boolean {
    const pending = this.pending;
    if (pending === null || !pending.seenAgentStart) return false;
    if (this.heldByUser) {
      if (outcome.kind !== "user_abort") this.resumeRequiresPrompt = true;
      return false;
    }
    if (outcome.kind === "user_abort") return false;

    if (outcome.kind === "provider_terminal") {
      this.failPending(
        pending,
        `Provider rejected workflow step ${JSON.stringify(pending.request.contract.nodeId)}: ${outcome.diagnostic}. Check the model/provider configuration and credentials before retrying.`,
      );
      return false;
    }

    if (outcome.kind === "provider_retryable" || outcome.kind === "context_overflow") {
      if (pending.providerRetriesSent >= this.maxProviderRetries) {
        this.failPending(
          pending,
          `${outcome.kind === "context_overflow" ? "Context overflow" : "Provider/transport failure"} persisted after ${pending.providerRetriesSent} retry for workflow step ${JSON.stringify(pending.request.contract.nodeId)}: ${outcome.diagnostic}. Check provider availability or reduce the conversation context before retrying.`,
        );
        return false;
      }
      pending.providerRetriesSent += 1;
      const reason =
        outcome.kind === "context_overflow"
          ? "The conversation was compacted after a context overflow."
          : "The previous turn ended in a transient provider or transport failure.";
      try {
        this.conversation?.beginAttempt?.(pending.request.contract);
        this.deliverPrompt(
          pending,
          `${reason}\nFailure: ${outcome.diagnostic}\n\n${pending.request.prompt}`,
          "resume",
        );
      } catch (error) {
        this.clearPending();
        pending.reject(error);
        return false;
      }
      return true;
    }

    if (pending.nudgesSent >= this.maxNudges) {
      this.failPending(
        pending,
        `Agent settled ${pending.nudgesSent + 1} times without submitting step ${JSON.stringify(pending.request.contract.nodeId)} via the workflow tool`,
      );
      return false;
    }
    pending.nudgesSent += 1;
    try {
      this.conversation?.beginAttempt?.(pending.request.contract);
      this.deliverPrompt(
        pending,
        `Reminder: workflow step ${JSON.stringify(pending.request.contract.nodeId)} is still awaiting your output.`,
        "reminder",
      );
    } catch (error) {
      // No reminder turn was started, so nothing would settle the step; fail
      // it promptly instead of waiting out the node timeout.
      this.clearPending();
      pending.reject(error);
      return false;
    }
    return true;
  }

  private deliverPrompt(pending: PendingStep, prompt: string, kind: PromptDeliveryKind): void {
    if (this.pending !== pending) return;
    this.clearActivationTimer(pending);
    pending.deliveryGeneration += 1;
    pending.deliveredAt = null;
    pending.seenAgentStart = false;
    const generation = pending.deliveryGeneration;
    const instruction = submissionInstruction(pending.request.contract);
    this.sendPrompt({
      prompt: prompt.includes(instruction) ? prompt : `${prompt.trimEnd()}\n\n${instruction}`,
      contract: pending.request.contract,
      ...(pending.request.presentation !== undefined
        ? { presentation: pending.request.presentation }
        : {}),
      kind,
      streaming: this.streaming,
      onSent: (agentAlreadyActive) =>
        this.handlePromptSent(pending, generation, agentAlreadyActive),
    });
  }

  private handlePromptSent(
    pending: PendingStep,
    generation: number,
    agentAlreadyActive: boolean,
  ): void {
    if (
      this.pending !== pending ||
      pending.deliveryGeneration !== generation ||
      pending.deliveredAt !== null
    ) {
      return;
    }
    pending.deliveredAt = Date.now();
    if (this.heldByUser) return;
    if (agentAlreadyActive || this.streaming) {
      pending.seenAgentStart = true;
      return;
    }
    this.scheduleActivationWake(pending, generation);
  }

  private scheduleActivationWake(pending: PendingStep, generation: number): void {
    this.clearActivationTimer(pending);
    pending.activationTimer = setTimeout(() => {
      pending.activationTimer = null;
      this.handleActivationTimeout(pending, generation);
    }, this.activationTimeoutMs);
  }

  private handleActivationTimeout(pending: PendingStep, generation: number): void {
    if (
      this.pending !== pending ||
      this.heldByUser ||
      pending.deliveryGeneration !== generation ||
      pending.seenAgentStart ||
      pending.deliveredAt === null
    ) {
      return;
    }
    if (pending.activationRetriesSent >= this.maxActivationRetries) {
      this.failPending(
        pending,
        `Workflow step ${JSON.stringify(pending.request.contract.nodeId)} attempt ${JSON.stringify(pending.request.contract.attemptId)} was delivered ${pending.activationRetriesSent + 1} times without an agent_start acknowledgement. Check the active model/provider and retry the workflow.`,
      );
      return;
    }
    pending.activationRetriesSent += 1;
    try {
      this.conversation?.beginAttempt?.(pending.request.contract);
      this.deliverPrompt(pending, pending.request.prompt, "resume");
    } catch (error) {
      this.clearPending();
      pending.reject(error);
    }
  }

  private clearActivationTimer(pending: PendingStep): void {
    if (pending.activationTimer === null) return;
    clearTimeout(pending.activationTimer);
    pending.activationTimer = null;
  }

  private failPending(pending: PendingStep, message: string): void {
    if (this.pending !== pending) return;
    this.clearPending();
    pending.reject(new Error(message));
  }

  private clearPending(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.clearActivationTimer(pending);
    pending.cleanup();
    pending.markCleared();
    this.pending = null;
  }
}

type AssistantMessageLike = Record<string, unknown> & { role: "assistant" };

/** Normalize the terminal assistant message into extension behavior. */
export function classifyAssistantTurn(messages: readonly unknown[]): AssistantTurnOutcome {
  let assistant: AssistantMessageLike | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = messages[index];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const message = value as Record<string, unknown>;
      if (message.stopReason === "aborted") return { kind: "user_abort" };
    }
    const candidate = parseAssistantMessage(value);
    if (assistant === null && candidate !== null) assistant = candidate;
  }
  if (assistant === null) return { kind: "semantic_settle" };
  if (assistant.stopReason === "aborted") return { kind: "user_abort" };
  if (assistant.stopReason !== "error") return { kind: "semantic_settle" };

  const records = assistantSignalRecords(assistant);
  const codes = records
    .flatMap((record) => [record.code, record.errorCode, record.type])
    .filter(
      (value): value is string | number => typeof value === "string" || typeof value === "number",
    )
    .map((value) => String(value).toLowerCase());
  const statuses = records
    .flatMap((record) => [record.status, record.statusCode, record.httpStatus])
    .map(statusNumber)
    .filter((status): status is number => status !== null);
  const diagnostic = assistantDiagnostic(assistant, records);
  if (codes.some((code) => /context.*(length|window)|token.*limit|prompt.*too.*long/u.test(code))) {
    return { kind: "context_overflow", diagnostic };
  }
  if (statuses.some((status) => status === 401 || status === 403 || status === 404)) {
    return { kind: "provider_terminal", diagnostic };
  }
  if (
    statuses.some(
      (status) => status === 408 || status === 425 || status === 429 || status >= 500,
    ) ||
    codes.some((code) => /^5\d\d$/u.test(code))
  ) {
    return { kind: "provider_retryable", diagnostic };
  }
  if (
    codes.some((code) =>
      /^(?:401|403|404|auth(?:entication|orization)?_?error|forbidden|invalid_?api_?key|model_?not_?found|not_?found|unauthorized)$/u.test(
        code,
      ),
    )
  ) {
    return { kind: "provider_terminal", diagnostic };
  }
  if (
    codes.some((code) =>
      /^(?:408|425|429|econnaborted|econnrefused|econnreset|enotfound|epipe|etimedout|internal_?server_?error|network_?error|overloaded_?error|rate_?limit(?:ed|_?exceeded)?|server_?error|service_?unavailable|temporarily_?unavailable|timeout)$/u.test(
        code,
      ),
    )
  ) {
    return { kind: "provider_retryable", diagnostic };
  }

  const normalized = diagnostic.toLowerCase();
  if (
    /context (?:length|window)|context_length_exceeded|maximum context|prompt (?:is )?too long|too many tokens/u.test(
      normalized,
    )
  ) {
    return { kind: "context_overflow", diagnostic };
  }
  if (statuses.some((status) => status >= 400 && status < 500)) {
    return { kind: "provider_terminal", diagnostic };
  }
  if (
    /\b(?:401|403|404)\b|api key|authentication|forbidden|model .*not found|not_found|unauthorized/u.test(
      normalized,
    )
  ) {
    return { kind: "provider_terminal", diagnostic };
  }
  if (
    /\b429\b|rate limit|quota|\b5\d\d\b|econnreset|econnrefused|enotfound|etimedout|fetch failed|network error|service unavailable|socket hang up|timed out/u.test(
      normalized,
    )
  ) {
    return { kind: "provider_retryable", diagnostic };
  }
  return { kind: "provider_terminal", diagnostic };
}

function assistantSignalRecords(assistant: AssistantMessageLike): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [assistant];
  const diagnostics = Array.isArray(assistant.diagnostics) ? assistant.diagnostics : [];
  for (const value of diagnostics) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const diagnostic = value as Record<string, unknown>;
    records.push(diagnostic);
    if (
      diagnostic.error !== null &&
      typeof diagnostic.error === "object" &&
      !Array.isArray(diagnostic.error)
    ) {
      records.push(diagnostic.error as Record<string, unknown>);
    }
    if (
      diagnostic.details !== null &&
      typeof diagnostic.details === "object" &&
      !Array.isArray(diagnostic.details)
    ) {
      const details = diagnostic.details as Record<string, unknown>;
      records.push(details);
      if (
        details.error !== null &&
        typeof details.error === "object" &&
        !Array.isArray(details.error)
      ) {
        records.push(details.error as Record<string, unknown>);
      }
    }
  }
  return records;
}

function statusNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d{3}$/u.test(value)) return Number(value);
  return null;
}

function assistantDiagnostic(
  assistant: AssistantMessageLike,
  records: readonly Record<string, unknown>[],
): string {
  const candidate = [assistant.errorMessage, ...records.map((record) => record.message)].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const raw = candidate ?? "Provider stopped the assistant turn without a diagnostic";
  const safe = redactSensitiveText(raw).replace(/\s+/gu, " ").trim();
  return safe.length <= MAX_ASSISTANT_DIAGNOSTIC_CHARS
    ? safe
    : `${safe.slice(0, MAX_ASSISTANT_DIAGNOSTIC_CHARS)}…`;
}
function parseAssistantMessage(value: unknown): AssistantMessageLike | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  return message.role === "assistant" ? (message as AssistantMessageLike) : null;
}
