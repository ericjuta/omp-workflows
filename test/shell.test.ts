import { describe, expect, it } from "vitest";
import { TimeoutError } from "../src/workflows/errors.js";
import { mergeChildEnv, renderShellCommand, runShellAction } from "../src/workflows/shell.js";

describe("mergeChildEnv", () => {
  it("deletes keys overridden as undefined", () => {
    expect(
      mergeChildEnv(
        { KEEP: "1", GOOGLE_GENAI_USE_VERTEXAI: "true" },
        { GOOGLE_GENAI_USE_VERTEXAI: undefined },
      ),
    ).toEqual({ KEEP: "1" });
  });
});

describe("renderShellCommand", () => {
  it("renders commands with quoted args", () => {
    expect(renderShellCommand("git", ["status", "--short"])).toBe('git "status" "--short"');
    expect(renderShellCommand("ls", [])).toBe("ls");
  });
});

describe("runShellAction", () => {
  it("captures stdout, stderr, and exit code", async () => {
    const result = await runShellAction({
      command: "sh",
      args: ["-c", "printf out; printf err >&2"],
    });
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("omits overridden env keys that are undefined", async () => {
    const result = await runShellAction({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(String(process.env.GOOGLE_GENAI_USE_VERTEXAI ?? 'unset'))",
      ],
      env: { GOOGLE_GENAI_USE_VERTEXAI: undefined },
    });
    expect(result.stdout).toBe("unset");
  });
  it("can opt into a minimal host environment before applying explicit env", async () => {
    const hostSecretName = "OMP_SHELL_HOST_SECRET";
    const previousHostSecret = process.env[hostSecretName];
    process.env[hostSecretName] = "host-secret-value";
    try {
      const result = await runShellAction({
        command: process.execPath,
        args: [
          "-e",
          `process.stdout.write([process.env.${hostSecretName} ?? "unset", Boolean(process.env.PATH), process.env.EXPLICIT_MARK].join("|"))`,
        ],
        env: { EXPLICIT_MARK: "allowed" },
        inheritEnv: false,
      });
      expect(result.stdout).toBe("unset|true|allowed");
    } finally {
      if (previousHostSecret === undefined) delete process.env[hostSecretName];
      else process.env[hostSecretName] = previousHostSecret;
    }
  });

  it("passes stdin, env, and cwd", async () => {
    const result = await runShellAction({
      command: "sh",
      args: ["-c", 'cat; printf %s "$MARKER"; pwd'],
      stdin: "piped|",
      env: { MARKER: "-mark-" },
      cwd: "/tmp",
    });
    expect(result.stdout).toContain("piped|-mark-");
    expect(result.stdout.trimEnd().endsWith("/tmp")).toBe(true);
  });

  it("rejects on non-zero exit unless allowed", async () => {
    await expect(runShellAction({ command: "sh", args: ["-c", "exit 3"] })).rejects.toThrow(
      /exit 3/,
    );
    const tolerated = await runShellAction({
      command: "sh",
      args: ["-c", "exit 3"],
      allowNonZeroExit: true,
    });
    expect(tolerated.exitCode).toBe(3);
  });

  it("times out long-running commands", async () => {
    await expect(runShellAction({ command: "sleep", args: ["5"], timeoutMs: 100 })).rejects.toThrow(
      TimeoutError,
    );
  });
});
