import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifier = path.join(root, "scripts", "release-verify.mjs");

function runVerifier(args: string[]) {
  return spawnSync(process.execPath, [verifier, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

describe("release verifier", () => {
  it("locks synchronized 0.14.3 metadata and Node 22.18", () => {
    const result = runVerifier(["check-metadata"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      package: "0.14.3",
      packageLock: "0.14.3",
      packageLockRoot: "0.14.3",
      cargo: "0.14.3",
      herdr: "0.14.3",
      source: "0.14.3",
    });
  });

  it("rejects package inventory drift", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { requireInventory } from ${JSON.stringify(pathToFileURL(verifier).href)};
         try {
           requireInventory(["LICENSE"], ["README.md"], "npm");
           process.exit(2);
         } catch (error) {
           if (String(error).includes("npm package inventory changed")) process.exit(0);
           throw error;
         }`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
  });
  it("prepares artifacts when build commands inherit stdio", async () => {
    const outDir = await makeTempDir("omp-release-prepare");
    try {
      const result = runVerifier([
        "prepare",
        "--expected-main-commit",
        "HEAD",
        "--allow-dirty",
        "--skip-tag-ref",
        "--skip-registry",
        "--out-dir",
        outDir,
      ]);
      expect(result.status, result.stderr).toBe(0);
      await expect(
        fsp.readFile(path.join(outDir, "release-manifest.json"), "utf8"),
      ).resolves.toContain('"schema": "omp-workflows.release-manifest.v1"');
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  }, 120_000);
  it("accepts npm 11 arrays and npm 12 keyed results", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { parseNpmPackResult } from ${JSON.stringify(pathToFileURL(verifier).href)};
         const value = { filename: "package.tgz", files: [{ path: "README.md" }] };
         if (parseNpmPackResult(JSON.stringify([value]))?.filename !== value.filename) process.exit(2);
         if (parseNpmPackResult(JSON.stringify({ "@ericjuta/omp-workflows": value }))?.filename !== value.filename) process.exit(3);
         if (parseNpmPackResult(JSON.stringify({})) !== undefined) process.exit(4);`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
  });
});
