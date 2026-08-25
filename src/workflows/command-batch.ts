import path from "node:path";
import { CancelledError, TimeoutError, errorMessage, isAbortLikeError } from "./errors.js";
import { runShellAction, shellOutputTruncation, shellResultFromError } from "./shell.js";
import { redactSensitiveArgs, redactSensitiveText } from "./text.js";
import type { MaybePromise, ShellActionResult } from "./types.js";

export const COMMAND_BATCH_RESULT_SCHEMA = "pi-workflows.command-batch-result.v1";
export const MAX_COMMAND_BATCH_ITEMS = 64;
export const MAX_COMMAND_BATCH_CONCURRENCY = 8;
export const MAX_COMMAND_BATCH_TIMEOUT_MS = 60 * 60_000;
export const MAX_COMMAND_BATCH_OUTPUT_CHARS = 1_000_000;

const MAX_ERROR_CHARS = 2_000;
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const COMMAND_BATCH_ITEM_KEYS: Record<string, true> = {
  id: true,
  command: true,
  args: true,
  cwd: true,
  expectedCommit: true,
  expectedRef: true,
  timeoutMs: true,
  maxOutputChars: true,
  env: true,
  envUnset: true,
};

export type CommandBatchItem = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  /** Require this Git commit and a clean tracked checkout immediately before execution. */
  expectedCommit?: string;
  /** Require a Git ref to resolve to this immutable commit immediately before execution. */
  expectedRef?: { name: string; commit: string };
  timeoutMs: number;
  maxOutputChars: number;
  env?: NodeJS.ProcessEnv;
  envUnset?: string[];
};

export type CommandBatchRequest = {
  items: CommandBatchItem[];
  maxConcurrency: number;
};

export type CommandBatchItemOutcome = "succeeded" | "failed" | "timedOut" | "cancelled";

export type CommandBatchItemResult = ShellActionResult & {
  id: string;
  outcome: CommandBatchItemOutcome;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
};

export type CommandBatchResult = {
  schema: typeof COMMAND_BATCH_RESULT_SCHEMA;
  items: CommandBatchItemResult[];
  completed: number;
  total: number;
};

export type RunCommandBatchOptions = {
  signal?: AbortSignal;
  gitCommand?: string;
  validateBeforeGitSpawn?: (item: CommandBatchItem) => void | string;
  validateBeforeSpawn?: (item: CommandBatchItem) => void | string;
  onItemSettled?: (
    result: CommandBatchItemResult,
    completed: number,
    total: number,
  ) => MaybePromise<void>;
};

export function validateCommandBatchRequest(value: unknown): CommandBatchRequest {
  const request = requireRecord(value, "command batch request");
  for (const key of Object.keys(request)) {
    if (key !== "items" && key !== "maxConcurrency") {
      throw new Error(`command batch request.${key} is not supported`);
    }
  }
  if (!Array.isArray(request.items)) {
    throw new Error("command batch items must be an array");
  }
  if (request.items.length > MAX_COMMAND_BATCH_ITEMS) {
    throw new Error(`command batch items must contain at most ${MAX_COMMAND_BATCH_ITEMS} entries`);
  }
  const ids = new Set<string>();
  const items = request.items.map((item, index) => {
    const normalized = validateItem(item, index);
    if (ids.has(normalized.id)) {
      throw new Error(`command batch item id is duplicated: ${normalized.id}`);
    }
    ids.add(normalized.id);
    return normalized;
  });
  const maxConcurrency = positiveInteger(
    request.maxConcurrency,
    "command batch maxConcurrency",
    MAX_COMMAND_BATCH_CONCURRENCY,
  );
  return { items, maxConcurrency };
}

export async function runCommandBatch(
  input: CommandBatchRequest,
  options: RunCommandBatchOptions = {},
): Promise<CommandBatchResult> {
  const request = validateCommandBatchRequest(input);
  const total = request.items.length;
  if (total === 0) {
    return { schema: COMMAND_BATCH_RESULT_SCHEMA, items: [], completed: 0, total: 0 };
  }

  const results = Array.from<CommandBatchItemResult | undefined>({ length: total });
  const signal = options.signal;
  let nextIndex = 0;
  let completed = 0;

  const worker = async () => {
    while (!signal?.aborted) {
      const index = nextIndex;
      if (index >= total) return;
      nextIndex += 1;
      if (signal?.aborted) return;

      const item = request.items[index];
      if (item === undefined) return;
      const result = await runItem(
        item,
        signal,
        options.gitCommand,
        options.validateBeforeGitSpawn,
        options.validateBeforeSpawn,
      );
      results[index] = result;
      completed += 1;
      try {
        await options.onItemSettled?.(result, completed, total);
      } catch {
        // Completion callbacks are observational and cannot change batch execution.
      }
    }
  };

  const workerCount = Math.min(request.maxConcurrency, total);
  await Promise.all(Array.from({ length: workerCount }, worker));

  for (let index = 0; index < total; index += 1) {
    if (results[index] !== undefined) continue;
    const item = request.items[index];
    if (item !== undefined) results[index] = cancelledResult(item);
  }

  return {
    schema: COMMAND_BATCH_RESULT_SCHEMA,
    items: results as CommandBatchItemResult[],
    completed,
    total,
  };
}

