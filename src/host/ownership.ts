import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import { openSqliteDatabase, type SqliteDatabase } from "../controllers/sqlite-database.js";
import { projectControllerStorePath } from "../controllers/store.js";
import { OMP_WORKFLOWS_VERSION } from "./version.js";

export const HOST_LEASE_SCHEMA = "omp-workflows.host-lease.v1" as const;
export const HOST_HEALTH_SCHEMA = "omp-workflows.host-health.v1" as const;
export const DEFAULT_HOST_HEARTBEAT_MS = 5_000;
export const DEFAULT_HOST_STALE_MS = 20_000;

const MAX_STATE_BYTES = 16 * 1024;
const MAX_PENDING_IDS = 32;
const MAX_ERROR_SUMMARIES = 8;
const MAX_ERROR_CHARS = 160;
const noExtraProperties = { additionalProperties: false } as const;
const ownerIdentityFields = {
  pid: Type.Integer({ minimum: 1 }),
  processStartId: Type.String({ minLength: 1, maxLength: 200 }),
  bootId: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  nonce: Type.String({ minLength: 1, maxLength: 200 }),
};
const HostLeaseStateSchema = Type.Object(
  {
    schema: Type.Literal(HOST_LEASE_SCHEMA),
    packageVersion: Type.String({ minLength: 1, maxLength: 100 }),
    projectDigest: Type.String({ minLength: 64, maxLength: 64 }),
    canonicalProject: Type.String({ minLength: 1, maxLength: 4_096 }),
    ...ownerIdentityFields,
    acquiredAt: Type.String({ minLength: 1, maxLength: 64 }),
    heartbeatAt: Type.String({ minLength: 1, maxLength: 64 }),
  },
  noExtraProperties,
);
const HostCountsSchema = Type.Object(
  {
    active: Type.Integer({ minimum: 0 }),
    waiting: Type.Integer({ minimum: 0 }),
    parked: Type.Integer({ minimum: 0 }),
    failed: Type.Integer({ minimum: 0 }),
    controllers: Type.Integer({ minimum: 0 }),
  },
  noExtraProperties,
);
const HostErrorSchema = Type.Object(
  {
    class: Type.String({ maxLength: MAX_ERROR_CHARS }),
    summary: Type.String({ maxLength: MAX_ERROR_CHARS }),
  },
  noExtraProperties,
);
const HostHealthStateSchema = Type.Object(
  {
    schema: Type.Literal(HOST_HEALTH_SCHEMA),
    packageVersion: Type.String({ minLength: 1, maxLength: 100 }),
    projectDigest: Type.String({ minLength: 64, maxLength: 64 }),
    ...ownerIdentityFields,
    lifecycle: Type.Union([
      Type.Literal("starting"),
      Type.Literal("running"),
      Type.Literal("stopping"),
    ]),
    acquiredAt: Type.String({ minLength: 1, maxLength: 64 }),
    heartbeatAt: Type.String({ minLength: 1, maxLength: 64 }),
    counts: HostCountsSchema,
    pendingDecisionCount: Type.Integer({ minimum: 0 }),
    pendingDecisionIds: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      maxItems: MAX_PENDING_IDS,
    }),
    errors: Type.Array(HostErrorSchema, { maxItems: MAX_ERROR_SUMMARIES }),
  },
  noExtraProperties,
);

export type HostLifecycleState = "starting" | "running" | "stopping";
export type HostStatusClassification = "healthy" | "stale" | "stopped" | "inconsistent";

type HostOwnerIdentity = {
  pid: number;
  processStartId: string;
  bootId: string | null;
  nonce: string;
};

export type HostLease = HostOwnerIdentity & {
  schema: typeof HOST_LEASE_SCHEMA;
  packageVersion: string;
  projectDigest: string;
  canonicalProject: string;
  acquiredAt: string;
  heartbeatAt: string;
};

export type HostHealthCounts = {
  active: number;
  waiting: number;
  parked: number;
  failed: number;
  controllers: number;
};

export type HostHealthError = {
  class: string;
  summary: string;
};

export type HostHealthSnapshot = HostOwnerIdentity & {
  schema: typeof HOST_HEALTH_SCHEMA;
  packageVersion: string;
  projectDigest: string;
  lifecycle: HostLifecycleState;
  acquiredAt: string;
  heartbeatAt: string;
  counts: HostHealthCounts;
  pendingDecisionCount: number;
  pendingDecisionIds: string[];
  errors: HostHealthError[];
};

