import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as codingAgentModule from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type LoadExtensionsResult,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import type {
  createAgentSessionRuntime as CreateAgentSessionRuntime,
  createAgentSessionServices as CreateAgentSessionServices,
  DefaultPackageManager as DefaultPackageManagerConstructor,
  ExtensionRunner as ExtensionRunnerConstructor,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { redactSensitiveText } from "../workflows/text.js";

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_AGENTS = 8;
const MAX_CONCURRENCY = 8;
const MAX_PROMPT_CHARS = 96_000;
const DEFAULT_FINAL_CHARS = 256_000;
const MAX_FINAL_CHARS = 1_000_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_TIMEOUT_MS = 60 * 60_000;
const MAX_CLEANUP_TIMEOUT_MS = 5_000;
const MIN_CLEANUP_TIMEOUT_MS = 100;
const MAX_ERROR_CHARS = 2_000;
const MAX_PHASE_UPDATES = 64;
const MIN_PHASE_INTERVAL_MS = 250;
const BUILTIN_TOOLS: Record<string, true> = { read: true, grep: true, find: true, ls: true };
const RESERVED_EXTENSION_NAMES: Record<string, true> = {
  workflow: true,
  piw: true,
  controller: true,
  "workflow-update": true,
  "workflow-answer": true,
  "workflow-submit": true,
  "workflow-pause": true,
  "workflow-resume": true,
  "workflow-cancel": true,
};
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type ModelRuntimeConstructor = typeof ModelRuntime;

type CodingAgentCompatibilityModule = {
  ModelRuntime?: ModelRuntimeConstructor;
  createAgentSessionRuntime?: typeof CreateAgentSessionRuntime;
  createAgentSessionServices?: typeof CreateAgentSessionServices;
  DefaultPackageManager?: typeof DefaultPackageManagerConstructor;
  ExtensionRunner?: typeof ExtensionRunnerConstructor;
};
const {
  ModelRuntime: PiModelRuntime,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultPackageManager,
  ExtensionRunner,
} = codingAgentModule as unknown as CodingAgentCompatibilityModule;

export type PiAgentTool = "read" | "grep" | "find" | "ls";
export type PiAgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type PiAgentRequest = {
  id: string;
  role: string;
  prompt: string;
  cwd: string;
  tools: PiAgentTool[];
  timeoutMs?: number;
  model?: { provider: string; id: string };
  thinkingLevel?: PiAgentThinkingLevel;
};

export type PiAgentResult = {
  id: string;
  text: string;
  model: string;
  thinkingLevel: PiAgentThinkingLevel;
  durationMs: number;
};

export type PiAgentLifecycleState = "running" | "completed" | "failed" | "cancelled";

export type PiAgentLifecycleEvent = {
  id: string;
  role: string;
  state: PiAgentLifecycleState;
  phase: string;
  elapsedMs: number;
  model?: string;
  thinkingLevel?: PiAgentThinkingLevel;
};

type PiAgentEvent = Record<string, unknown>;

type PiAgentSession = {
  prompt(text: string, options?: { preflightResult?: (accepted: boolean) => void }): Promise<void>;
  subscribe(listener: (event: PiAgentEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  model: { provider: string; id: string } | undefined;
  thinkingLevel: PiAgentThinkingLevel;
};

export type PiAgentSessionFactory = (
  request: PiAgentRequest,
  context: { modelRuntime?: ModelRuntime; signal: AbortSignal },
) => Promise<PiAgentSession>;

export type PiAgentGroupOptions = {
  maxConcurrency: number;
  signal: AbortSignal;
  failFast?: boolean;
  maxFinalChars?: number;
  onLifecycle?: (event: PiAgentLifecycleEvent) => void | Promise<void>;
  sessionFactory?: PiAgentSessionFactory;
  behaviorExtensionPaths?: string[];
  now?: () => number;
};

export class PiAgentGroupError extends Error {
  constructor(
    readonly agentId: string,
    readonly code: string,
    message: string,
  ) {
    super(`Pi agent ${agentId} ${code}: ${bounded(message)}`);
    this.name = "PiAgentGroupError";
  }
}

export async function runPiAgentGroup(
  input: PiAgentRequest[],
  options: PiAgentGroupOptions,
): Promise<PiAgentResult[]> {
  const { requests, maxFinalChars, behaviorExtensionPaths } = validateGroup(input, options);
  if (requests.length === 0) return [];
  if (options.signal.aborted) throw cancellationError("group", options.signal.reason);
  const externalSignal = options.signal;
  const maxConcurrency = options.maxConcurrency;
  const failFast = options.failFast;
  const onLifecycle = options.onLifecycle;
  const now = options.now;
  const suppliedSessionFactory = options.sessionFactory;

  const modelRuntime =
    suppliedSessionFactory === undefined && PiModelRuntime !== undefined
      ? await PiModelRuntime.create({
          allowModelNetwork: false,
          modelsStore: await createLoadedModelStore(externalSignal),
          modelsPath: path.join(getAgentDir(), "models.json"),
          authPath: path.join(getAgentDir(), "auth.json"),
        })
      : undefined;
  if (externalSignal.aborted) throw cancellationError("group", externalSignal.reason);
  const sessionFactory =
    suppliedSessionFactory ??
    (async (
      request: PiAgentRequest,
      context: { modelRuntime?: ModelRuntime; signal: AbortSignal },
    ) => await createSdkSession(request, context, behaviorExtensionPaths));
  const internalAbort = new AbortController();
  const signal = AbortSignal.any([externalSignal, internalAbort.signal]);
  const runOptions: RunOneOptions = Object.freeze({
    maxConcurrency,
    signal,
    maxFinalChars,
    sessionFactory,
    ...(failFast === undefined ? {} : { failFast }),
    ...(onLifecycle === undefined ? {} : { onLifecycle }),
    ...(now === undefined ? {} : { now }),
    ...(modelRuntime === undefined ? {} : { modelRuntime }),
  });
  const results = Array.from<PiAgentResult | undefined>({ length: requests.length });
  const started = new Set<number>();
  let nextIndex = 0;
  let primary: { index: number; error: unknown } | undefined;

  const worker = async () => {
    while (!signal.aborted) {
      const index = nextIndex;
      if (index >= requests.length) return;
      nextIndex += 1;
      started.add(index);
      try {
        results[index] = await runOneAgent(requests[index]!, runOptions);
      } catch (error) {
        if (primary === undefined && !externalSignal.aborted) {
          primary = { index, error };
          if (failFast !== false) internalAbort.abort(error);
        }
        if (failFast !== false) return;
      }
    }
  };

  const workerCount = Math.min(maxConcurrency, requests.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  if (externalSignal.aborted) throw cancellationError("group", externalSignal.reason);
  if (primary !== undefined) {
    await publishQueuedCancellations(requests, started, runOptions);
    throw primary.error;
  }
  return results as PiAgentResult[];
}

type ModelRuntimeCreateOptions = NonNullable<Parameters<ModelRuntimeConstructor["create"]>[0]>;
type CredentialStore = NonNullable<ModelRuntimeCreateOptions["credentials"]>;
type Credential = Awaited<ReturnType<CredentialStore["read"]>>;
type StoredCredential = Exclude<Credential, undefined>;
type ModelStore = NonNullable<ModelRuntimeCreateOptions["modelsStore"]>;
type ModelStoreEntry = Awaited<ReturnType<ModelStore["read"]>>;
type StoredModelStoreEntry = Exclude<ModelStoreEntry, undefined>;

export async function createEphemeralCredentialStore(
  signal: AbortSignal,
): Promise<CredentialStore> {
  signal.throwIfAborted();
  const authPath = path.join(getAgentDir(), "auth.json");
  let source: unknown = {};
  try {
    source = JSON.parse(await fs.readFile(authPath, "utf8"));
  } catch (error) {
    if (!isMissingFile(error)) {
      throw new Error("Could not load Pi credentials for isolated agents");
    }
  }
  const entries = parseCredentialEntries(source);
  const pending = new Map<string, Promise<Credential>>();
  const enqueue = (
    providerId: string,
    operation: () => Promise<Credential>,
  ): Promise<Credential> => {
    const work = (pending.get(providerId) ?? Promise.resolve(undefined))
      .catch(() => undefined)
      .then(operation);
    pending.set(providerId, work);
    const release = () => {
      if (pending.get(providerId) === work) pending.delete(providerId);
    };
    void work.then(release, release);
    return work;
  };
  return {
    async read(providerId) {
      signal.throwIfAborted();
      return cloneCredential(entries.get(providerId));
    },
    async list() {
      signal.throwIfAborted();
      return [...entries].map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    },
    async modify(providerId, update) {
      return await enqueue(providerId, async () => {
        signal.throwIfAborted();
        const current = entries.get(providerId);
        const next = await update(cloneCredential(current));
        signal.throwIfAborted();
        if (next !== undefined) entries.set(providerId, cloneCredential(next)!);
        return cloneCredential(entries.get(providerId));
      });
    },
    async delete(providerId) {
      await enqueue(providerId, async () => {
        signal.throwIfAborted();
        entries.delete(providerId);
        return undefined;
      });
    },
  };
}

function parseCredentialEntries(source: unknown): Map<string, StoredCredential> {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Could not load Pi credentials for isolated agents");
  }
  const entries = new Map<string, StoredCredential>();
  for (const [providerId, value] of Object.entries(source)) {
    if (!isStoredCredential(value)) {
      throw new Error("Could not load Pi credentials for isolated agents");
    }
    entries.set(providerId, cloneCredential(value)!);
  }
  return entries;
}

function isStoredCredential(value: unknown): value is StoredCredential {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const credential = value as Record<string, unknown>;
  if (credential.type === "api_key") {
    return credential.key === undefined || typeof credential.key === "string";
  }
  return (
    credential.type === "oauth" &&
    typeof credential.refresh === "string" &&
    typeof credential.access === "string" &&
    typeof credential.expires === "number"
  );
}

function cloneCredential(value: StoredCredential | undefined): Credential {
  return value === undefined ? undefined : structuredClone(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function createEphemeralModelStore(): ModelStore {
  const entries = new Map<string, ModelStoreEntry>();
  return {
    async read(providerId) {
      return entries.get(providerId);
    },
    async write(providerId, entry) {
      entries.set(providerId, entry);
    },
    async delete(providerId) {
      entries.delete(providerId);
    },
  };
}
async function createLoadedModelStore(signal: AbortSignal): Promise<ModelStore> {
  signal.throwIfAborted();
  const storePath = path.join(getAgentDir(), "models-store.json");
  let source: unknown = {};
  try {
    source = JSON.parse(await fs.readFile(storePath, "utf8"));
  } catch (error) {
    if (!isMissingFile(error)) {
      throw new Error("Could not load Pi model catalog for isolated agents");
    }
  }
  const entries = parseModelStoreEntries(source);
  return {
    async read(providerId) {
      signal.throwIfAborted();
      const entry = entries.get(providerId);
      return entry === undefined ? undefined : structuredClone(entry);
    },
    async write(providerId, entry) {
      signal.throwIfAborted();
      entries.set(providerId, structuredClone(entry));
    },
    async delete(providerId) {
      signal.throwIfAborted();
      entries.delete(providerId);
    },
  };
}

function parseModelStoreEntries(source: unknown): Map<string, StoredModelStoreEntry> {
  if (!isRecord(source)) {
    throw new Error("Could not load Pi model catalog for isolated agents");
  }
  const entries = new Map<string, StoredModelStoreEntry>();
  for (const [providerId, value] of Object.entries(source)) {
    if (!isModelStoreEntry(value)) {
      throw new Error("Could not load Pi model catalog for isolated agents");
    }
    entries.set(providerId, structuredClone(value));
  }
  return entries;
}

function isModelStoreEntry(value: unknown): value is StoredModelStoreEntry {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.models) &&
    (value.lastModified === undefined || typeof value.lastModified === "number") &&
    (value.checkedAt === undefined || typeof value.checkedAt === "number") &&
    (value.etag === undefined || typeof value.etag === "string")
  );
}

type RunOneOptions = PiAgentGroupOptions & {
  signal: AbortSignal;
  sessionFactory: PiAgentSessionFactory;
  modelRuntime?: ModelRuntime;
};

async function runOneAgent(
  request: PiAgentRequest,
  options: RunOneOptions,
): Promise<PiAgentResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const lifecycle = lifecyclePublisher(request, startedAt, options);
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cleanupTimeoutMs = Math.min(
    MAX_CLEANUP_TIMEOUT_MS,
    Math.max(MIN_CLEANUP_TIMEOUT_MS, timeoutMs),
  );
  const sessionAbort = new AbortController();
  const sessionSignal = AbortSignal.any([options.signal, sessionAbort.signal]);
  let session: PiAgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let finalMessage: Record<string, unknown> | undefined;
  let preflightAccepted: boolean | undefined;
  let abortKind: "timeout" | "cancelled" | undefined;
  let abortFailure: unknown;
  let abortWork = Promise.resolve();
  let sessionAbortRequested = false;
  let result: PiAgentResult | undefined;
  let failure: unknown;

  const abortSession = (kind: "timeout" | "cancelled") => {
    abortKind ??= kind;
    if (!sessionAbort.signal.aborted) {
      sessionAbort.abort(new Error(kind === "timeout" ? "agent timed out" : "agent cancelled"));
    }
    if (session !== undefined && !sessionAbortRequested) {
      sessionAbortRequested = true;
      abortWork = abortWork
        .then(async () => await session?.abort())
        .catch((error) => {
          abortFailure = error;
        });
    }
  };
  const onAbort = () => abortSession("cancelled");
  const timeout = setTimeout(() => abortSession("timeout"), timeoutMs);
  options.signal.addEventListener("abort", onAbort, { once: true });

  lifecycle.emit("running", "starting");
  try {
    if (options.signal.aborted) throw cancellationError(request.id, options.signal.reason);
    const sessionCreation = Promise.resolve().then(
      async () =>
        await options.sessionFactory(request, {
          ...(options.modelRuntime !== undefined ? { modelRuntime: options.modelRuntime } : {}),
          signal: sessionSignal,
        }),
    );
    session = await waitForSessionCreation(sessionCreation, sessionSignal, cleanupTimeoutMs);
    const model = modelName(session.model);
    lifecycle.setDispatch(model, session.thinkingLevel);
    lifecycle.emit("running", "starting", true);
    unsubscribe = session.subscribe((event) => {
      const phase = eventPhase(event, request.tools);
      if (phase !== undefined) lifecycle.emit("running", phase);
      const message = assistantMessage(event);
      if (message !== undefined) finalMessage = message;
    });
    if (abortKind !== undefined || options.signal.aborted) {
      abortSession(abortKind ?? "cancelled");
      const abortCleanupError = await cleanupFailure(abortWork, cleanupTimeoutMs, "abort");
      abortFailure ??= abortCleanupError;
      if (abortKind === "timeout") {
        throw new PiAgentGroupError(
          request.id,
          "timed out",
          `after ${timeoutMs}ms${abortSuffix(abortFailure)}`,
        );
      }
      throw new PiAgentGroupError(
        request.id,
        "cancelled",
        `${cancellationReason(options.signal.reason)}${abortSuffix(abortFailure)}`,
      );
    }

    const promptWork = Promise.resolve().then(
      async () =>
        await session!.prompt(request.prompt, {
          preflightResult: (accepted) => {
            preflightAccepted = accepted;
          },
        }),
    );
    void promptWork.catch(() => {});
    await waitForPromptExecution(promptWork, sessionSignal);
    const abortCleanupError = await cleanupFailure(abortWork, cleanupTimeoutMs, "abort");
    abortFailure ??= abortCleanupError;
    if (abortKind === "timeout") {
      throw new PiAgentGroupError(
        request.id,
        "timed out",
        `after ${timeoutMs}ms${abortSuffix(abortFailure)}`,
      );
    }
    if (abortKind === "cancelled" || options.signal.aborted) {
      throw new PiAgentGroupError(
        request.id,
        "cancelled",
        `${cancellationReason(options.signal.reason)}${abortSuffix(abortFailure)}`,
      );
    }
    if (preflightAccepted === false) {
      throw new PiAgentGroupError(request.id, "rejected prompt", "prompt preflight failed");
    }
    lifecycle.emit("running", "finalizing", true);
    const text = finalAssistantText(request.id, finalMessage, options.maxFinalChars!);
    result = {
      id: request.id,
      text,
      model,
      thinkingLevel: session.thinkingLevel,
      durationMs: Math.max(0, now() - startedAt),
    };
  } catch (error) {
    failure = normalizeAgentError(request.id, error, abortKind, options.signal);
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", onAbort);
    unsubscribe?.();
    if (session !== undefined && abortKind !== undefined) {
      const abortCleanupError = await cleanupFailure(abortWork, cleanupTimeoutMs, "abort");
      abortFailure ??= abortCleanupError;
    }
    if (session !== undefined) {
      const cleanupError = await cleanupFailure(
        Promise.resolve().then(async () => await session?.dispose()),
        cleanupTimeoutMs,
        "disposal",
      );
      if (cleanupError !== undefined) {
        failure ??= new PiAgentGroupError(request.id, "cleanup failed", errorMessage(cleanupError));
      }
    }
    const state = terminalState(failure);
    lifecycle.emit(state, state, true);
    await lifecycle.flush();
  }
  if (failure !== undefined) throw failure;
  return result!;
}
async function waitForSessionCreation(
  work: Promise<PiAgentSession>,
  signal: AbortSignal,
  cleanupTimeoutMs: number,
): Promise<PiAgentSession> {
  return await new Promise<PiAgentSession>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason ?? new Error("session creation aborted"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      (created) => {
        if (settled) {
          void cleanupLateSession(created, cleanupTimeoutMs);
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(created);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function waitForPromptExecution(work: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function cleanupLateSession(
  session: PiAgentSession,
  cleanupTimeoutMs: number,
): Promise<void> {
  await cleanupFailure(
    Promise.resolve().then(async () => await session.abort()),
    cleanupTimeoutMs,
    "late session abort",
  );
  await cleanupFailure(
    Promise.resolve().then(async () => await session.dispose()),
    cleanupTimeoutMs,
    "late session disposal",
  );
}

async function cleanupFailure(
  work: Promise<void>,
  timeoutMs: number,
  operation: string,
): Promise<unknown | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${operation} did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return undefined;
  } catch (error) {
    return error;
  } finally {
    clearTimeout(timeout);
  }
}
function lifecyclePublisher(
  request: PiAgentRequest,
  startedAt: number,
  options: RunOneOptions,
): {
  emit(state: PiAgentLifecycleState, phase: string, force?: boolean): void;
  setDispatch(model: string, thinkingLevel: PiAgentThinkingLevel): void;
  flush(): Promise<void>;
} {
  const now = options.now ?? Date.now;
  let model: string | undefined;
  let thinkingLevel: PiAgentThinkingLevel | undefined;
  let previous = "";
  let previousAt = -Infinity;
  let phaseUpdates = 0;
  let work = Promise.resolve();
  const emit = (state: PiAgentLifecycleState, phase: string, force = false) => {
    const at = now();
    const key = `${state}:${phase}:${model ?? ""}`;
    if (!force && (key === previous || at - previousAt < MIN_PHASE_INTERVAL_MS)) return;
    if (!force && phaseUpdates >= MAX_PHASE_UPDATES) return;
    previous = key;
    previousAt = at;
    phaseUpdates += 1;
    if (options.onLifecycle === undefined) return;
    const event: PiAgentLifecycleEvent = {
      id: request.id,
      role: request.role,
      state,
      phase,
      elapsedMs: Math.max(0, at - startedAt),
      ...(model !== undefined ? { model } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    };
    work = work.then(async () => await options.onLifecycle?.(event)).catch(() => undefined);
  };
  return {
    emit,
    setDispatch(value, thinking) {
      model = value;
      thinkingLevel = thinking;
    },
    async flush() {
      await work;
    },
  };
}

export function ompAgentToolNames(tools: readonly PiAgentTool[]): string[] {
  const names = new Set<string>();
  for (const tool of tools) names.add(tool === "find" || tool === "ls" ? "glob" : tool);
  return [...names];
}
type ExtensionCandidate = {
  path: string;
  source: string;
  configured: boolean;
  packageOwner?: string;
};
type ChildExtensionAdmission = {
  extensionPaths: readonly string[];
  providerOwners: readonly string[];
};

async function resolveChildExtensionPaths(
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
  provider: string,
  behaviorExtensionPaths: string[],
  signal: AbortSignal,
): Promise<ChildExtensionAdmission | undefined> {
  signal.throwIfAborted();
  if (DefaultPackageManager === undefined) {
    throw new Error("Pi child extension package manager is unavailable");
  }
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await packageManager.resolve(async () => "skip");
  const candidates = new Map<string, ExtensionCandidate>();
  for (const resource of resolved.extensions) {
    if (!resource.enabled || resource.metadata.scope !== "user") continue;
    const candidate = await extensionCandidate(resource, signal);
    if (candidate !== undefined) candidates.set(candidate.path, candidate);
  }
  const behaviorPaths = await canonicalizeBehaviorPaths(behaviorExtensionPaths, signal);
  for (const behavior of behaviorPaths) {
    const installed = candidates.get(behavior.path);
    candidates.set(
      behavior.path,
      installed === undefined ? behavior : { ...installed, source: behavior.source },
    );
  }
  if (candidates.size === 0) return undefined;

  const candidateList = [...candidates.values()].toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
  const behaviorPathSet = new Set(behaviorPaths.map((candidate) => candidate.path));
  const providerPath = await resolveGenuineProviderOwner(
    cwd,
    agentDir,
    provider,
    signal,
    candidateList,
  );
  if (providerPath === undefined) {
    if (behaviorPaths.length > 0) {
      throw new PiAgentGroupError("group", "has no provider extension", provider);
    }
    return undefined;
  }
  const providerCandidate = candidates.get(providerPath);
  if (providerCandidate === undefined) {
    throw new PiAgentGroupError("group", "has invalid provider extension", provider);
  }

  const result = await loadExtensionPreflight(
    cwd,
    agentDir,
    candidateList.map((candidate) => candidate.path),
  );
  let admission: ChildExtensionAdmission | undefined;
  let failure: unknown;
  try {
    if (result.errors.length > 0) {
      throw new PiAgentGroupError("group", "could not load provider extensions", "load failed");
    }
    const byPath = new Map(
      await Promise.all(
        result.extensions.map(
          async (extension) =>
            [await canonicalPath(extension.resolvedPath, signal), extension] as const,
        ),
      ),
    );
    if (!byPath.has(providerPath)) {
      throw new PiAgentGroupError("group", "has invalid provider extension", provider);
    }
    const jointOwners = new Set<string>();
    for (const registration of result.runtime.pendingProviderRegistrations) {
      if (registration.name === provider) {
        jointOwners.add(await canonicalPath(registration.extensionPath, signal));
      }
    }
    const allowedOwners = new Set([providerPath]);
    if (providerCandidate.packageOwner !== undefined) {
      for (const owner of jointOwners) {
        if (
          !behaviorPathSet.has(owner) &&
          candidates.get(owner)?.configured === true &&
          candidates.get(owner)?.packageOwner === providerCandidate.packageOwner
        ) {
          allowedOwners.add(owner);
        }
      }
    }
    let replacedByBehavior = false;
    for (const owner of jointOwners) {
      if (behaviorPathSet.has(owner) && owner !== providerPath) {
        replacedByBehavior = true;
        break;
      }
    }
    if (jointOwners.size === 0 || [...jointOwners].some((owner) => !allowedOwners.has(owner))) {
      throw new PiAgentGroupError(
        "group",
        replacedByBehavior
          ? "behavior extension replaces selected provider"
          : "could not register provider extension",
        replacedByBehavior ? provider : "registration failed",
      );
    }
    const admitted = new Set([
      ...allowedOwners,
      ...behaviorPaths.map((candidate) => candidate.path),
    ]);
    for (const admittedPath of admitted) {
      const extension = byPath.get(admittedPath);
      if (extension === undefined) {
        throw new PiAgentGroupError("group", "could not load admitted extension", "load failed");
      }
      validateAdmittedExtension(extension, candidates.get(admittedPath)?.source ?? "extension");
    }
    admission = Object.freeze({
      extensionPaths: Object.freeze([...admitted].toSorted()),
      providerOwners: Object.freeze([...jointOwners].toSorted()),
    });
  } catch (error) {
    failure = error;
  }
  try {
    await settleExtensionPreflight(result, cwd);
  } catch {
    failure ??= new PiAgentGroupError(
      "group",
      "could not settle extension preflight",
      "cleanup failed",
    );
  }
  if (failure !== undefined) throw failure;
  return admission;
}

async function resolveGenuineProviderOwner(
  cwd: string,
  agentDir: string,
  provider: string,
  signal: AbortSignal,
  candidateList: ExtensionCandidate[],
): Promise<string | undefined> {
  let owner: string | undefined;
  let identity: string | undefined;
  for (const candidate of candidateList) {
    if (!candidate.configured) continue;
    signal.throwIfAborted();
    const result = await loadExtensionPreflight(cwd, agentDir, [candidate.path]);
    let failure: unknown;
    try {
      if (result.errors.length > 0) {
        throw new PiAgentGroupError("group", "could not load provider extensions", "load failed");
      }
      for (const registration of result.runtime.pendingProviderRegistrations) {
        if (registration.name !== provider) continue;
        const registrationOwner = await canonicalPath(registration.extensionPath, signal);
        const registrationIdentity = candidate.packageOwner ?? registrationOwner;
        if (identity !== undefined && identity !== registrationIdentity) {
          throw new PiAgentGroupError("group", "has competing provider extensions", provider);
        }
        owner ??= registrationOwner;
        identity = registrationIdentity;
      }
    } catch (error) {
      failure = error;
    }
    try {
      await settleExtensionPreflight(result, cwd);
    } catch {
      failure ??= new PiAgentGroupError(
        "group",
        "could not settle extension preflight",
        "cleanup failed",
      );
    }
    if (failure !== undefined) throw failure;
  }
  return owner;
}

async function loadExtensionPreflight(
  cwd: string,
  agentDir: string,
  extensionPaths: string[],
): Promise<LoadExtensionsResult> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
    additionalExtensionPaths: extensionPaths,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  return loader.getExtensions();
}

async function settleExtensionPreflight(result: LoadExtensionsResult, cwd: string): Promise<void> {
  try {
    await shutdownLoadedExtensions(result, cwd);
  } finally {
    result.runtime.invalidate("Pi agent extension preflight finished");
  }
}

async function shutdownLoadedExtensions(result: LoadExtensionsResult, cwd: string): Promise<void> {
  if (PiModelRuntime === undefined) throw new Error("Pi model runtime is unavailable");
  if (ExtensionRunner === undefined) throw new Error("Pi extension runner is unavailable");
  const signal = AbortSignal.timeout(MAX_CLEANUP_TIMEOUT_MS);
  const modelRuntime = await PiModelRuntime.create({
    allowModelNetwork: false,
    credentials: await createEphemeralCredentialStore(signal),
    modelsStore: createEphemeralModelStore(),
    modelsPath: null,
  });
  const runner = new ExtensionRunner(
    result.extensions,
    result.runtime,
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(modelRuntime),
  );
  runner.setUIContext(undefined, "print");
  let failed = false;
  const unsubscribe = runner.onError(() => {
    failed = true;
  });
  try {
    const emitFailure = await cleanupFailure(
      runner.emit({ type: "session_shutdown", reason: "quit" }),
      MAX_CLEANUP_TIMEOUT_MS,
      "extension cleanup",
    );
    if (emitFailure !== undefined) throw emitFailure;
  } finally {
    unsubscribe();
  }
  if (failed) throw new Error("extension cleanup failed");
}
async function extensionCandidate(
  resource: ResolvedResource,
  signal: AbortSignal,
): Promise<ExtensionCandidate | undefined> {
  const resolvedPath = await canonicalPath(resource.path, signal);
  if (await isPiWorkflowsExtension(resolvedPath, resource, signal)) return undefined;
  const packageOwner =
    resource.metadata.origin === "package" && resource.metadata.baseDir !== undefined
      ? await canonicalPath(resource.metadata.baseDir, signal)
      : undefined;
  return {
    path: resolvedPath,
    source: boundedSource(resource.metadata.source),
    configured: true,
    ...(packageOwner === undefined ? {} : { packageOwner }),
  };
}

async function canonicalizeBehaviorPaths(
  values: string[],
  signal: AbortSignal,
): Promise<ExtensionCandidate[]> {
  const result = new Map<string, ExtensionCandidate>();
  for (const value of values) {
    operationalText(value, "Pi agent behavior extension path", 4_000);
    const resolvedPath = await canonicalPath(value, signal);
    if (await isPiWorkflowsExtension(resolvedPath, undefined, signal)) {
      throw new Error("Pi Workflows cannot be admitted as a child extension");
    }
    result.set(resolvedPath, {
      path: resolvedPath,
      source: "explicit behavior extension",
      configured: false,
    });
  }
  return [...result.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

async function canonicalPath(value: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  try {
    return await fs.realpath(path.resolve(value));
  } catch {
    throw new Error("Could not resolve Pi child extension path");
  }
}

async function isPiWorkflowsExtension(
  extensionPath: string,
  resource: ResolvedResource | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  if (
    isUnder(extensionPath, path.join(PACKAGE_ROOT, "src", "extension")) ||
    isUnder(extensionPath, path.join(PACKAGE_ROOT, "dist", "extension"))
  ) {
    return true;
  }
  if (
    resource?.metadata.source.includes("@osolmaz/pi-workflows") ||
    resource?.metadata.source.includes("@ericjuta/omp-workflows")
  ) {
    return true;
  }
  let directory = resource?.metadata.baseDir ?? path.dirname(extensionPath);
  for (let depth = 0; depth < 8; depth += 1) {
    signal.throwIfAborted();
    const manifestPath = path.join(directory, "package.json");
    try {
      const manifest: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      if (isPiWorkflowsManifest(manifest, directory, extensionPath)) return true;
      return false;
    } catch (error) {
      if (!isMissingFile(error)) return false;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
  return false;
}

function isPiWorkflowsManifest(
  value: unknown,
  packageDirectory: string,
  extensionPath: string,
): boolean {
  if (!isRecord(value)) return false;
  let ownsPiWorkflows =
    value.name === "@osolmaz/pi-workflows" || value.name === "@ericjuta/omp-workflows";
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    if (
      isRecord(value[field]) &&
      ("@osolmaz/pi-workflows" in value[field] || "@ericjuta/omp-workflows" in value[field])
    ) {
      ownsPiWorkflows = true;
    }
  }
  if (!ownsPiWorkflows || !isRecord(value.pi) || !Array.isArray(value.pi.extensions)) return false;
  return value.pi.extensions.some(
    (entry) =>
      typeof entry === "string" &&
      path.resolve(packageDirectory, entry.replace(/\*+$/, "")) === extensionPath,
  );
}

function isUnder(value: string, parent: string): boolean {
  const relative = path.relative(parent, value);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateAdmittedExtension(
  extension: LoadExtensionsResult["extensions"][number],
  source: string,
): void {
  for (const name of extension.tools.keys()) {
    if (name in BUILTIN_TOOLS) {
      throw new PiAgentGroupError("group", "provider extension replaces a built-in tool", source);
    }
    if (isReservedExtensionName(name)) {
      throw new PiAgentGroupError("group", "provider extension exposes workflow control", source);
    }
  }
  for (const name of extension.commands.keys()) {
    if (isReservedExtensionName(name)) {
      throw new PiAgentGroupError("group", "provider extension exposes workflow control", source);
    }
  }
  if (extension.handlers.has("resources_discover")) {
    throw new PiAgentGroupError("group", "provider extension discovers child resources", source);
  }
}

function isReservedExtensionName(value: string): boolean {
  const name = value.toLowerCase();
  return (
    name in RESERVED_EXTENSION_NAMES || name.startsWith("workflow-") || name.startsWith("workflow:")
  );
}

function boundedSource(value: string): string {
  return redactSensitiveText(value.trim() || "extension", 200);
}
type PiModelDispatch = { provider: string; id: string };

async function createSdkSession(
  request: PiAgentRequest,
  context: { modelRuntime?: ModelRuntime; signal: AbortSignal },
  behaviorExtensionPaths: string[],
): Promise<PiAgentSession> {
  if (context.signal.aborted) throw cancellationError(request.id, context.signal.reason);
  if (context.modelRuntime === undefined) {
    if (behaviorExtensionPaths.length > 0) {
      throw new PiAgentGroupError(
        request.id,
        "cannot load provider extensions",
        "Pi model runtime is unavailable",
      );
    }
    return await createBasicSdkSession(request, context);
  }
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(request.cwd, agentDir, {
    projectTrusted: false,
  });
  const dispatch =
    request.model ?? settingsModel(settingsManager) ?? catalogModel(context.modelRuntime, agentDir);
  if (dispatch === undefined) return await createBasicSdkSession(request, context);
  const admission = await resolveChildExtensionPaths(
    request.cwd,
    agentDir,
    settingsManager,
    dispatch.provider,
    behaviorExtensionPaths,
    context.signal,
  );
  if (admission === undefined) return await createBasicSdkSession(request, context);
  return await createProviderSdkSession(
    request,
    dispatch,
    settingsManager,
    admission,
    context.signal,
  );
}

async function createBasicSdkSession(
  request: PiAgentRequest,
  context: { modelRuntime?: ModelRuntime; signal: AbortSignal },
): Promise<PiAgentSession> {
  if (context.signal.aborted) throw cancellationError(request.id, context.signal.reason);
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(request.cwd, agentDir, {
    projectTrusted: false,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: request.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();
  const modelRuntime =
    context.modelRuntime ??
    (PiModelRuntime === undefined
      ? undefined
      : await PiModelRuntime.create({
          allowModelNetwork: false,
          modelsPath: path.join(agentDir, "models.json"),
          authPath: path.join(agentDir, "auth.json"),
        }));
  if (context.signal.aborted) throw cancellationError(request.id, context.signal.reason);
  const model =
    modelRuntime === undefined
      ? undefined
      : resolveRequestedModel(request, modelRuntime, settingsManager, agentDir);
  const sessionOptions =
    modelRuntime === undefined
      ? {
          cwd: request.cwd,
          agentDir,
          settingsManager,
          resourceLoader,
          sessionManager: SessionManager.inMemory(request.cwd),
          toolNames: ompAgentToolNames(request.tools),
          restrictToolNames: true,
          enableMCP: false,
          enableLsp: false,
          ...(request.model !== undefined
            ? { modelPattern: `${request.model.provider}/${request.model.id}` }
            : {}),
          ...(request.thinkingLevel !== undefined ? { thinkingLevel: request.thinkingLevel } : {}),
        }
      : {
          cwd: request.cwd,
          agentDir,
          modelRuntime,
          settingsManager,
          resourceLoader,
          sessionManager: SessionManager.inMemory(request.cwd),
          tools: request.tools,
          ...(model !== undefined ? { model } : {}),
          ...(request.thinkingLevel !== undefined ? { thinkingLevel: request.thinkingLevel } : {}),
        };
  const { session } = await createAgentSession(sessionOptions);
  if (
    request.model !== undefined &&
    (session.model?.provider !== request.model.provider || session.model.id !== request.model.id)
  ) {
    session.dispose();
    throw new PiAgentGroupError(
      request.id,
      "has no model",
      `${request.model.provider}/${request.model.id}`,
    );
  }
  const activeTools = session.getActiveToolNames().toSorted();
  const requestedTools = (
    modelRuntime === undefined ? ompAgentToolNames(request.tools) : request.tools
  ).toSorted();
  if (activeTools.join("\0") !== requestedTools.join("\0")) {
    session.dispose();
    throw new PiAgentGroupError(
      request.id,
      "has unexpected tools",
      activeTools.length === 0 ? "no tools are active" : activeTools.join(", "),
    );
  }
  return {
    prompt: async (text, promptOptions) => await session.prompt(text, promptOptions),
    subscribe: (listener) =>
      session.subscribe((event) => listener(event as unknown as PiAgentEvent)),
    abort: async () => await session.abort(),
    dispose: () => session.dispose(),
    get model() {
      return session.model;
    },
    get thinkingLevel() {
      return session.thinkingLevel;
    },
  };
}
async function createProviderSdkSession(
  request: PiAgentRequest,
  dispatch: PiModelDispatch,
  settingsManager: SettingsManager,
  admission: ChildExtensionAdmission,
  signal: AbortSignal,
): Promise<PiAgentSession> {
  if (PiModelRuntime === undefined) throw new Error("Pi model runtime is unavailable");
  if (createAgentSessionRuntime === undefined || createAgentSessionServices === undefined) {
    throw new PiAgentGroupError(
      request.id,
      "cannot load provider extensions",
      "Pi child session runtime is unavailable",
    );
  }
  const agentDir = getAgentDir();
  let latestExtensions: LoadExtensionsResult | undefined;
  let providerRegistrationAttempted = false;
  const runtime = await createAgentSessionRuntime(
    async ({ cwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
      const modelRuntime = await PiModelRuntime.create({
        allowModelNetwork: false,
        modelsStore: await createLoadedModelStore(signal),
        modelsPath: path.join(runtimeAgentDir, "models.json"),
        authPath: path.join(runtimeAgentDir, "auth.json"),
      });
      try {
        const services = await createAgentSessionServices({
          cwd,
          agentDir: runtimeAgentDir,
          settingsManager,
          modelRuntime,
          resourceLoaderOptions: {
            additionalExtensionPaths: [...admission.extensionPaths],
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionsOverride: (result) => {
              assertLoadedProfile(request.id, result, admission.extensionPaths);
              assertProviderRegistrationOwners(
                request.id,
                result,
                dispatch.provider,
                admission.providerOwners,
              );
              guardPendingProviderRegistrations(result, () => {
                providerRegistrationAttempted = true;
              });
              return result;
            },
            systemPromptOverride: () => undefined,
            appendSystemPromptOverride: () => [],
          },
        });
        latestExtensions = services.resourceLoader.getExtensions();
        if (providerRegistrationAttempted) throw providerRegistrationOwnershipError(request.id);
        assertProviderRegistration(
          request.id,
          services.diagnostics,
          modelRuntime,
          dispatch.provider,
        );
        sealProviderRegistration(modelRuntime, () => {
          providerRegistrationAttempted = true;
        });
        const model = modelRuntime.getModel(dispatch.provider, dispatch.id);
        if (model === undefined) {
          throw new PiAgentGroupError(
            request.id,
            "has no model",
            `${dispatch.provider}/${dispatch.id}`,
          );
        }
        const sessionResult = await createAgentSession({
          cwd: services.cwd,
          agentDir: services.agentDir,
          modelRuntime: services.modelRuntime,
          settingsManager: services.settingsManager,
          resourceLoader: services.resourceLoader,
          sessionManager,
          ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
          tools: request.tools,
          model,
          ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
        });
        if (providerRegistrationAttempted) {
          sessionResult.session.dispose();
          throw providerRegistrationOwnershipError(request.id);
        }
        return {
          ...sessionResult,
          services,
          diagnostics: services.diagnostics,
        };
      } catch (error) {
        if (latestExtensions !== undefined) {
          try {
            await shutdownLoadedExtensions(latestExtensions, cwd);
          } catch {
            // Preserve the child setup error as the primary failure.
          } finally {
            latestExtensions.runtime.invalidate("Pi agent child session creation failed");
          }
        }
        throw error;
      }
    },
    {
      cwd: request.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(request.cwd),
      sessionStartEvent: { type: "session_start", reason: "startup" },
    },
  );
  let extensionFailure = false;
  let unsubscribeExtensionErrors: (() => void) | undefined;
  try {
    const session = runtime.session;
    const model = runtime.services.modelRuntime.getModel(dispatch.provider, dispatch.id);
    if (model === undefined) {
      throw new PiAgentGroupError(
        request.id,
        "has no model",
        `${dispatch.provider}/${dispatch.id}`,
      );
    }
    unsubscribeExtensionErrors = session.extensionRunner.onError(() => {
      extensionFailure = true;
    });
    await session.bindExtensions({ mode: "print" });
    if (providerRegistrationAttempted) throw providerRegistrationOwnershipError(request.id);
    if (extensionFailure) {
      throw new PiAgentGroupError(
        request.id,
        "could not register provider extension",
        "registration failed",
      );
    }
    assertExactSession(request, session, model);
    const auth = await runtime.services.modelRuntime.getAuth(model);
    if (auth === undefined) {
      throw new PiAgentGroupError(request.id, "has no provider authentication", model.provider);
    }
    const activeTools = session.getActiveToolNames().toSorted();
    const requestedTools = request.tools.toSorted();
    if (activeTools.join("\0") !== requestedTools.join("\0")) {
      throw new PiAgentGroupError(
        request.id,
        "has unexpected tools",
        activeTools.length === 0 ? "no tools are active" : activeTools.join(", "),
      );
    }
    const toolInfo = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
    for (const tool of requestedTools) {
      if (toolInfo.get(tool)?.sourceInfo.source !== "builtin") {
        throw new PiAgentGroupError(request.id, "has replaced built-in tool", tool);
      }
    }
    let disposed = false;
    return {
      prompt: async (text, promptOptions) => {
        await session.prompt(text, {
          ...promptOptions,
          preflightResult: (accepted) => {
            if (providerRegistrationAttempted) {
              promptOptions?.preflightResult?.(false);
              throw providerRegistrationOwnershipError(request.id);
            }
            promptOptions?.preflightResult?.(accepted);
          },
          expandPromptTemplates: false,
          source: "interactive",
        });
        if (providerRegistrationAttempted) throw providerRegistrationOwnershipError(request.id);
      },
      subscribe: (listener) =>
        session.subscribe((event) => listener(event as unknown as PiAgentEvent)),
      abort: async () => await session.abort(),
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        let disposalFailure: unknown;
        try {
          await runtime.dispose();
        } catch (error) {
          disposalFailure = error;
        } finally {
          unsubscribeExtensionErrors?.();
        }
        if (disposalFailure !== undefined) throw disposalFailure;
        if (extensionFailure) {
          throw new PiAgentGroupError(
            request.id,
            "could not settle child extensions",
            "cleanup failed",
          );
        }
      },
      get model() {
        return session.model;
      },
      get thinkingLevel() {
        return session.thinkingLevel;
      },
    };
  } catch (error) {
    await runtime.dispose().catch(() => undefined);
    unsubscribeExtensionErrors?.();
    throw error;
  }
}

function assertProviderRegistration(
  id: string,
  diagnostics: readonly { type: "info" | "warning" | "error"; message: string }[],
  modelRuntime: ModelRuntime,
  provider: string,
): void {
  if (diagnostics.some((diagnostic) => diagnostic.type === "error")) {
    throw new PiAgentGroupError(id, "could not register provider extension", "registration failed");
  }
  if (!modelRuntime.getRegisteredProviderIds().includes(provider)) {
    throw new PiAgentGroupError(id, "could not register provider extension", provider);
  }
}
function assertProviderRegistrationOwners(
  id: string,
  result: LoadExtensionsResult,
  provider: string,
  approvedOwners: readonly string[],
): void {
  const finalOwners = new Set<string>();
  for (const registration of result.runtime.pendingProviderRegistrations) {
    if (registration.name === provider) finalOwners.add(path.resolve(registration.extensionPath));
  }
  if (
    finalOwners.size !== approvedOwners.length ||
    [...finalOwners].some((owner) => !approvedOwners.includes(owner))
  ) {
    throw providerRegistrationOwnershipError(id);
  }
}
function guardPendingProviderRegistrations(
  result: LoadExtensionsResult,
  onAttempt: () => void,
): void {
  result.runtime.registerProvider = () => {
    onAttempt();
  };
  result.runtime.unregisterProvider = () => {
    onAttempt();
  };
}

function providerRegistrationOwnershipError(id: string): PiAgentGroupError {
  return new PiAgentGroupError(id, "could not register provider extension", "ownership changed");
}

function sealProviderRegistration(modelRuntime: ModelRuntime, onAttempt: () => void): void {
  const checkAuth = modelRuntime.checkAuth.bind(modelRuntime);
  const getAuth = modelRuntime.getAuth.bind(modelRuntime) as (
    ...args: unknown[]
  ) => ReturnType<ModelRuntime["getAuth"]>;
  const hasConfiguredAuth = modelRuntime.hasConfiguredAuth.bind(modelRuntime);
  let blocked = false;
  const block = () => {
    blocked = true;
    onAttempt();
  };
  modelRuntime.checkAuth = async (providerId) => {
    if (blocked) return undefined;
    const result = await checkAuth(providerId);
    return blocked ? undefined : result;
  };
  modelRuntime.getAuth = (async (...args: unknown[]) => {
    if (blocked) return undefined;
    const result = await getAuth(...args);
    return blocked ? undefined : result;
  }) as ModelRuntime["getAuth"];
  modelRuntime.hasConfiguredAuth = (providerId) => !blocked && hasConfiguredAuth(providerId);
  modelRuntime.registerProvider = (providerId: string) => {
    block();
    throw new Error(`cannot register provider after initial extension load: ${providerId}`);
  };
  modelRuntime.unregisterProvider = (providerId: string) => {
    block();
    throw new Error(`cannot unregister provider after initial extension load: ${providerId}`);
  };
}

function assertLoadedProfile(
  id: string,
  result: LoadExtensionsResult,
  extensionPaths: readonly string[],
): void {
  if (result.errors.length > 0) {
    throw new PiAgentGroupError(id, "could not load provider extension", "load failed");
  }
  const loaded = result.extensions
    .map((extension) => path.resolve(extension.resolvedPath))
    .toSorted();
  const expected = extensionPaths.map((extensionPath) => path.resolve(extensionPath)).toSorted();
  if (loaded.join("\0") !== expected.join("\0")) {
    throw new PiAgentGroupError(id, "loaded unexpected extensions", `${loaded.length} loaded`);
  }
  for (const extension of result.extensions) validateAdmittedExtension(extension, "extension");
}

function assertExactSession(
  request: PiAgentRequest,
  session: { model: { provider: string; id: string } | undefined },
  dispatch: PiModelDispatch,
): void {
  if (session.model?.provider !== dispatch.provider || session.model.id !== dispatch.id) {
    throw new PiAgentGroupError(
      request.id,
      "selected a different model dispatch",
      session.model === undefined
        ? "no model selected"
        : `${session.model.provider}/${session.model.id}`,
    );
  }
}

function resolveRequestedModel(
  request: PiAgentRequest,
  runtime: ModelRuntime,
  settings: SettingsManager,
  agentDir: string,
) {
  const selection = request.model ?? settingsModel(settings) ?? catalogModel(runtime, agentDir);
  if (selection === undefined) return undefined;
  const model = runtime.getModel(selection.provider, selection.id);
  if (model === undefined) {
    throw new PiAgentGroupError(
      request.id,
      "has no model",
      `${selection.provider}/${selection.id}`,
    );
  }
  return model;
}

function settingsModel(settings: SettingsManager): { provider: string; id: string } | undefined {
  const provider = settings.getDefaultProvider();
  const id = settings.getDefaultModel();
  if (provider === undefined || provider === "" || id === undefined || id === "") return undefined;
  return { provider, id };
}

function catalogModel(
  runtime: ModelRuntime,
  agentDir: string,
): { provider: string; id: string } | undefined {
  for (const provider of catalogProviderIds(agentDir)) {
    const model = runtime.getModels(provider)[0];
    if (model !== undefined) return { provider: model.provider, id: model.id };
  }
  return undefined;
}

function catalogProviderIds(agentDir: string): string[] {
  try {
    const source: unknown = JSON.parse(readFileSync(path.join(agentDir, "models.json"), "utf8"));
    if (source === null || typeof source !== "object" || Array.isArray(source)) return [];
    const providers = (source as { providers?: unknown }).providers;
    if (providers === null || typeof providers !== "object" || Array.isArray(providers)) {
      return [];
    }
    return Object.keys(providers);
  } catch {
    return [];
  }
}

function validateGroup(
  input: PiAgentRequest[],
  options: PiAgentGroupOptions,
): { requests: PiAgentRequest[]; maxFinalChars: number; behaviorExtensionPaths: string[] } {
  if (!Array.isArray(input) || input.length > MAX_AGENTS) {
    throw new Error(`Pi agent group must contain at most ${MAX_AGENTS} requests`);
  }
  positiveInteger(options.maxConcurrency, "Pi agent maxConcurrency", MAX_CONCURRENCY);
  const maxFinalChars = options.maxFinalChars ?? DEFAULT_FINAL_CHARS;
  positiveInteger(maxFinalChars, "Pi agent maxFinalChars", MAX_FINAL_CHARS);
  if (
    options.behaviorExtensionPaths !== undefined &&
    (!Array.isArray(options.behaviorExtensionPaths) || options.behaviorExtensionPaths.length > 16)
  ) {
    throw new Error("Pi agent behaviorExtensionPaths must contain at most 16 paths");
  }
  const behaviorPaths = new Set<string>();
  for (const extensionPath of options.behaviorExtensionPaths ?? []) {
    operationalText(extensionPath, "Pi agent behavior extension path", 4_000);
    if (behaviorPaths.has(extensionPath)) {
      throw new Error("Duplicate Pi agent behavior extension path");
    }
    behaviorPaths.add(extensionPath);
  }
  const ids = new Set<string>();
  const requests = input.map((request) => {
    validateRequest(request);
    if (ids.has(request.id)) throw new Error(`Duplicate Pi agent id: ${request.id}`);
    ids.add(request.id);
    return snapshotRequest(request);
  });
  Object.freeze(requests);
  const behaviorExtensionPaths = [...behaviorPaths];
  Object.freeze(behaviorExtensionPaths);
  return { requests, maxFinalChars, behaviorExtensionPaths };
}

function snapshotRequest(request: PiAgentRequest): PiAgentRequest {
  const tools = [...request.tools];
  Object.freeze(tools);
  const model = request.model === undefined ? undefined : Object.freeze({ ...request.model });
  return Object.freeze({
    id: request.id,
    role: request.role,
    prompt: request.prompt,
    cwd: request.cwd,
    tools,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(model === undefined ? {} : { model }),
    ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
  });
}

function validateRequest(request: PiAgentRequest): void {
  if (!REQUEST_ID.test(request.id)) throw new Error(`Invalid Pi agent id: ${request.id}`);
  operationalText(request.role, "Pi agent role", 200);
  nonEmpty(request.prompt, "Pi agent prompt", MAX_PROMPT_CHARS);
  if (request.prompt.trimStart().startsWith("/")) {
    throw new Error(`Pi agent ${request.id} prompt must not invoke an extension command`);
  }
  nonEmpty(request.cwd, "Pi agent cwd", 4_000);
  if (!Array.isArray(request.tools) || request.tools.length === 0) {
    throw new Error(`Pi agent ${request.id} requires at least one tool`);
  }
  const tools = new Set<PiAgentTool>();
  for (const tool of request.tools) {
    if (!["read", "grep", "find", "ls"].includes(tool)) {
      throw new Error(`Pi agent ${request.id} has unsupported tool: ${String(tool)}`);
    }
    if (tools.has(tool)) throw new Error(`Pi agent ${request.id} has duplicate tool: ${tool}`);
    tools.add(tool);
  }
  positiveInteger(
    request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    `Pi agent ${request.id} timeoutMs`,
    MAX_TIMEOUT_MS,
  );
  if (request.model !== undefined) {
    operationalText(request.model.provider, `Pi agent ${request.id} model provider`, 200);
    operationalText(request.model.id, `Pi agent ${request.id} model id`, 500);
  }
}

function eventPhase(event: PiAgentEvent, tools: PiAgentTool[]): string | undefined {
  if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
    return event.assistantMessageEvent.type === "thinking_delta" ? "thinking" : undefined;
  }
  if (event.type !== "tool_execution_start" || typeof event.toolName !== "string") return undefined;
  if (tools.includes(event.toolName as PiAgentTool)) return `tool: ${event.toolName}`;
  return event.toolName === "glob" && (tools.includes("find") || tools.includes("ls"))
    ? "tool: glob"
    : undefined;
}

function assistantMessage(event: PiAgentEvent): Record<string, unknown> | undefined {
  if (event.type !== "message_end" || !isRecord(event.message)) return undefined;
  return event.message.role === "assistant" ? event.message : undefined;
}

function finalAssistantText(
  id: string,
  message: Record<string, unknown> | undefined,
  maxChars: number,
): string {
  if (message === undefined)
    throw new PiAgentGroupError(id, "returned no final output", "missing assistant message");
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new PiAgentGroupError(
      id,
      `stopped with ${String(message.stopReason)}`,
      typeof message.errorMessage === "string" ? message.errorMessage : "provider stopped",
    );
  }
  const text = messageText(message.content).trim();
  if (!text) throw new PiAgentGroupError(id, "returned no final output", "assistant text is empty");
  if (text.length > maxChars) {
    throw new PiAgentGroupError(id, "final output is too large", `${text.length} characters`);
  }
  return text;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .filter(Boolean)
    .join("\n");
}

async function publishQueuedCancellations(
  requests: PiAgentRequest[],
  started: Set<number>,
  options: PiAgentGroupOptions,
): Promise<void> {
  if (options.onLifecycle === undefined) return;
  await Promise.all(
    requests.map(async (request, index) => {
      if (started.has(index)) return;
      await options.onLifecycle?.({
        id: request.id,
        role: request.role,
        state: "cancelled",
        phase: "cancelled",
        elapsedMs: 0,
      });
    }),
  ).catch(() => undefined);
}

function normalizeAgentError(
  id: string,
  error: unknown,
  abortKind: "timeout" | "cancelled" | undefined,
  signal: AbortSignal,
): unknown {
  if (error instanceof PiAgentGroupError) return error;
  if (abortKind === "timeout") return new PiAgentGroupError(id, "timed out", errorMessage(error));
  if (abortKind === "cancelled" || signal.aborted) return cancellationError(id, signal.reason);
  return new PiAgentGroupError(id, "failed", errorMessage(error));
}

function terminalState(error: unknown): PiAgentLifecycleState {
  if (error === undefined) return "completed";
  return error instanceof PiAgentGroupError && error.code === "cancelled" ? "cancelled" : "failed";
}

function cancellationError(id: string, reason: unknown): PiAgentGroupError {
  return new PiAgentGroupError(id, "cancelled", cancellationReason(reason));
}

function cancellationReason(reason: unknown): string {
  return reason === undefined ? "operation cancelled" : errorMessage(reason);
}

function abortSuffix(error: unknown): string {
  return error === undefined ? "" : `; abort failed: ${bounded(errorMessage(error))}`;
}

function modelName(model: { provider: string; id: string } | undefined): string {
  if (model === undefined) throw new Error("No usable Pi model is configured");
  const value = `${model.provider}/${model.id}`;
  operationalText(value, "Pi model identity", 700);
  return value;
}

function positiveInteger(value: unknown, label: string, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error(`${label} must be an integer from 1 through ${max}`);
  }
}

function operationalText(value: unknown, label: string, max: number): asserts value is string {
  nonEmpty(value, label, max);
  if (
    [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || (code >= 127 && code <= 159);
    })
  ) {
    throw new Error(`${label} must not contain control characters`);
  }
}

function nonEmpty(value: unknown, label: string, max: number): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new Error(`${label} must be a non-empty string with at most ${max} characters`);
  }
}

function bounded(value: string): string {
  return redactSensitiveText(value.trim() || "unknown failure", MAX_ERROR_CHARS).replace(
    /\b([a-z][a-z\d+.-]*:\/\/)([^/\s@]+)@/giu,
    "$1[redacted]@",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
