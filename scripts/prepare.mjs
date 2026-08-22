// npm lifecycle "prepare" hook. Production installs (npm install --omit=dev)
// have no TypeScript toolchain; that is fine because OMP and the supported Pi
// host adapter load the extension from src. Only build when tsc is available
// (dev installs, npm link, publishing).
import { spawnSync } from "node:child_process";

try {
  const { createRequire } = await import("node:module");
  createRequire(import.meta.url).resolve("typescript");
} catch {
  console.warn("omp-workflows: skipping build (typescript not installed; hosts load src directly)");
  process.exit(0);
}

const result = spawnSync("npm", ["run", "build"], { stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