export type HostHealthInput = {
  lifecycle: HostLifecycleState;
  counts: HostHealthCounts;
  pendingDecisionCount?: number;
  pendingDecisionIds?: string[];
  errors?: HostHealthError[];
};

export type HostStatus = {
  schema: "omp-workflows.host-status.v1";
  classification: HostStatusClassification;
  packageVersion: string;
  projectDigest: string;
  owner: Pick<HostOwnerIdentity, "pid" | "processStartId" | "bootId"> | null;
  acquiredAt: string | null;
  heartbeatAt: string | null;
  lifecycle: HostLifecycleState | null;
  counts: HostHealthCounts;
  pendingDecisionCount: number;
  pendingDecisionIds: string[];
  errors: HostHealthError[];
  lingeringEnabled: boolean;
  detail: string;
};

export type ProcessObservation = {
  alive: boolean;
  processStartId: string | null;
  bootId: string | null;
};

type OwnershipOptions = {
  stateDir?: string;
  packageVersion?: string;
  pid?: number;
  nonce?: string;
  now?: () => number;
  staleAfterMs?: number;
  observeProcess?: (pid: number) => ProcessObservation;
};

type LeaseClassification = "live" | "stale" | "inconsistent";

export class HostOwnershipLostError extends Error {
  constructor() {
    super("Workflow host ownership was lost");
    this.name = "HostOwnershipLostError";
  }
}

export class HostOwnership {
  readonly canonicalProject: string;
  readonly projectDigest: string;
  readonly stateDir: string;
  readonly leasePath: string;
  readonly healthPath: string;

  private readonly packageVersion: string;
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private readonly observeProcess: (pid: number) => ProcessObservation;
  private readonly pid: number;
  private readonly nonce: string;
  private lease: HostLease | null = null;
  private lockDatabase: SqliteDatabase | null = null;

  constructor(project: string, options: OwnershipOptions = {}) {
    this.canonicalProject = canonicalProjectPath(project);
    this.projectDigest = projectDigest(this.canonicalProject);
    this.stateDir =
      options.stateDir ?? path.dirname(projectControllerStorePath(this.canonicalProject));
    this.leasePath = path.join(this.stateDir, "host.lease.json");
    this.healthPath = path.join(this.stateDir, "host.health.json");
    this.packageVersion = options.packageVersion ?? OMP_WORKFLOWS_VERSION;
    this.now = options.now ?? Date.now;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_HOST_STALE_MS;
    this.observeProcess = options.observeProcess ?? observeProcess;
    this.pid = options.pid ?? process.pid;
    this.nonce = options.nonce ?? randomUUID();
  }

  acquire(): HostLease {
    ensurePrivateDirectory(this.stateDir);
    this.acquireProcessLock();
    try {
      return this.acquireLease();
    } catch (error) {
      this.releaseProcessLock();
      throw error;
    }
  }

