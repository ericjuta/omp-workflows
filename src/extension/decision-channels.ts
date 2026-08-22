import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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

const PI_PRESENTATION_WINDOW_LINES = 18;

export type PiDecisionUi = Pick<ExtensionContext["ui"], "custom" | "input">;

export class PiDecisionChannel extends HostDecisionChannel implements HumanDecisionChannel {
  constructor(
    private readonly options: {
      actorId: string;
      ui: PiDecisionUi;
      store: HumanDecisionStore;
      onAnswer: (answer: HumanDecisionChannelAnswer) => Promise<void>;
    },
  ) {
    super(
      "pi",
      new InteractiveDecisionSession({
        channelId: "pi",
        actorId: options.actorId,
        store: options.store,
        onAnswer: options.onAnswer,
      }),
    );
  }

  async deliver(request: HumanDecisionChannelRequest): Promise<HumanDecisionDeliveryResult> {
    return this.session.run(request, async ({ attemptId, createdAt, controller }) => {
      const entries = Object.entries(request.choices);
      const selectedChoice = await this.options.ui.custom<string | undefined>(
        (tui, theme, _keybindings, done) => {
          let choiceIndex = 0;
          let scroll = 0;
          let settled = false;
          const finish = (value: string | undefined) => {
            if (settled) return;
            settled = true;
            done(value);
          };
          const abort = () => finish(undefined);
          controller.signal.addEventListener("abort", abort, { once: true });
          return {
            render(width: number): string[] {
              const content = renderPiPresentationLines(request, Math.max(20, width), theme);
              const maxScroll = Math.max(0, content.length - PI_PRESENTATION_WINDOW_LINES);
              scroll = Math.min(scroll, maxScroll);
              const visible = content.slice(scroll, scroll + PI_PRESENTATION_WINDOW_LINES);
              const lines = [...visible];
              if (content.length > PI_PRESENTATION_WINDOW_LINES) {
                lines.push(
                  theme.fg(
                    "dim",
                    `Decision text ${scroll + 1}-${Math.min(content.length, scroll + PI_PRESENTATION_WINDOW_LINES)}/${content.length} · PgUp/PgDn scroll`,
                  ),
                );
              }
              lines.push("");
              for (const [index, [, definition]] of entries.entries()) {
                const marker = index === choiceIndex ? "›" : " ";
                lines.push(
                  ...wrapTextWithAnsi(
                    `${theme.fg(index === choiceIndex ? "accent" : "text", `${marker} ${definition.label}`)}`,
                    Math.max(1, width),
                  ),
                );
                if (definition.input !== undefined) {
                  lines.push(
                    ...wrapTextWithAnsi(
                      theme.fg("dim", `    ${definition.input.prompt}`),
                      Math.max(1, width),
                    ),
                  );
                }
              }
              lines.push("");
              lines.push(theme.fg("dim", "↑/↓ choose · Enter confirm · Esc cancel"));
              return lines;
            },
            invalidate() {},
            handleInput(data: string): void {
              if (matchesKey(data, Key.escape)) finish(undefined);
              else if (matchesKey(data, Key.enter)) finish(entries[choiceIndex]?.[0]);
              else if (matchesKey(data, Key.up)) choiceIndex = Math.max(0, choiceIndex - 1);
              else if (matchesKey(data, Key.down)) {
                choiceIndex = Math.min(entries.length - 1, choiceIndex + 1);
              } else if (matchesKey(data, Key.pageUp)) {
                scroll = Math.max(0, scroll - PI_PRESENTATION_WINDOW_LINES);
              } else if (matchesKey(data, Key.pageDown)) {
                scroll += PI_PRESENTATION_WINDOW_LINES;
              } else return;
              tui.requestRender();
            },
            dispose(): void {
              controller.signal.removeEventListener("abort", abort);
            },
          };
        },
      );
      if (selectedChoice === undefined) {
        const errorCode = controller.signal.aborted
          ? "pi_selection_settled_elsewhere"
          : "pi_selection_cancelled";
        return this.session.fail(request, attemptId, createdAt, errorCode);
      }
      const definition = request.choices[selectedChoice];
      if (definition === undefined) throw new Error("Pi decision selection is not in the request");
      if (definition.input !== undefined) {
        const text = await this.options.ui.input(definition.input.prompt, "", {
          signal: controller.signal,
        });
        if (text === undefined) {
          const errorCode = controller.signal.aborted
            ? "pi_input_settled_elsewhere"
            : "pi_input_cancelled";
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

function renderPiPresentationLines(
  request: HumanDecisionChannelRequest,
  width: number,
  theme: Theme,
): string[] {
  const lines: string[] = [];
  for (const segment of decisionDocumentSegments(request).filter(
    (candidate) => candidate.kind !== "choices",
  )) {
    const text = operatorSafeText(segment.text);
    const styled =
      segment.kind === "title"
        ? theme.fg("accent", theme.bold(text))
        : segment.kind === "section"
          ? theme.fg("text", theme.bold(text))
          : segment.kind === "preformatted"
            ? theme.fg("muted", text)
            : theme.fg("text", text);
    for (const rawLine of styled.split("\n")) {
      lines.push(...wrapTextWithAnsi(rawLine.length === 0 ? " " : rawLine, Math.max(1, width)));
    }
    lines.push("");
  }
  lines.push(theme.fg("dim", `Decision ${decisionPresentationFingerprint(request)}`));
  return lines;
}
