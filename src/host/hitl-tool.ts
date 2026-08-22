import { Type, type Static } from "typebox";
import { parseToolInput } from "../workflows/tool-input-parse.js";
import { withoutHostInvocationIntent } from "../workflows/tool-input.js";

export const HitlToolParameters = Type.Object(
  {
    runId: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$",
        description: "Waiting workflow run id; omit to use the current session's pending decision",
      }),
    ),
  },
  { additionalProperties: false },
);

export type HitlToolInput = Static<typeof HitlToolParameters>;

export function parseHitlToolInput(value: unknown): HitlToolInput {
  return parseToolInput(HitlToolParameters, withoutHostInvocationIntent(value), "hitl");
}
