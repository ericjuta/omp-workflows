import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyLease,
  HostOwnership,
  readHostStatus,
  type HostLease,
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

  it("reports malformed transient state as inconsistent without deleting it", async () => {
    const project = await makeTempDir("omp-host-malformed-project");
    const stateDir = await makeTempDir("omp-host-malformed-state");
    const file = path.join(stateDir, "host.lease.json");
    await fsp.writeFile(file, "{truncated", { mode: 0o600 });
    expect(readHostStatus(project, { stateDir }).classification).toBe("inconsistent");
    await expect(fsp.readFile(file, "utf8")).resolves.toBe("{truncated");
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
});
