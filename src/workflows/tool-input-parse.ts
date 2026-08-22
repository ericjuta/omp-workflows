import { type Static, type TSchema } from "typebox";
import { Parse, ParseError } from "typebox/value";

type HostSafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error?: { message?: string } };

export function parseToolInput<const Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  label: string,
): Static<Schema> {
  const safeParse = getSafeParse<Static<Schema>>(schema);
  if (safeParse !== undefined) {
    const result = safeParse(value);
    if (!result.success) {
      const message = result.error?.message ?? "invalid value";
      throw new Error(`Invalid ${label} tool input: ${message}`);
    }
    return result.data;
  }
  try {
    return Parse(schema, value);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    const details = error.cause.errors
      .slice(0, 3)
      .map(({ instancePath, message }) => {
        const field = instancePath.replace(/^\//u, "").replaceAll("/", ".");
        const clearMessage = message === "must be integer" ? "must be an integer" : message;
        return `${field ? `${field} ` : ""}${clearMessage}`;
      })
      .join("; ");
    throw new Error(`Invalid ${label} tool input: ${details}`, { cause: error });
  }
}

function getSafeParse<T>(
  schema: unknown,
): ((value: unknown) => HostSafeParseResult<T>) | undefined {
  if (
    (typeof schema === "function" || isRecord(schema)) &&
    typeof (schema as { safeParse?: unknown }).safeParse === "function"
  ) {
    return (value) =>
      (schema as { safeParse: (input: unknown) => HostSafeParseResult<T> }).safeParse(value);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