function validateItem(value: unknown, index: number): CommandBatchItem {
  const item = requireRecord(value, `command batch items[${index}]`);
  for (const key of Object.keys(item)) {
    if (COMMAND_BATCH_ITEM_KEYS[key] !== true) {
      throw new Error(`command batch items[${index}].${key} is not supported`);
    }
  }
  const id = requireString(item.id, `command batch items[${index}].id`);
  if (!ITEM_ID_PATTERN.test(id)) {
    throw new Error(`command batch items[${index}].id is invalid`);
  }
  const command = requireString(item.command, `command batch items[${index}].command`);
  if (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`command batch items[${index}].args must be an array of strings`);
  }
  const cwd = requireString(item.cwd, `command batch items[${index}].cwd`);
  if (!path.isAbsolute(cwd)) {
    throw new Error(`command batch items[${index}].cwd must be absolute`);
  }
  const expectedCommit = optionalCommitHash(
    item.expectedCommit,
    `command batch items[${index}].expectedCommit`,
  );
  const expectedRef = optionalExpectedRef(
    item.expectedRef,
    `command batch items[${index}].expectedRef`,
  );
  const timeoutMs = positiveInteger(
    item.timeoutMs,
    `command batch items[${index}].timeoutMs`,
    MAX_COMMAND_BATCH_TIMEOUT_MS,
  );
  const maxOutputChars = positiveInteger(
    item.maxOutputChars,
    `command batch items[${index}].maxOutputChars`,
    MAX_COMMAND_BATCH_OUTPUT_CHARS,
  );
  const env = optionalEnv(item.env, `command batch items[${index}].env`);
  const envUnset = optionalStringArray(item.envUnset, `command batch items[${index}].envUnset`);
  return {
    id,
    command,
    args: [...item.args] as string[],
    cwd,
    ...(expectedCommit === undefined ? {} : { expectedCommit }),
    ...(expectedRef === undefined ? {} : { expectedRef }),
    timeoutMs,
    maxOutputChars,
    ...(env === undefined ? {} : { env }),
    ...(envUnset === undefined ? {} : { envUnset }),
  };
}

async function runItem(
  item: CommandBatchItem,
  signal?: AbortSignal,
  gitCommand = "git",
  validateBeforeGitSpawn?: (item: CommandBatchItem) => void | string,
  validateBeforeSpawn?: (item: CommandBatchItem) => void | string,
): Promise<CommandBatchItemResult> {
  try {
    if (item.expectedCommit !== undefined || item.expectedRef !== undefined) {
      const preconditionFailure = await checkGitPreconditions(
        item,
        signal,
        gitCommand,
        validateBeforeGitSpawn,
      );
      if (preconditionFailure !== undefined) {
        return itemResult(
          item.id,
          "failed",
          {
            ...emptyShellResult(item),
            stderr: preconditionFailure,
            exitCode: null,
          },
          preconditionFailure,
        );
      }
    }
    if (validateBeforeSpawn !== undefined) {
      const validationFailure = validateBeforeSpawn(item);
      if (validationFailure !== undefined && validationFailure !== "") {
        return itemResult(
          item.id,
          "failed",
          {
            ...emptyShellResult(item),
            stderr: validationFailure,
            exitCode: null,
          },
          validationFailure,
        );
      }
    }
    const result = await runShellAction(
      {
        command: item.command,
        args: item.args,
        cwd: item.cwd,
        timeoutMs: item.timeoutMs,
        maxOutputChars: item.maxOutputChars,
        ...childEnv(item),
      },
      signal,
    );
    return itemResult(item.id, "succeeded", result);
  } catch (error) {
    const result = shellResultFromError(error) ?? emptyShellResult(item);
    const outcome =
      error instanceof TimeoutError
        ? "timedOut"
        : error instanceof CancelledError || isAbortLikeError(error)
          ? "cancelled"
          : "failed";
    return itemResult(item.id, outcome, result, boundedError(error));
  }
}

