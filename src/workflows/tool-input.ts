import { Type, type Static, type TSchema } from "typebox";
import { parseToolInput } from "./tool-input-parse.js";

const noExtraProperties = { additionalProperties: false } as const;

const offsetSchema = Type.Integer({ minimum: 0, description: "Workflow list offset" });
const workflowSchema = Type.String({
  description: "Discovered workflow name or workflow file path; required when action is start",
});
const inputSchema = Type.Unknown({
  description: "Checkpoint answer for answer; optional structured workflow input for start",
});
const runIdSchema = Type.String({
  description: "Run id; optional for status, cancel, and answer",
});
const stepSchema = Type.String({
  description: "Workflow step id; required when action is update or submit",
});
const attemptSchema = Type.String({
  description: "Workflow attempt id; required when action is update or submit",
});
const updateSchema = Type.Object(
  {
    type: Type.String(),
    key: Type.String(),
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  noExtraProperties,
);
const outputSchema = Type.Unknown({
  description: "Step output matching the expected shape; required when action is submit",
});

export const WorkflowActionSchemas = {
  list: Type.Object(
    { action: Type.Literal("list"), offset: Type.Optional(offsetSchema) },
    noExtraProperties,
  ),
  start: Type.Object(
    {
      action: Type.Literal("start"),
      workflow: workflowSchema,
      input: Type.Optional(inputSchema),
    },
    noExtraProperties,
  ),
  status: Type.Object(
    { action: Type.Literal("status"), runId: Type.Optional(runIdSchema) },
    noExtraProperties,
  ),
  pause: Type.Object({ action: Type.Literal("pause") }, noExtraProperties),
  resume: Type.Object({ action: Type.Literal("resume") }, noExtraProperties),
  cancel: Type.Object(
    { action: Type.Literal("cancel"), runId: Type.Optional(runIdSchema) },
    noExtraProperties,
  ),
  answer: Type.Object(
    {
      action: Type.Literal("answer"),
      input: inputSchema,
      runId: Type.Optional(runIdSchema),
    },
    noExtraProperties,
  ),
  update: Type.Object(
    {
      action: Type.Literal("update"),
      step: stepSchema,
      attempt: attemptSchema,
      update: updateSchema,
    },
    noExtraProperties,
  ),
  submit: Type.Object(
    {
      action: Type.Literal("submit"),
      step: stepSchema,
      attempt: attemptSchema,
      output: outputSchema,
    },
    noExtraProperties,
  ),
} as const;

const WorkflowSubmissionActionSchemas = {
  update: WorkflowActionSchemas.update,
  submit: WorkflowActionSchemas.submit,
} as const;

type SchemaValue<Schemas extends Record<string, TSchema>> = Schemas[keyof Schemas];

export type WorkflowToolInput = Static<SchemaValue<typeof WorkflowActionSchemas>>;
export type WorkflowSubmissionInput = Static<SchemaValue<typeof WorkflowSubmissionActionSchemas>>;

const workflowToolFields = {
  offset: Type.Optional(offsetSchema),
  workflow: Type.Optional(workflowSchema),
  input: Type.Optional(inputSchema),
  runId: Type.Optional(runIdSchema),
  step: Type.Optional(stepSchema),
  attempt: Type.Optional(attemptSchema),
  update: Type.Optional(updateSchema),
  output: Type.Optional(outputSchema),
};

export const WorkflowToolParameters = Type.Object(
  {
    action: Type.String({ enum: Object.keys(WorkflowActionSchemas) }),
    ...workflowToolFields,
  },
  noExtraProperties,
);
export const WorkflowSubmissionToolParameters = Type.Object(
  {
    action: Type.String({ enum: Object.keys(WorkflowSubmissionActionSchemas) }),
    step: Type.Optional(stepSchema),
    attempt: Type.Optional(attemptSchema),
    update: Type.Optional(updateSchema),
    output: Type.Optional(outputSchema),
  },
  noExtraProperties,
);

type ToolInputParser<Output> = (value: unknown) => Output;

const workflowInputParsers = {
  list: (value) => parseToolInput(WorkflowActionSchemas.list, value, "workflow"),
  start: (value) => parseToolInput(WorkflowActionSchemas.start, value, "workflow"),
  status: (value) => parseToolInput(WorkflowActionSchemas.status, value, "workflow"),
  pause: (value) => parseToolInput(WorkflowActionSchemas.pause, value, "workflow"),
  resume: (value) => parseToolInput(WorkflowActionSchemas.resume, value, "workflow"),
  cancel: (value) => parseToolInput(WorkflowActionSchemas.cancel, value, "workflow"),
  answer: (value) => parseToolInput(WorkflowActionSchemas.answer, value, "workflow"),
  update: (value) => parseToolInput(WorkflowActionSchemas.update, value, "workflow"),
  submit: (value) => parseToolInput(WorkflowActionSchemas.submit, value, "workflow"),
} satisfies Record<keyof typeof WorkflowActionSchemas, ToolInputParser<WorkflowToolInput>>;

const workflowSubmissionInputParsers = {
  update: (value) =>
    parseToolInput(WorkflowSubmissionActionSchemas.update, value, "workflow submission"),
  submit: (value) =>
    parseToolInput(WorkflowSubmissionActionSchemas.submit, value, "workflow submission"),
} satisfies Record<
  keyof typeof WorkflowSubmissionActionSchemas,
  ToolInputParser<WorkflowSubmissionInput>
>;

export function parseWorkflowToolInput(value: unknown): WorkflowToolInput {
  return parseSelectedAction<WorkflowToolInput>(
    workflowInputParsers,
    withoutHostInvocationIntent(value),
    "workflow",
  );
}

export function parseWorkflowSubmissionInput(value: unknown): WorkflowSubmissionInput {
  return parseSelectedAction<WorkflowSubmissionInput>(
    workflowSubmissionInputParsers,
    value,
    "workflow submission",
  );
}

function parseSelectedAction<Output>(
  parsers: Readonly<Record<string, ToolInputParser<Output>>>,
  value: unknown,
  label: string,
): Output {
  if (!isRecord(value) || typeof value.action !== "string") throw unknownAction(label);
  const parser = parsers[value.action];
  if (parser === undefined) throw unknownAction(label);
  return parser(value);
}

export function withoutHostInvocationIntent(value: unknown): unknown {
  if (!isRecord(value) || !("i" in value)) return value;
  const { i: _intent, ...input } = value;
  return input;
}

function unknownAction(label: string): Error {
  return new Error(`Invalid ${label} tool input: action is missing or unknown.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
