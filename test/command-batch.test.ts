import { execFile } from "node:child_process";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  runCommandBatch,
  validateCommandBatchRequest,
  type CommandBatchItem,
} from "../src/workflows/command-batch.js";
import { makeTempDir } from "./helpers.js";

const execFileAsync = promisify(execFile);

function item(
  id: string,
  cwd: string,
  script = "process.stdout.write('ok')",
  timeoutMs = 2_000,
  maxOutputChars = 1_000,
): CommandBatchItem {
  return {
    id,
    command: process.execPath,
    args: ["-e", script],
    cwd,
    timeoutMs,
    maxOutputChars,
  };
}

async function initializeGitRepository(prefix: string): Promise<{ cwd: string; head: string }> {
  const cwd = await makeTempDir(prefix);
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd });
  await fs.writeFile(path.join(cwd, "tracked.txt"), "published\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd });
  await execFileAsync("git", ["commit", "-q", "-m", "published"], { cwd });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  return { cwd, head: stdout.trim() };
}

describe("command batch validation", () => {
  it("normalizes valid requests and accepts an empty batch", async () => {
    expect(validateCommandBatchRequest({ items: [], maxConcurrency: 2 })).toEqual({
      items: [],
      maxConcurrency: 2,
    });
    await expect(runCommandBatch({ items: [], maxConcurrency: 2 })).resolves.toEqual({
      schema: "pi-workflows.command-batch-result.v1",
      items: [],
      completed: 0,
      total: 0,
    });
  });

  it("rejects malformed requests, items, and limits", async () => {
    const cwd = await makeTempDir("command-batch-validation");
    const valid = item("one", cwd);
    for (const request of [null, [], "bad"]) {
      expect(() => validateCommandBatchRequest(request)).toThrow(/must be an object/);
    }
    expect(() =>
      validateCommandBatchRequest({ items: [], maxConcurrency: 1, unknown: true }),
    ).toThrow(/unknown is not supported/);
    expect(() => validateCommandBatchRequest({ items: "bad", maxConcurrency: 1 })).toThrow(
      /must be an array/,
    );
    expect(() =>
      validateCommandBatchRequest({
        items: Array.from({ length: 65 }, () => valid),
        maxConcurrency: 1,
      }),
    ).toThrow(/at most 64/);
    expect(() =>
      validateCommandBatchRequest({ items: [valid, { ...valid }], maxConcurrency: 1 }),
    ).toThrow(/duplicated/);
    expect(() => validateCommandBatchRequest({ items: [null], maxConcurrency: 1 })).toThrow(
      /must be an object/,
    );
    for (const bad of [
      { ...valid, id: "" },
      { ...valid, id: "invalid id" },
      { ...valid, command: "" },
      { ...valid, args: "bad" },
      { ...valid, args: [1] },
      { ...valid, cwd: "" },
      { ...valid, cwd: "relative" },
      { ...valid, expectedCommit: "HEAD" },
      { ...valid, expectedCommit: "abc123" },
      { ...valid, expectedRef: "main" },
      { ...valid, expectedRef: { name: "main", commit: "HEAD" } },
      { ...valid, expectedRef: { name: "-main", commit: "0".repeat(40) } },
      { ...valid, expectedRef: { name: "main", commit: "0".repeat(40), extra: true } },
      { ...valid, timeoutMs: 0 },
      { ...valid, timeoutMs: 3_600_001 },
      { ...valid, maxOutputChars: 0 },
      { ...valid, maxOutputChars: 1_000_001 },
    ]) {
      expect(() => validateCommandBatchRequest({ items: [bad], maxConcurrency: 1 })).toThrow();
    }
    expect(() =>
      validateCommandBatchRequest({
        items: [{ ...valid, env: { FLAG: 1 } }],
        maxConcurrency: 1,
      }),
    ).toThrow(/must be a string/);
    expect(() =>
      validateCommandBatchRequest({
        items: [{ ...valid, shell: true }],
        maxConcurrency: 1,
      }),
    ).toThrow(/shell is not supported/);
    for (const maxConcurrency of [0, 9, 1.5, "1"]) {
      expect(() => validateCommandBatchRequest({ items: [valid], maxConcurrency })).toThrow(
        /maxConcurrency/,
      );
    }
  });
});