  private acquireLease(): HostLease {
    const owner = this.currentOwnerIdentity();
    const timestamp = new Date(this.now()).toISOString();
    const lease: HostLease = {
      schema: HOST_LEASE_SCHEMA,
      packageVersion: this.packageVersion,
      projectDigest: this.projectDigest,
      canonicalProject: this.canonicalProject,
      ...owner,
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
    };

    const orphanHealth = readBoundedJson(this.healthPath);
    if (!fs.existsSync(this.leasePath) && orphanHealth !== null) {
      const status = readHostStatus(this.canonicalProject, {
        stateDir: this.stateDir,
        packageVersion: this.packageVersion,
        now: this.now,
        staleAfterMs: this.staleAfterMs,
        observeProcess: this.observeProcess,
      });
      if (status.classification !== "stale") {
        throw new Error(`Workflow host ownership is inconsistent: ${status.detail}`);
      }
    }

    try {
      writeExclusiveJson(this.leasePath, lease);
      this.lease = lease;
      return lease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = parseLease(readBoundedJson(this.leasePath));
    if (existing === null || existing.projectDigest !== this.projectDigest) {
      throw new Error("Workflow host ownership is inconsistent; refusing automatic recovery");
    }
    const classification = classifyLease(
      existing,
      this.observeProcess(existing.pid),
      this.now(),
      this.staleAfterMs,
    );
    if (classification === "live") {
      throw new Error(
        `Another workflow host (pid ${existing.pid}) is already running for ${this.canonicalProject}`,
      );
    }
    if (classification !== "stale") {
      throw new Error("Workflow host ownership is inconsistent; refusing automatic recovery");
    }

    const current = parseLease(readBoundedJson(this.leasePath));
    if (
      current === null ||
      current.nonce !== existing.nonce ||
      classifyLease(current, this.observeProcess(current.pid), this.now(), this.staleAfterMs) !==
        "stale"
    ) {
      throw new Error("Workflow host ownership changed during stale recovery");
    }
    atomicWriteJson(this.leasePath, lease);
    this.lease = lease;
    return lease;
  }

  refresh(input: HostHealthInput): void {
    const lease = this.requireLease();
    const current = parseLease(readBoundedJson(this.leasePath));
    if (current?.nonce !== lease.nonce) {
      throw new HostOwnershipLostError();
    }
    const heartbeatAt = new Date(this.now()).toISOString();
    const nextLease = { ...lease, heartbeatAt };
    atomicWriteJson(this.leasePath, nextLease);
    this.lease = nextLease;

    const pendingDecisionIds = [...new Set(input.pendingDecisionIds ?? [])]
      .filter((value) => typeof value === "string" && value.length > 0)
      .slice(0, MAX_PENDING_IDS);
    const errors = (input.errors ?? []).slice(0, MAX_ERROR_SUMMARIES).map((error) => ({
      class: boundedText(error.class),
      summary: boundedText(error.summary),
    }));
    const snapshot: HostHealthSnapshot = {
      schema: HOST_HEALTH_SCHEMA,
      packageVersion: this.packageVersion,
      projectDigest: this.projectDigest,
      pid: nextLease.pid,
      processStartId: nextLease.processStartId,
      bootId: nextLease.bootId,
      nonce: nextLease.nonce,
      lifecycle: input.lifecycle,
      acquiredAt: nextLease.acquiredAt,
      heartbeatAt,
      counts: normalizeCounts(input.counts),
      pendingDecisionCount: boundedCount(input.pendingDecisionCount ?? pendingDecisionIds.length),
      pendingDecisionIds,
      errors,
    };
    atomicWriteJson(this.healthPath, snapshot);
  }

  release(): void {
    const ownedNonce = this.lease?.nonce;
    this.lease = null;
    try {
      if (ownedNonce === undefined) return;
      const current = parseLease(readBoundedJson(this.leasePath));
      if (current?.nonce !== ownedNonce) return;
      const health = parseHealth(readBoundedJson(this.healthPath));
      if (health?.nonce === ownedNonce) removeFile(this.healthPath);
      const finalCheck = parseLease(readBoundedJson(this.leasePath));
      if (finalCheck?.nonce === ownedNonce) removeFile(this.leasePath);
    } finally {
      this.releaseProcessLock();
    }
  }

  private acquireProcessLock(): void {
    if (this.lockDatabase !== null) {
      throw new Error("Workflow host process lock is already held");
    }
    const database = openSqliteDatabase(path.join(this.stateDir, "host.owner.sqlite"));
    try {
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      database.close();
      throw new Error(
        `Another workflow host is already running or acquiring ownership; process lock failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    this.lockDatabase = database;
  }

  private releaseProcessLock(): void {
    const database = this.lockDatabase;
    this.lockDatabase = null;
    if (database === null) return;
    try {
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  }

  private currentOwnerIdentity(): HostOwnerIdentity {
    const observed = this.observeProcess(this.pid);
    if (!observed.alive || observed.processStartId === null) {
      throw new Error("Cannot establish workflow host process identity");
    }
    return {
      pid: this.pid,
      processStartId: observed.processStartId,
      bootId: observed.bootId,
      nonce: this.nonce,
    };
  }

  private requireLease(): HostLease {
    if (this.lease === null) throw new Error("Workflow host ownership has not been acquired");
    return this.lease;
  }
}

export function canonicalProjectPath(project: string): string {
  const resolved = fs.realpathSync.native(path.resolve(project));
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Workflow host project is not a directory: ${resolved}`);
  }
  return resolved;
}

export function projectDigest(canonicalProject: string): string {
  return createHash("sha256").update(canonicalProject).digest("hex");
}

export function hostStateDirectory(project: string): string {
  const canonical = canonicalProjectPath(project);
  return path.dirname(projectControllerStorePath(canonical));
}

export function readHostStatus(
  project: string,
  options: Omit<OwnershipOptions, "pid" | "nonce"> = {},
): HostStatus {
  const canonicalProject = canonicalProjectPath(project);
  const digest = projectDigest(canonicalProject);
  const stateDir = options.stateDir ?? path.dirname(projectControllerStorePath(canonicalProject));
  const packageVersion = options.packageVersion ?? OMP_WORKFLOWS_VERSION;
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_HOST_STALE_MS;
  const processObserver = options.observeProcess ?? observeProcess;
  const leaseValue = readBoundedJson(path.join(stateDir, "host.lease.json"));
  const healthValue = readBoundedJson(path.join(stateDir, "host.health.json"));
  const empty = emptyStatus(packageVersion, digest);

  if (leaseValue === null && healthValue === null) {
    return {
      ...empty,
      lingeringEnabled: userLingeringEnabled(),
      detail: "No host owner is recorded.",
    };
  }
  const lease = leaseValue === null ? null : parseLease(leaseValue);
  const health = healthValue === null ? null : parseHealth(healthValue);
  if ((leaseValue !== null && lease === null) || (healthValue !== null && health === null)) {
    return inconsistentStatus(empty, "Transient host state is malformed.");
  }
  if (lease !== null && lease.projectDigest !== digest) {
    return inconsistentStatus(empty, "The host lease belongs to a different canonical project.");
  }
  if (health !== null && health.projectDigest !== digest) {
    return inconsistentStatus(empty, "The host health snapshot belongs to a different project.");
  }
  if (lease !== null && health !== null && !sameOwner(lease, health)) {
    return inconsistentStatus(empty, "The host lease and health snapshot have different owners.");
  }

  if (lease === null) {
    if (health === null) return empty;
    const expired = now() - Date.parse(health.heartbeatAt) > staleAfterMs;
    if (!expired) {
      return inconsistentStatus(empty, "A fresh health snapshot exists without an owner lease.");
    }
    return statusFromState(
      "stale",
      null,
      health,
      packageVersion,
      digest,
      "The owner lease is absent and health is stale.",
    );
  }

  const classification = classifyLease(lease, processObserver(lease.pid), now(), staleAfterMs);
  if (classification === "inconsistent") {
    return inconsistentStatus(empty, "Owner liveness and the recorded identity do not agree.");
  }
  if (classification === "stale") {
    return statusFromState(
      "stale",
      lease,
      health,
      packageVersion,
      digest,
      "The recorded owner is provably stale.",
    );
  }
  if (health === null) {
    return inconsistentStatus(empty, "A live owner has no health snapshot.");
  }
  const healthFresh = now() - Date.parse(health.heartbeatAt) <= staleAfterMs;
  if (!healthFresh) {
    return inconsistentStatus(empty, "The live owner has an expired health snapshot.");
  }
  return statusFromState(
    "healthy",
    lease,
    health,
    packageVersion,
    digest,
    "The host owner and health snapshot are current.",
  );
}

export function classifyLease(
  lease: HostLease,
  observation: ProcessObservation,
  nowMs: number,
  staleAfterMs: number = DEFAULT_HOST_STALE_MS,
): LeaseClassification {
  const heartbeatMs = Date.parse(lease.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return "inconsistent";
  const fresh = nowMs - heartbeatMs <= staleAfterMs;
  const sameStart = observation.processStartId === lease.processStartId;
  const sameBoot = observation.bootId === lease.bootId;

  if (observation.alive && sameStart && sameBoot) {
    return fresh ? "live" : "inconsistent";
  }
  if (fresh) return "inconsistent";
  if (!observation.alive && sameBoot) return "stale";
  if (observation.alive && observation.processStartId !== null && !sameStart && sameBoot) {
    return "stale";
  }
  if (!sameBoot) return "stale";
  return "inconsistent";
}

export function observeProcess(pid: number): ProcessObservation {
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    alive = (error as NodeJS.ErrnoException).code === "EPERM";
  }
  return {
    alive,
    processStartId: alive ? readProcessStartId(pid) : null,
    bootId: readBootId(),
  };
}

function readProcessStartId(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const afterCommand = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      return afterCommand[19] ?? null;
    } catch {
      return null;
    }
  }
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return started.length > 0 ? started : null;
  } catch {
    return null;
  }
}

