import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyLease,
  HostOwnership,
  readHostStatus,
  type HostLease,
  type HostHealthSnapshot,
  type ProcessObservation,
} from "../src/host/ownership.js";
import {
  hostService,
  installHostService,
  restartHostService,
  startHostService,
  stopHostService,
  uninstallHostService,
} from "../src/host/service.js";
import { OMP_WORKFLOWS_VERSION } from "../src/host/version.js";
import { makeTempDir } from "./helpers.js";

const observedOwner: ProcessObservation = {
  alive: true,
  processStartId: "owner-start",
  bootId: "boot-a",
};

function lease(overrides: Partial<HostLease> = {}): HostLease {
  return {
    schema: "omp-workflows.host-lease.v1",
    packageVersion: OMP_WORKFLOWS_VERSION,
    projectDigest: "a".repeat(64),
    canonicalProject: "/tmp/project",
    pid: 123,
    processStartId: "owner-start",
    bootId: "boot-a",
    nonce: "nonce-a",
    acquiredAt: "2026-08-22T00:00:00.000Z",
    heartbeatAt: "2026-08-22T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("production host ownership", () => {
  it("classifies process identity conservatively across reuse, reboot, and ambiguity", () => {
    const now = Date.parse("2026-08-22T00:01:00.000Z");
    expect(classifyLease(lease(), observedOwner, now, 120_000)).toBe("live");
    expect(classifyLease(lease(), { ...observedOwner, alive: false }, now, 20_000)).toBe("stale");
    expect(
      classifyLease(lease(), { ...observedOwner, processStartId: "reused" }, now, 20_000),
    ).toBe("stale");
    expect(classifyLease(lease(), { ...observedOwner, bootId: "boot-b" }, now, 20_000)).toBe(
      "stale",
    );
    expect(classifyLease(lease(), { ...observedOwner, processStartId: null }, now, 20_000)).toBe(
      "inconsistent",
    );
    expect(classifyLease(lease({ heartbeatAt: "not-a-time" }), observedOwner, now, 20_000)).toBe(
      "inconsistent",
    );
    expect(classifyLease(lease(), observedOwner, now)).toBe("inconsistent");
    expect(
      classifyLease(
        lease(),
        { ...observedOwner, alive: false },
        Date.parse("2026-08-22T00:00:10.000Z"),
        20_000,
      ),
    ).toBe("inconsistent");
  });

  it("writes private bounded state, rejects duplicates, and releases cleanly", async () => {
    const project = await makeTempDir("omp-host-owner-project");
    const stateDir = await makeTempDir("omp-host-owner-state");
    let now = Date.parse("2026-08-22T00:00:00.000Z");
    const observe = () => observedOwner;
    const owner = new HostOwnership(project, {
      stateDir,
      now: () => now,
      nonce: "owner-nonce",
      observeProcess: observe,
    });
    owner.acquire();
    now += 1_000;
    owner.refresh({
      lifecycle: "running",
      counts: { active: 1, waiting: 2, parked: 3, failed: 4, controllers: 5 },
      pendingDecisionCount: 100,
      pendingDecisionIds: Array.from({ length: 80 }, (_, index) => `decision-${index}`),
      errors: Array.from({ length: 20 }, (_, index) => ({
        class: `Error-${index}`,
        summary: `line\n${"x".repeat(500)}`,
      })),
    });

    expect(
      readHostStatus(project, { stateDir, now: () => now, observeProcess: observe }),
    ).toMatchObject({
      classification: "healthy",
      packageVersion: OMP_WORKFLOWS_VERSION,
      lifecycle: "running",
      pendingDecisionCount: 100,
      counts: { active: 1, waiting: 2, parked: 3, failed: 4, controllers: 5 },
    });
    const health = JSON.parse(await fsp.readFile(owner.healthPath, "utf8")) as {
      pendingDecisionIds: string[];
      errors: Array<{ summary: string }>;
    };
    expect(health.pendingDecisionIds).toHaveLength(32);
    expect(health.errors).toHaveLength(8);
    expect(health.errors[0]?.summary).not.toContain("\n");
    expect((await fsp.stat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await fsp.stat(owner.leasePath)).mode & 0o777).toBe(0o600);
    expect((await fsp.stat(owner.healthPath)).mode & 0o777).toBe(0o600);
    expect((await fsp.stat(owner.healthPath)).size).toBeLessThanOrEqual(16 * 1024);
    now += 1_000;
    owner.refresh({
      lifecycle: "running",
      counts: {
        active: -1,
        waiting: Number.NaN,
        parked: Number.POSITIVE_INFINITY,
        failed: 1.9,
        controllers: 0,
      },
    });
    expect(
      readHostStatus(project, { stateDir, now: () => now, observeProcess: observe }).counts,
    ).toEqual({ active: 0, waiting: 0, parked: 0, failed: 1, controllers: 0 });

    const duplicate = new HostOwnership(project, {
      stateDir,
      nonce: "duplicate-nonce",
      observeProcess: observe,
    });
    expect(() => duplicate.acquire()).toThrow(/already running|process lock failed/);

    owner.release();
    expect(readHostStatus(project, { stateDir, observeProcess: observe }).classification).toBe(
      "stopped",
    );
    await expect(fsp.stat(owner.leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.stat(owner.healthPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes temporary state when an atomic sync fails", async () => {
    const project = await makeTempDir("omp-host-atomic-project");
    const stateDir = await makeTempDir("omp-host-atomic-state");
    const owner = new HostOwnership(project, {
      stateDir,
      nonce: "atomic-owner",
      observeProcess: () => observedOwner,
    });
    owner.acquire();
    const fsync = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw new Error("forced sync failure");
    });

    expect(() =>
      owner.refresh({
        lifecycle: "running",
        counts: { active: 0, waiting: 0, parked: 0, failed: 0, controllers: 0 },
      }),
    ).toThrow(/forced sync failure/);
    fsync.mockRestore();
    expect((await fsp.readdir(stateDir)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    owner.release();
  });
  it("reclaims only an expired provably stale nonce and fences the old owner", async () => {
    const project = await makeTempDir("omp-host-reclaim-project");
    const stateDir = await makeTempDir("omp-host-reclaim-state");
    let now = Date.parse("2026-08-22T00:00:00.000Z");
    const first = new HostOwnership(project, {
      stateDir,
      pid: 111,
      nonce: "stale-nonce",
      now: () => now,
      observeProcess: (pid) =>
        pid === 111
          ? { alive: true, processStartId: "stale-start", bootId: "boot-a" }
          : observedOwner,
    });
    first.acquire();
    first.refresh({
      lifecycle: "running",
      counts: { active: 0, waiting: 0, parked: 0, failed: 0, controllers: 0 },
    });
    const staleLease = JSON.parse(await fsp.readFile(first.leasePath, "utf8")) as HostLease;
    const staleHealth = JSON.parse(await fsp.readFile(first.healthPath, "utf8")) as Record<
      string,
      unknown
    >;
    first.release();
    now += 60_000;
    await fsp.writeFile(first.leasePath, `${JSON.stringify(staleLease)}\n`, { mode: 0o600 });
    await fsp.writeFile(first.healthPath, `${JSON.stringify(staleHealth)}\n`, { mode: 0o600 });

    const second = new HostOwnership(project, {
      stateDir,
      pid: 222,
      nonce: "winner-nonce",
      now: () => now,
      staleAfterMs: 20_000,
      observeProcess: (pid) =>
        pid === 111
          ? { alive: false, processStartId: null, bootId: "boot-a" }
          : { alive: true, processStartId: "winner-start", bootId: "boot-a" },
    });
    expect(second.acquire().nonce).toBe("winner-nonce");
    second.refresh({
      lifecycle: "running",
      counts: { active: 0, waiting: 0, parked: 0, failed: 0, controllers: 0 },
    });
    expect(() =>
      first.refresh({
        lifecycle: "running",
        counts: { active: 0, waiting: 0, parked: 0, failed: 0, controllers: 0 },
      }),
    ).toThrow(/ownership was lost|has not been acquired/);
    second.release();
  });

  it("rejects unverifiable process identities and permits unopened release", async () => {
    const project = await makeTempDir("omp-host-identity-project");
    const stateDir = await makeTempDir("omp-host-identity-state");
    const unopened = new HostOwnership(project, {
      stateDir,
      observeProcess: () => observedOwner,
    });
    expect(() => unopened.release()).not.toThrow();

    const dead = new HostOwnership(project, {
      stateDir,
      nonce: "dead-owner",
      observeProcess: () => ({ ...observedOwner, alive: false }),
    });
    expect(() => dead.acquire()).toThrow(/Cannot establish workflow host process identity/);

    const ambiguous = new HostOwnership(project, {
      stateDir,
      nonce: "ambiguous-owner",
      observeProcess: () => ({ ...observedOwner, processStartId: null }),
    });
    expect(() => ambiguous.acquire()).toThrow(/Cannot establish workflow host process identity/);
    await fsp.rm(stateDir, { recursive: true, force: true });
  });
  it("reports malformed transient state as inconsistent without deleting it", async () => {
    const project = await makeTempDir("omp-host-malformed-project");
    const stateDir = await makeTempDir("omp-host-malformed-state");
    const file = path.join(stateDir, "host.lease.json");
    await fsp.writeFile(file, "{truncated", { mode: 0o600 });
    expect(readHostStatus(project, { stateDir }).classification).toBe("inconsistent");
    await expect(fsp.readFile(file, "utf8")).resolves.toBe("{truncated");
  });
  it("refuses fresh orphan health without deleting recovery evidence", async () => {
    const project = await makeTempDir("omp-host-orphan-project");
    const stateDir = await makeTempDir("omp-host-orphan-state");
    const now = Date.parse("2026-08-22T00:00:00.000Z");
    const owner = new HostOwnership(project, {
      stateDir,
      now: () => now,
      nonce: "orphan-owner",
      observeProcess: () => observedOwner,
    });
    owner.acquire();
    owner.refresh({
      lifecycle: "running",
      counts: { active: 0, waiting: 1, parked: 0, failed: 0, controllers: 1 },
    });
    const health = await fsp.readFile(owner.healthPath, "utf8");
    owner.release();
    await fsp.writeFile(owner.healthPath, health, { mode: 0o600 });

    expect(
      readHostStatus(project, { stateDir, now: () => now, observeProcess: () => observedOwner }),
    ).toMatchObject({
      classification: "inconsistent",
      detail: "A fresh health snapshot exists without an owner lease.",
    });
    const contender = new HostOwnership(project, {
      stateDir,
      now: () => now,
      nonce: "contender",
      observeProcess: () => observedOwner,
    });
    expect(() => contender.acquire()).toThrow(
      /fresh health snapshot exists without an owner lease/,
    );
    await expect(fsp.readFile(owner.healthPath, "utf8")).resolves.toBe(health);
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("preserves successor state after ownership is fenced", async () => {
    const project = await makeTempDir("omp-host-fenced-project");
    const stateDir = await makeTempDir("omp-host-fenced-state");
    const owner = new HostOwnership(project, {
      stateDir,
      nonce: "fenced-owner",
      observeProcess: () => observedOwner,
    });
    owner.acquire();
    owner.refresh({
      lifecycle: "running",
      counts: { active: 1, waiting: 0, parked: 0, failed: 0, controllers: 1 },
    });
    const replacement = {
      ...(JSON.parse(await fsp.readFile(owner.leasePath, "utf8")) as HostLease),
      nonce: "successor-owner",
    };
    await fsp.writeFile(owner.leasePath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });

    expect(() =>
      owner.refresh({
        lifecycle: "running",
        counts: { active: 0, waiting: 0, parked: 0, failed: 0, controllers: 0 },
      }),
    ).toThrow(/ownership was lost/);
    owner.release();
    await expect(fsp.readFile(owner.leasePath, "utf8")).resolves.toContain("successor-owner");
    await fsp.rm(stateDir, { recursive: true, force: true });
  });
  it("classifies contradictory and partial durable host state", async () => {
    const project = await makeTempDir("omp-host-status-project");
    const stateDir = await makeTempDir("omp-host-status-state");
    const baseNow = Date.parse("2026-08-22T00:00:00.000Z");
    let now = baseNow;
    const owner = new HostOwnership(project, {
      stateDir,
      now: () => now,
      nonce: "status-owner",
      observeProcess: () => observedOwner,
    });
    owner.acquire();
    owner.refresh({
      lifecycle: "running",
      counts: { active: 1, waiting: 2, parked: 3, failed: 4, controllers: 5 },
      pendingDecisionIds: ["decision-a"],
    });
    const recordedLease = JSON.parse(await fsp.readFile(owner.leasePath, "utf8")) as HostLease;
    const recordedHealth = JSON.parse(
      await fsp.readFile(owner.healthPath, "utf8"),
    ) as HostHealthSnapshot;
    owner.release();

    const writeState = async (
      leaseState: HostLease | null,
      healthState: HostHealthSnapshot | null,
    ): Promise<void> => {
      await Promise.all([
        fsp.rm(owner.leasePath, { force: true }),
        fsp.rm(owner.healthPath, { force: true }),
      ]);
      if (leaseState !== null) {
        await fsp.writeFile(owner.leasePath, `${JSON.stringify(leaseState)}\n`, { mode: 0o600 });
      }
      if (healthState !== null) {
        await fsp.writeFile(owner.healthPath, `${JSON.stringify(healthState)}\n`, { mode: 0o600 });
      }
    };
    const status = (observation: ProcessObservation = observedOwner) =>
      readHostStatus(project, {
        stateDir,
        now: () => now,
        staleAfterMs: 20_000,
        observeProcess: () => observation,
      });

    await writeState({ ...recordedLease, projectDigest: "b".repeat(64) }, null);
    expect(status().detail).toBe("The host lease belongs to a different canonical project.");

    await writeState(null, { ...recordedHealth, projectDigest: "b".repeat(64) });
    expect(status().detail).toBe("The host health snapshot belongs to a different project.");

    await writeState(recordedLease, { ...recordedHealth, nonce: "different-owner" });
    expect(status().detail).toBe("The host lease and health snapshot have different owners.");

    await writeState(null, recordedHealth);
    now = baseNow + 60_000;
    expect(status()).toMatchObject({
      classification: "stale",
      owner: { pid: recordedHealth.pid },
      counts: recordedHealth.counts,
    });

    now = baseNow;
    await writeState(recordedLease, null);
    expect(status({ ...observedOwner, processStartId: null }).detail).toBe(
      "Owner liveness and the recorded identity do not agree.",
    );
    expect(status().detail).toBe("A live owner has no health snapshot.");

    now = baseNow + 60_000;
    expect(status({ ...observedOwner, alive: false })).toMatchObject({
      classification: "stale",
      lifecycle: null,
      counts: { active: 0, waiting: 0, parked: 0, failed: 0, controllers: 0 },
    });

    const freshLease = { ...recordedLease, heartbeatAt: new Date(now).toISOString() };
    await writeState(freshLease, recordedHealth);
    expect(status().detail).toBe("The live owner has an expired health snapshot.");

    await writeState(null, null);
    await fsp.writeFile(owner.leasePath, "x".repeat(16 * 1024 + 1), { mode: 0o600 });
    expect(status().detail).toBe("Transient host state is malformed.");

    await writeState(null, null);
    expect(status()).toMatchObject({ classification: "stopped", owner: null });
    await fsp.rm(stateDir, { recursive: true, force: true });
  });
});

describe.runIf(process.platform === "linux")("managed user service", () => {
  it("converges lifecycle operations and preserves durable project state", async () => {
    const project = await makeTempDir("omp-host-service project-%");
    const configHome = await makeTempDir("omp-host-service-config");
    const bin = await makeTempDir("omp-host-service-bin");
    const log = path.join(bin, "systemctl.log");
    const systemctl = path.join(bin, "systemctl");
    const cli = path.join(bin, "omp-workflows-cli.js");
    await fsp.writeFile(systemctl, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$SYSTEMCTL_LOG"\n', {
      mode: 0o700,
    });
    await fsp.writeFile(cli, "#!/usr/bin/env node\n", { mode: 0o700 });
    await fsp.writeFile(path.join(project, "durable-run.json"), "preserve\n");
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    vi.stubEnv("SYSTEMCTL_LOG", log);
    vi.stubEnv("XDG_CONFIG_HOME", configHome);

    const installed = installHostService(project, cli);
    installHostService(project, cli);
    startHostService(project);
    startHostService(project);
    restartHostService(project);
    stopHostService(project);
    stopHostService(project);

    const unit = await fsp.readFile(installed.path, "utf8");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("StartLimitBurst=5");
    expect(unit).toContain("KillSignal=SIGTERM");
    expect(unit).toContain("TimeoutStopSec=30s");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain(" host foreground --project ");
    expect(unit).toContain("%%");
    const escapedProject = installed.project
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "%%")
      .replaceAll(" ", "\\x20");
    expect(unit).toContain(`WorkingDirectory=${escapedProject}\n`);
    expect(unit).not.toContain('WorkingDirectory="');
    expect(unit).toContain(
      `ExecStart=${fs.realpathSync(process.execPath)} "${fs.realpathSync(cli)}" host foreground --project "${escapedProject}"`,
    );
    expect((await fsp.stat(installed.path)).mode & 0o777).toBe(0o600);

    uninstallHostService(project);
    uninstallHostService(project);
    await expect(fsp.readFile(path.join(project, "durable-run.json"), "utf8")).resolves.toBe(
      "preserve\n",
    );
    await expect(fsp.stat(installed.path)).rejects.toMatchObject({ code: "ENOENT" });
    const calls = await fsp.readFile(log, "utf8");
    expect(calls).toContain("--user daemon-reload");
    expect(calls).toContain(`--user enable ${installed.name}`);
    expect(calls).toContain(`--user disable --now ${installed.name}`);
  });

  it("refuses to overwrite an unmanaged unit", async () => {
    const project = await makeTempDir("omp-host-unmanaged-project");
    const configHome = await makeTempDir("omp-host-unmanaged-config");
    const bin = await makeTempDir("omp-host-unmanaged-bin");
    const systemctl = path.join(bin, "systemctl");
    const cli = path.join(bin, "cli.js");
    await fsp.writeFile(systemctl, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await fsp.writeFile(cli, "", { mode: 0o700 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    const service = hostService(project);
    await fsp.mkdir(path.dirname(service.path), { recursive: true });
    await fsp.writeFile(service.path, "[Unit]\nDescription=mine\n");
    expect(() => installHostService(project, cli)).toThrow(/unmanaged user unit/);
    expect(execFileSync(systemctl, ["--user", "show-environment"], { encoding: "utf8" })).toBe("");
  });
  it("reports missing units and unavailable user systemd", async () => {
    const project = await makeTempDir("omp-host-missing-service-project");
    const configHome = await makeTempDir("omp-host-missing-service-config");
    const bin = await makeTempDir("omp-host-missing-service-bin");
    const systemctl = path.join(bin, "systemctl");
    await fsp.writeFile(systemctl, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    vi.stubEnv("XDG_CONFIG_HOME", configHome);

    expect(() => startHostService(project)).toThrow(/service is not installed/);
    expect(stopHostService(project)).toEqual(hostService(project));

    await fsp.writeFile(systemctl, '#!/bin/sh\nprintf "no user bus\n" >&2\nexit 1\n');
    expect(() => stopHostService(project)).toThrow(/User systemd is unavailable/);
  });
  it("validates platform, CLI, and unit-file prerequisites", async () => {
    const project = await makeTempDir("omp-host-prerequisite-project");
    const configHome = await makeTempDir("omp-host-prerequisite-config");
    const bin = await makeTempDir("omp-host-prerequisite-bin");
    const systemctl = path.join(bin, "systemctl");
    const cli = path.join(bin, "cli.js");
    await fsp.writeFile(systemctl, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await fsp.writeFile(cli, "", { mode: 0o700 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    vi.stubEnv("XDG_CONFIG_HOME", configHome);

    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    expect(() => stopHostService(project)).toThrow(/requires Linux user systemd/);
    platform.mockRestore();

    const originalCli = process.argv[1];
    delete process.argv[1];
    try {
      expect(() => installHostService(project)).toThrow(
        /Cannot determine the omp-workflows CLI path/,
      );
    } finally {
      if (originalCli !== undefined) process.argv[1] = originalCli;
    }

    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    const fallback = hostService(project);
    expect(fallback.path).toBe(
      path.join(os.homedir(), ".config", "systemd", "user", fallback.name),
    );

    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    const service = hostService(project);
    await fsp.mkdir(service.path, { recursive: true });
    expect(() => installHostService(project, cli)).toThrow(
      /EISDIR|illegal operation on a directory/,
    );
  });
});