async function checkGitPreconditions(
  item: CommandBatchItem,
  signal?: AbortSignal,
  gitCommand = "git",
  validateBeforeGitSpawn?: (item: CommandBatchItem) => void | string,
): Promise<string | undefined> {
  try {
    if (item.expectedCommit !== undefined) {
      const trustFailure = validateBeforeGitSpawn?.(item);
      if (trustFailure !== undefined && trustFailure !== "") return trustFailure;
      const status = await runShellAction(
        {
          command: gitCommand,
          args: ["status", "--porcelain=v2", "--branch", "--untracked-files=no"],
          cwd: item.cwd,
          timeoutMs: Math.min(item.timeoutMs, 10_000),
          maxOutputChars: 16_000,
          ...childEnv(item),
        },
        signal,
      );
      const lines = status.stdout.trimEnd().split("\n");
      const headLine = lines.find((line) => line.startsWith("# branch.oid "));
      const actualCommit = headLine?.slice("# branch.oid ".length).toLowerCase() ?? "";
      if (lines.some((line) => line.length > 0 && !line.startsWith("# "))) {
        return `Command precondition failed: tracked checkout is dirty at ${item.cwd}`;
      }
      if (actualCommit !== item.expectedCommit) {
        return `Command precondition failed: expected Git HEAD ${item.expectedCommit}, found ${actualCommit || "no commit"}`;
      }
    }
    if (item.expectedRef !== undefined) {
      const trustFailure = validateBeforeGitSpawn?.(item);
      if (trustFailure !== undefined && trustFailure !== "") return trustFailure;
      const resolved = await runShellAction(
        {
          command: gitCommand,
          args: ["rev-parse", "--verify", "--end-of-options", `${item.expectedRef.name}^{commit}`],
          cwd: item.cwd,
          timeoutMs: Math.min(item.timeoutMs, 10_000),
          maxOutputChars: 16_000,
          ...childEnv(item),
        },
        signal,
      );
      const actualRefCommit = resolved.stdout.trim().toLowerCase();
      if (actualRefCommit !== item.expectedRef.commit) {
        return `Command precondition failed: expected Git ref ${item.expectedRef.name} at ${item.expectedRef.commit}, found ${actualRefCommit || "no commit"}`;
      }
    }
    return undefined;
  } catch (error) {
    if (error instanceof CancelledError || isAbortLikeError(error)) throw error;
    return `Command precondition failed: ${boundedError(error)}`;
  }
}

function itemResult(
  id: string,
  outcome: CommandBatchItemOutcome,
  result: ShellActionResult,
  error?: string,
): CommandBatchItemResult {
  const truncation = shellOutputTruncation(result);
  const redactedResult = {
    ...result,
    command: redactSensitiveText(result.command),
    args: redactSensitiveArgs(result.args),
    cwd: redactSensitiveText(result.cwd),
    stdout: redactSensitiveText(result.stdout),
    stderr: redactSensitiveText(result.stderr),
  };
  return {
    id,
    outcome,
    ...redactedResult,
    stdoutTruncated: truncation.stdout,
    stderrTruncated: truncation.stderr,
    ...(error !== undefined ? { error: redactSensitiveText(error) } : {}),
  };
}

function cancelledResult(item: CommandBatchItem): CommandBatchItemResult {
  return itemResult(item.id, "cancelled", emptyShellResult(item), "Command was not started");
}

function emptyShellResult(item: CommandBatchItem): ShellActionResult {
  return {
    command: item.command,
    args: [...item.args],
    cwd: item.cwd,
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    durationMs: 0,
  };
}

function boundedError(error: unknown): string {
  const message = errorMessage(error);
  return redactSensitiveText(message, MAX_ERROR_CHARS);
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}`);
  }
  return value as number;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalEnv(value: unknown, label: string): NodeJS.ProcessEnv | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.length === 0) throw new Error(`${label} keys must be non-empty`);
    if (typeof entry !== "string") {
      throw new Error(`${label}.${key} must be a string`);
    }
    env[key] = entry;
  }
  return env;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...value] as string[];
}

function optionalCommitHash(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const commit = requireString(value, label);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(commit)) {
    throw new Error(`${label} must be a 40-character or 64-character hex commit hash`);
  }
  return commit.toLowerCase();
}
function optionalExpectedRef(
  value: unknown,
  label: string,
): { name: string; commit: string } | undefined {
  if (value === undefined) return undefined;
  const expected = requireRecord(value, label);
  for (const key of Object.keys(expected)) {
    if (key !== "name" && key !== "commit") {
      throw new Error(`${label}.${key} is not supported`);
    }
  }
  const name = requireString(expected.name, `${label}.name`);
  if (name.startsWith("-") || name.includes("\0")) {
    throw new Error(`${label}.name is not a valid Git ref`);
  }
  const commit = optionalCommitHash(expected.commit, `${label}.commit`);
  if (commit === undefined) throw new Error(`${label}.commit is required`);
  return { name, commit };
}

function childEnv(item: CommandBatchItem): { inheritEnv: false; env?: NodeJS.ProcessEnv } {
  if (item.env === undefined && (item.envUnset === undefined || item.envUnset.length === 0)) {
    return { inheritEnv: false };
  }
  const env: NodeJS.ProcessEnv = item.env === undefined ? {} : { ...item.env };
  for (const key of item.envUnset ?? []) env[key] = undefined;
  return { inheritEnv: false, env };
}
