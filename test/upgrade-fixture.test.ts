import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readRunBundle } from "../src/workflows/store.js";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/upgrade/v0.12-waiting",
);

describe("v0.12 upgrade fixture", () => {
  it("reopens the sanitized waiting bundle under the current durable format", async () => {
    const bundle = await readRunBundle(fixtureDir, { includeTrace: true });
    expect(bundle).not.toBeNull();
    expect(bundle?.manifest.schema).toBe("pi-workflows.run-bundle.v1");
    expect(bundle?.state.status).toBe("waiting");
    expect(bundle?.state.waitingOn).toBe("review");
    expect(bundle?.state.finalOutput).toBeNull();
    expect(bundle?.snapshot?.name).toBe("v012-upgrade-fixture");
    expect(bundle?.traceEvents?.map((event) => event.type)).toEqual([
      "run_started",
      "checkpoint_waiting",
    ]);
  });
});
