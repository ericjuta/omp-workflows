export const WORKFLOW_START_CHANNEL = "pi-workflows:start";
export const WORKFLOW_START_RESULT_CHANNEL = "pi-workflows:start-result";

export type WorkflowStartRequest = {
  requestId: string;
  ref: string;
  input: unknown;
};

export type WorkflowStartResult =
  | {
      requestId: string;
      ok: true;
      workflowName: string;
    }
  | {
      requestId: string;
      ok: false;
      error: string;
    };

const MAX_REQUEST_ID_CHARS = 200;
const MAX_WORKFLOW_REF_CHARS = 4_096;

export function parseWorkflowStartRequest(value: unknown): WorkflowStartRequest | undefined {
  if (!isRecord(value)) return undefined;
  const requestId = boundedNonEmptyString(value["requestId"], MAX_REQUEST_ID_CHARS);
  const ref = boundedNonEmptyString(value["ref"], MAX_WORKFLOW_REF_CHARS);
  if (!requestId || !ref || !("input" in value)) return undefined;
  return { requestId, ref, input: value["input"] };
}

function boundedNonEmptyString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
