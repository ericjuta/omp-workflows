import {
  type HumanDecisionChannelAnswer,
  type HumanDecisionDeliveryResult,
  type HumanDecisionChannel,
  HostDecisionChannel,
  InteractiveDecisionSession,
  operatorSafeText,
} from "../channels/index.js";
import {
  decisionDocumentSegments,
  decisionPresentationFingerprint,
} from "../workflows/decision-presentation.js";
import type { HumanDecisionStore } from "../workflows/human-decision.js";
import type { HumanDecisionChannelRequest } from "../workflows/types.js";

export type OmpDecisionUiCustomWidget = {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
  dispose(): void;
};

export type OmpDecisionUi = {
  custom: <T>(factory: (done: (value: T) => void) => OmpDecisionUiCustomWidget) => Promise<T>;
  input: (
    prompt: string,
    defaultValue: string,
    options: { signal?: AbortSignal },
  ) => Promise<string | undefined>;
  matchesEscape: (data: string) => boolean;
  matchesEnter: (data: string) => boolean;
  matchesUp: (data: string) => boolean;
  matchesDown: (data: string) => boolean;
};

export class OmpDecisionChannel extends HostDecisionChannel implements HumanDecisionChannel {
  constructor(
    private readonly uiOptions: {
      actorId: string;
      ui: OmpDecisionUi;
      store: HumanDecisionStore;
      onAnswer: (answer: HumanDecisionChannelAnswer) => Promise<void>;
    },
  ) {
    super(
      "omp",
      new InteractiveDecisionSession({
        channelId: "omp",
        actorId: uiOptions.actorId,
        store: uiOptions.store,
        onAnswer: uiOptions.onAnswer,
      }),
    );
  }

  async deliver(request: HumanDecisionChannelRequest): Promise<HumanDecisionDeliveryResult> {
    return this.session.run(request, async ({ attemptId, createdAt, controller }) => {
      const entries = Object.entries(request.choices);
      const ui = this.uiOptions.ui;
      const selectedChoice = await ui.custom<string | undefined>((done) => {
        let choiceIndex = 0;
        let settled = false;
        const finish = (value: string | undefined) => {
          if (settled) return;
          settled = true;
          done(value);
        };
        const abort = () => finish(undefined);
        controller.signal.addEventListener("abort", abort, { once: true });
        return {
          render(_width: number): string[] {
            const lines: string[] = [];
            for (const segment of decisionDocumentSegments(request).filter(
              (candidate) => candidate.kind !== "choices",
            )) {
              lines.push(operatorSafeText(segment.text), "");
            }
            lines.push(`Decision ${decisionPresentationFingerprint(request)}`, "");
            for (const [index, [, definition]] of entries.entries()) {
              const marker = index === choiceIndex ? ">" : " ";
              lines.push(`${marker} ${definition.label}`);
              if (definition.input !== undefined) {
                lines.push(`    ${definition.input.prompt}`);
              }
            }
            lines.push("", "↑/↓ choose · Enter confirm · Esc cancel");
            return lines;
          },
          invalidate() {},
          handleInput(data: string): void {
            if (ui.matchesEscape(data)) finish(undefined);
            else if (ui.matchesEnter(data)) finish(entries[choiceIndex]?.[0]);
            else if (ui.matchesUp(data)) choiceIndex = Math.max(0, choiceIndex - 1);
            else if (ui.matchesDown(data)) {
              choiceIndex = Math.min(entries.length - 1, choiceIndex + 1);
            }
          },
          dispose(): void {
            controller.signal.removeEventListener("abort", abort);
          },
        };
      });
      if (selectedChoice === undefined) {
        const errorCode = controller.signal.aborted
          ? "omp_selection_settled_elsewhere"
          : "omp_selection_cancelled";
        return this.session.fail(request, attemptId, createdAt, errorCode);
      }
      const definition = request.choices[selectedChoice];
      if (definition === undefined) throw new Error("OMP decision selection is not in the request");
      if (definition.input !== undefined) {
        const text = await ui.input(definition.input.prompt, "", {
          signal: controller.signal,
        });
        if (text === undefined) {
          const errorCode = controller.signal.aborted
            ? "omp_input_settled_elsewhere"
            : "omp_input_cancelled";
          return this.session.fail(request, attemptId, createdAt, errorCode);
        }
        return this.session.confirm(request, attemptId, createdAt, {
          choice: selectedChoice,
          input: { [definition.input.name]: text },
        });
      }
      return this.session.confirm(request, attemptId, createdAt, { choice: selectedChoice });
    });
  }
}