function readBootId(): string | null {
  if (process.platform !== "linux") return null;
  try {
    const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function parseLease(value: unknown): HostLease | null {
  try {
    return Parse(HostLeaseStateSchema, value) as HostLease;
  } catch {
    return null;
  }
}

function parseHealth(value: unknown): HostHealthSnapshot | null {
  try {
    return Parse(HostHealthStateSchema, value) as HostHealthSnapshot;
  } catch {
    return null;
  }
}

function sameOwner(lease: HostLease, health: HostHealthSnapshot): boolean {
  return (
    lease.nonce === health.nonce &&
    lease.pid === health.pid &&
    lease.processStartId === health.processStartId &&
    lease.bootId === health.bootId &&
    lease.acquiredAt === health.acquiredAt
  );
}

function emptyStatus(packageVersion: string, digest: string): HostStatus {
  return {
    schema: "omp-workflows.host-status.v1",
    classification: "stopped",
    packageVersion,
    projectDigest: digest,
    owner: null,
    acquiredAt: null,
    heartbeatAt: null,
    lifecycle: null,
    counts: { active: 0, waiting: 0, parked: 0, failed: 0, controllers: 0 },
    pendingDecisionCount: 0,
    pendingDecisionIds: [],
    errors: [],
    lingeringEnabled: userLingeringEnabled(),
    detail: "No host owner is recorded.",
  };
}

function inconsistentStatus(empty: HostStatus, detail: string): HostStatus {
  return { ...empty, classification: "inconsistent", detail };
}

function statusFromState(
  classification: HostStatusClassification,
  lease: HostLease | null,
  health: HostHealthSnapshot | null,
  packageVersion: string,
  digest: string,
  detail: string,
): HostStatus {
  const owner = lease ?? health;
  return {
    schema: "omp-workflows.host-status.v1",
    classification,
    packageVersion: health?.packageVersion ?? lease?.packageVersion ?? packageVersion,
    projectDigest: digest,
    owner:
      owner === null
        ? null
        : {
            pid: owner.pid,
            processStartId: owner.processStartId,
            bootId: owner.bootId,
          },
    acquiredAt: owner?.acquiredAt ?? null,
    heartbeatAt: health?.heartbeatAt ?? lease?.heartbeatAt ?? null,
    lifecycle: health?.lifecycle ?? null,
    counts: health?.counts ?? {
      active: 0,
      waiting: 0,
      parked: 0,
      failed: 0,
      controllers: 0,
    },
    pendingDecisionCount: health?.pendingDecisionCount ?? 0,
    pendingDecisionIds: health?.pendingDecisionIds ?? [],
    errors: health?.errors ?? [],
    lingeringEnabled: userLingeringEnabled(),
    detail,
  };
}

function normalizeCounts(counts: HostHealthCounts): HostHealthCounts {
  return {
    active: boundedCount(counts.active),
    waiting: boundedCount(counts.waiting),
    parked: boundedCount(counts.parked),
    failed: boundedCount(counts.failed),
    controllers: boundedCount(counts.controllers),
  };
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

function boundedText(value: string): string {
  return String(value)
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, MAX_ERROR_CHARS);
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writeExclusiveJson(filePath: string, value: unknown): void {
  const payload = jsonPayload(value);
  const handle = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(handle, payload, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  ensurePrivateDirectory(path.dirname(filePath));
  const payload = jsonPayload(value);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(handle, payload, "utf8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    removeFile(temporary);
    throw error;
  }
}

function jsonPayload(value: unknown): string {
  const payload = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(payload) > MAX_STATE_BYTES) {
    throw new Error(`Host state exceeds ${MAX_STATE_BYTES} bytes`);
  }
  return payload;
}

function readBoundedJson(filePath: string): unknown | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return Symbol.for("invalid-host-state");
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return Symbol.for("invalid-host-state");
  }
}

function removeFile(filePath: string): void {
  try {
    fs.rmSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function userLingeringEnabled(): boolean {
  return fs.existsSync(path.join("/var/lib/systemd/linger", os.userInfo().username));
}
