import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifier = path.join(root, "scripts", "release-verify.mjs");

function runVerifier(args: string[]) {
  return spawnSync(process.execPath, [verifier, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

describe("release verifier", () => {
  it("locks synchronized 0.13.0 metadata and Node 22.18", () => {
    const result = runVerifier(["check-metadata"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      package: "0.13.0",
      packageLock: "0.13.0",
      packageLockRoot: "0.13.0",
      cargo: "0.13.0",
      herdr: "0.13.0",
      source: "0.13.0",
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
});