describe("runCommandBatch", () => {
  it("runs only at the expected clean commit while preserving untracked files", async () => {
    const { cwd, head } = await initializeGitRepository("command-batch-expected-commit");
    const marker = path.join(cwd, "reviewer-ran");
    await fs.writeFile(path.join(cwd, "preserved-untracked.txt"), "keep\n");

    const result = await runCommandBatch({
      items: [
        {
          ...item("review", cwd),
          args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker],
          expectedCommit: head,
          expectedRef: { name: "HEAD", commit: head },
        },
      ],
      maxConcurrency: 1,
    });

    expect(result.items[0]).toMatchObject({ outcome: "succeeded", exitCode: 0 });
    await expect(fs.readFile(marker, "utf8")).resolves.toBe("ran");
    await expect(fs.readFile(path.join(cwd, "preserved-untracked.txt"), "utf8")).resolves.toBe(
      "keep\n",
    );
  });
  it("fails the item receipt before invocation when a Git ref moved", async () => {
    const { cwd } = await initializeGitRepository("command-batch-changed-ref");
    const marker = path.join(cwd, "reviewer-ran");
    const result = await runCommandBatch({
      items: [
        {
          ...item("review", cwd),
          args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker],
          expectedRef: { name: "HEAD", commit: "0".repeat(40) },
        },
      ],
      maxConcurrency: 1,
    });

    expect(result.items[0]).toMatchObject({ outcome: "failed", exitCode: null });
    expect(result.items[0]?.error).toContain("expected Git ref HEAD");
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it("fails the item receipt before invocation when tracked HEAD changed", async () => {
    const { cwd, head } = await initializeGitRepository("command-batch-changed-head");
    const marker = path.join(cwd, "reviewer-ran");
    await fs.writeFile(path.join(cwd, "tracked.txt"), "new commit\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd });
    await execFileAsync("git", ["commit", "-q", "-m", "changed head"], { cwd });

    const result = await runCommandBatch({
      items: [
        {
          ...item("review", cwd),
          args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker],
          expectedCommit: head,
        },
      ],
      maxConcurrency: 1,
    });

    expect(result.items[0]).toMatchObject({
      command: process.execPath,
      outcome: "failed",
      exitCode: null,
    });
    expect(result.items[0]?.error).toMatch(/expected Git HEAD .* found/);
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it("fails the item receipt before invocation for a dirty tracked checkout", async () => {
    const { cwd, head } = await initializeGitRepository("command-batch-dirty-tracked");
    const marker = path.join(cwd, "reviewer-ran");
    await fs.writeFile(path.join(cwd, "tracked.txt"), "dirty\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd });

    const result = await runCommandBatch({
      items: [
        {
          ...item("review", cwd),
          args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker],
          expectedCommit: head,
        },
      ],
      maxConcurrency: 1,
    });

    expect(result.items[0]).toMatchObject({
      command: process.execPath,
      outcome: "failed",
      exitCode: null,
    });
    expect(result.items[0]?.error).toContain("tracked checkout is dirty");
    await expect(fs.stat(marker)).rejects.toThrow();
  });
  it("fails synchronously at the pre-spawn boundary without invoking the child", async () => {
    const { cwd, head } = await initializeGitRepository("command-batch-pre-spawn");
    const marker = path.join(cwd, "reviewer-ran");
    let validationCalls = 0;
    const result = await runCommandBatch(
      {
        items: [
          {
            ...item("review", cwd),
            args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker],
            expectedCommit: head,
          },
        ],
        maxConcurrency: 1,
      },
      {
        validateBeforeSpawn: () => {
          validationCalls += 1;
          return "Reviewer trust failed for OPENAI_API_KEY=pre-spawn-secret";
        },
      },
    );

    expect(validationCalls).toBe(1);
    expect(result.items[0]).toMatchObject({ outcome: "failed", exitCode: null });
    expect(result.items[0]?.error).toContain("Reviewer trust failed");
    expect(result.items[0]?.error).not.toContain("pre-spawn-secret");
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it("passes item env into the child and can unset inherited keys", async () => {
    const cwd = await makeTempDir("command-batch-env");
    const result = await runCommandBatch({
      items: [
        {
          ...item(
            "env",
            cwd,
            "process.stdout.write([process.env.BATCH_MARK, process.env.GOOGLE_GENAI_USE_VERTEXAI ?? 'unset'].join('|'))",
          ),
          env: { BATCH_MARK: "ok" },
          envUnset: ["GOOGLE_GENAI_USE_VERTEXAI"],
        },
      ],
      maxConcurrency: 1,
    });
    expect(result.items[0]?.stdout).toBe("ok|unset");
  });
  it("runs printenv with platform basics but without credential-bearing host env", async () => {
    const cwd = await makeTempDir("command-batch-minimal-env");
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-host-api-key";
    try {
      const result = await runCommandBatch({
        items: [
          {
            ...item("printenv", cwd),
            command: "printenv",
            args: [],
          },
        ],
        maxConcurrency: 1,
      });

      expect(result.items[0]).toMatchObject({ outcome: "succeeded", exitCode: 0 });
      expect(result.items[0]?.stdout).toMatch(/(?:^|\n)PATH=.+/);
      expect(result.items[0]?.stdout).not.toContain("OPENAI_API_KEY");
      expect(result.items[0]?.stdout).not.toContain("sk-host-api-key");
    } finally {
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    }
  });

  it("redacts command output and failure errors before publishing a receipt", async () => {
    const cwd = await makeTempDir("command-batch-redacted-receipt");
    const stdout = [
      "OPENAI_API_KEY=sk-receipt-api-key",
      "Bearer bearer-receipt-token",
      "Cookie: session=receipt-cookie",
      "https://receipt-user:receipt-password@example.test/repository.git",
      "-----BEGIN PRIVATE KEY-----",
      "receipt-private-key-material",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const stderr = [
      "Authorization: Basic dXNlcjpwYXNz",
      "Set-Cookie: refresh=receipt-refresh-cookie; HttpOnly",
    ].join("\n");
    const result = await runCommandBatch({
      items: [
        {
          ...item(
            "redact",
            cwd,
            "process.stdout.write(process.env.LEAK_STDOUT); process.stderr.write(process.env.LEAK_STDERR); process.exit(2)",
          ),
          env: { LEAK_STDOUT: stdout, LEAK_STDERR: stderr },
          args: [
            "-e",
            "process.stdout.write(process.env.LEAK_STDOUT); process.stderr.write(process.env.LEAK_STDERR); process.exit(2)",
            "OPENAI_API_KEY=sk-argument-api-key",
            "https://argument-user:argument-password@example.test/repository.git",
          ],
        },
      ],
      maxConcurrency: 1,
    });

    const receipt = result.items[0];
    expect(receipt).toMatchObject({ outcome: "failed", exitCode: 2 });
    expect(receipt?.stdout).toContain("OPENAI_API_KEY=[redacted]");
    expect(receipt?.stdout).toContain("Bearer [redacted]");
    expect(receipt?.stdout).toContain("Cookie: [redacted]");
    expect(receipt?.stdout).toContain("https://[redacted]@example.test/repository.git");
    expect(receipt?.stdout).toContain("[private key redacted]");
    expect(receipt?.stderr).toBe(
      ["Authorization: [redacted]", "Set-Cookie: [redacted]"].join("\n"),
    );
    expect(receipt?.error).toContain("Authorization: [redacted]");
    expect(receipt?.args).toEqual([
      "-e",
      "process.stdout.write(process.env.LEAK_STDOUT); process.stderr.write(process.env.LEAK_STDERR); process.exit(2)",
      "OPENAI_API_KEY=[redacted]",
      "https://[redacted]@example.test/repository.git",
    ]);
    expect(JSON.stringify(receipt)).not.toMatch(
      /sk-receipt-api-key|bearer-receipt-token|receipt-cookie|receipt-user|receipt-password|receipt-private-key-material|dXNlcjpwYXNz|receipt-refresh-cookie|sk-argument-api-key|argument-user|argument-password/,
    );
  });
  it("redacts split and assigned sensitive long-option values in receipts", async () => {
    const cwd = await makeTempDir("command-batch-redacted-argv");
    const result = await runCommandBatch({
      items: [
        {
          ...item("redact-argv", cwd),
          args: [
            "-e",
            "process.stdout.write('ok')",
            "--token",
            "ghp_split_secret",
            "--password",
            "split-password-secret",
            "--api-key=assigned-api-secret",
            "-p",
            "ordinary-short-option-value",
          ],
        },
      ],
      maxConcurrency: 1,
    });

    expect(result.items[0]?.args).toEqual([
      "-e",
      "process.stdout.write('ok')",
      "--token",
      "[redacted]",
      "--password",
      "[redacted]",
      "--api-key=[redacted]",
      "-p",
      "ordinary-short-option-value",
    ]);
    expect(JSON.stringify(result.items[0])).not.toMatch(
      /ghp_split_secret|split-password-secret|assigned-api-secret/,
    );
  });

  it("returns results in input order while commands finish out of order", async () => {
    const cwd = await makeTempDir("command-batch-order");
    const result = await runCommandBatch({
      items: [
        item("slow", cwd, "setTimeout(() => process.stdout.write('slow'), 120)"),
        item("fast", cwd, "process.stdout.write('fast')"),
      ],
      maxConcurrency: 2,
    });
    expect(result.items.map((entry) => entry.id)).toEqual(["slow", "fast"]);
    expect(result.items.map((entry) => entry.stdout)).toEqual(["slow", "fast"]);
    expect(result.items.every((entry) => entry.outcome === "succeeded")).toBe(true);
  });

  it("enforces the concurrency limit", async () => {
    const cwd = await makeTempDir("command-batch-concurrency");
    const log = path.join(cwd, "events.log");
    const script = (id: string) =>
      [
        "const fs = require('node:fs');",
        `const log = ${JSON.stringify(log)};`,
        `fs.appendFileSync(log, 'start ${id} ' + Date.now() + '\\n');`,
        `setTimeout(() => { fs.appendFileSync(log, 'end ${id} ' + Date.now() + '\\n'); }, 100);`,
      ].join("\n");
    await runCommandBatch({
      items: ["a", "b", "c", "d"].map((id) => item(id, cwd, script(id))),
      maxConcurrency: 2,
    });
    const events = (await fs.readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => line.split(" "));
    let active = 0;
    let maximum = 0;
    for (const [kind] of events) {
      active += kind === "start" ? 1 : -1;
      maximum = Math.max(maximum, active);
    }
    expect(maximum).toBe(2);
    expect(active).toBe(0);
  });

  it("isolates nonzero exits, spawn failures, and timeouts", async () => {
    const cwd = await makeTempDir("command-batch-failures");
    const result = await runCommandBatch({
      items: [
        item("success", cwd),
        item("exit", cwd, "process.stderr.write('bad'); process.exit(3)"),
        { ...item("spawn", cwd), command: path.join(cwd, "missing") },
        item("timeout", cwd, "setTimeout(() => {}, 1000)", 50),
      ],
      maxConcurrency: 4,
    });
    expect(result.items.map((entry) => entry.outcome)).toEqual([
      "succeeded",
      "failed",
      "failed",
      "timedOut",
    ]);
    expect(result.items[1]).toMatchObject({ exitCode: 3, stderr: "bad" });
    expect(result.items[2]?.error).toBeTruthy();
    expect(result.items[3]?.error).toMatch(/Timed out/);
  });

  it("reports output truncation", async () => {
    const cwd = await makeTempDir("command-batch-truncation");
    const result = await runCommandBatch({
      items: [item("large", cwd, "process.stdout.write('abcdef')", 1_000, 3)],
      maxConcurrency: 1,
    });
    expect(result.items[0]).toMatchObject({
      outcome: "succeeded",
      stdoutTruncated: true,
      stderrTruncated: false,
    });
    expect(result.items[0]?.stdout).toContain("output truncated");
  });

  it("publishes settlement callbacks with observed counts", async () => {
    const cwd = await makeTempDir("command-batch-callback");
    const updates: Array<{ id: string; completed: number; total: number }> = [];
    await runCommandBatch(
      {
        items: [item("one", cwd), item("two", cwd)],
        maxConcurrency: 1,
      },
      {
        onItemSettled: (result, completed, total) => {
          updates.push({ id: result.id, completed, total });
        },
      },
    );
    expect(updates).toEqual([
      { id: "one", completed: 1, total: 2 },
      { id: "two", completed: 2, total: 2 },
    ]);
  });

  it("keeps settlement callback failures observational", async () => {
    const cwd = await makeTempDir("command-batch-callback-failure");
    const result = await runCommandBatch(
      {
        items: [item("one", cwd), item("two", cwd)],
        maxConcurrency: 1,
      },
      {
        onItemSettled: () => {
          throw new Error("update unavailable");
        },
      },
    );
    expect(result).toMatchObject({
      completed: 2,
      items: [{ outcome: "succeeded" }, { outcome: "succeeded" }],
    });
  });

  it("replays a whole unaccepted read-only batch after interruption", async () => {
    const cwd = await makeTempDir("command-batch-replay");
    const log = path.join(cwd, "runs.log");
    const command = (id: string) =>
      item(
        id,
        cwd,
        `require('node:fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(id)} + '\\n')`,
      );
    const request = { items: [command("one"), command("two")], maxConcurrency: 2 };
    const first = await runCommandBatch(request);
    const replay = await runCommandBatch(request);
    expect(first.items.every((entry) => entry.outcome === "succeeded")).toBe(true);
    expect(replay.items.every((entry) => entry.outcome === "succeeded")).toBe(true);
    expect((await fs.readFile(log, "utf8")).trim().split("\n").sort()).toEqual([
      "one",
      "one",
      "two",
      "two",
    ]);
  });

  it("returns cancelled results without starting work when already aborted", async () => {
    const cwd = await makeTempDir("command-batch-pre-abort");
    const controller = new AbortController();
    controller.abort();
    const result = await runCommandBatch(
      { items: [item("one", cwd)], maxConcurrency: 1 },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      completed: 0,
      items: [{ id: "one", outcome: "cancelled", durationMs: 0 }],
    });
  });

  it("stops active work and does not start queued commands after abort", async () => {
    const cwd = await makeTempDir("command-batch-abort");
    const log = path.join(cwd, "started.log");
    const script = [
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(log)}, 'started\\n');`,
      "setTimeout(() => {}, 5_000);",
    ].join("\n");
    const controller = new AbortController();
    let resolveStarted = () => {};
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const watcher = watch(cwd, (_event, filename) => {
      if (filename === "started.log") resolveStarted();
    });
    try {
      const running = runCommandBatch(
        {
          items: [item("one", cwd, script, 10_000), item("two", cwd, script, 10_000)],
          maxConcurrency: 1,
        },
        { signal: controller.signal },
      );
      try {
        await fs.access(log);
        resolveStarted();
      } catch {
        // Watcher resolves when the first command creates the log.
      }
      await Promise.race([
        started,
        running.then((batch) => {
          throw new Error(`first command did not start: ${JSON.stringify(batch.items)}`);
        }),
      ]);
      controller.abort();
      const result = await running;
      const starts = (await fs.readFile(log, "utf8")).trim().split("\n");
      expect(starts).toHaveLength(1);
      expect(result.items.map((entry) => entry.outcome)).toEqual(["cancelled", "cancelled"]);
    } finally {
      watcher.close();
    }
  });
});
