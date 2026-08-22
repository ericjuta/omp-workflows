#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const releaseMode = process.argv.includes("--release");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "viewer", "cli.js");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflows-host-soak-"));
const project = path.join(temporary, "project");
const home = path.join(temporary, "home");
const runs = path.join(temporary, "runs");
const controllers = path.join(temporary, "controllers");
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  PI_WORKFLOWS_RUNS_DIR: runs,
  PI_WORKFLOWS_CONTROLLER_DIR: controllers,
};

await Promise.all([
  fs.mkdir(project, { recursive: true }),
  fs.mkdir(home, { recursive: true }),
  fs.mkdir(runs, { recursive: true }),
  fs.mkdir(controllers, { recursive: true }),
]);
await fs.writeFile(path.join(project, "durable-sentinel"), "preserve\n");

function startHost() {
  const child = spawn(process.execPath, [cli, "host", "foreground", "--project", project], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return { child, output: () => output };
}

function status() {
  const result = spawnSync(
    process.execPath,
    [cli, "host", "status", "--project", project, "--json"],
    { cwd: root, env, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`host status failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

async function waitFor(predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForExit(child, timeoutMs = 15_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for host process exit")), timeoutMs),
    ),
  ]);
}

let host;
try {
  await fs.access(cli);
  host = startHost();
  await waitFor(() => status().classification === "healthy", "healthy initial host");

  const duplicate = spawnSync(process.execPath, [cli, "host", "foreground", "--project", project], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (duplicate.status === 0) throw new Error("A duplicate host unexpectedly acquired ownership");
  if (!`${duplicate.stdout}${duplicate.stderr}`.match(/already running|process lock failed/)) {
    throw new Error(`Duplicate host failed for an unexpected reason: ${duplicate.stderr}`);
  }

  host.child.kill("SIGTERM");
  await waitForExit(host.child);
  await waitFor(() => status().classification === "stopped", "graceful ownership release");
  if ((await fs.readFile(path.join(project, "durable-sentinel"), "utf8")) !== "preserve\n") {
    throw new Error("Graceful shutdown changed durable project state");
  }

  host = startHost();
  await waitFor(() => status().classification === "healthy", "healthy replacement host");
  host.child.kill("SIGKILL");
  await waitForExit(host.child);
  await waitFor(
    () => ["inconsistent", "stale"].includes(status().classification),
    "crash-visible transient ownership",
  );

  if (releaseMode) {
    await waitFor(() => status().classification === "stale", "expired stale ownership", 30_000);
    host = startHost();
    await waitFor(() => status().classification === "healthy", "stale ownership reclaim");
    host.child.kill("SIGTERM");
    await waitForExit(host.child);
    await waitFor(() => status().classification === "stopped", "reclaimed host release");
  }

  if ((await fs.readFile(path.join(project, "durable-sentinel"), "utf8")) !== "preserve\n") {
    throw new Error("Crash recovery changed durable project state");
  }
  process.stdout.write(
    `${JSON.stringify({ schema: "omp-workflows.host-soak.v1", mode: releaseMode ? "release" : "short", ok: true })}\n`,
  );
} catch (error) {
  if (host?.child.exitCode === null && host.child.signalCode === null) {
    host.child.kill("SIGKILL");
    await waitForExit(host.child).catch(() => undefined);
  }
  throw error;
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
