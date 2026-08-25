import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostProcessRegistry } from "../src/host/processes.js";
import piWorkflowsRpcBridge, { RPC_SUBMISSION_PREFIX } from "../src/host/rpc-bridge.js";
import { RpcStepExecutor } from "../src/host/rpc-executor.js";
import { WORKFLOW_OBSERVATION_ONLY_ENV } from "../src/workflows/observation-tool-policy.js";
import { makeTempDir } from "./helpers.js";
afterEach(() => vi.unstubAllEnvs());

describe("RpcStepExecutor spawn", () => {
  it("spawns children with extension isolation", async () => {
    const dir = await makeTempDir("omp-rpc-args");
    const argsFile = path.join(dir, "argv.txt");
    const fakeOmp = path.join(dir, "omp");
    await fs.writeFile(
      fakeOmp,
      `#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(argsFile)}
sleep 60
`,
      { encoding: "utf8", mode: 0o755 },
    );
    const registry = new HostProcessRegistry(dir);
    const executor = new RpcStepExecutor({
      cwd: dir,
      registry,
      env: { PATH: `${dir}:${process.env.PATH ?? ""}` },
    });
    const abort = new AbortController();
    const stepPromise = executor
      .runAgentStep(
        {
          contract: { runId: "r", workflowName: "w", nodeId: "n", attemptId: "a" },
          prompt: "hi",
          accept: async () => ({ ok: true as const, value: null }),
        },
        abort.signal,
      )
      .catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await executor.close();
    abort.abort(new Error("done"));
    await stepPromise;

    const args = await fs.readFile(argsFile, "utf8");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("rpc-bridge");
    // The bridge is the only extension the child loads.
    const noExtensionsIndex = args.indexOf("--no-extensions");
    const bridgeIndex = args.indexOf("-e\n");
    expect(noExtensionsIndex).toBeGreaterThanOrEqual(0);
    expect(bridgeIndex).toBeGreaterThan(noExtensionsIndex);
  });

  it("fails the step instead of crashing when omp is missing", async () => {
    const dir = await makeTempDir("omp-rpc-missing");
    const registry = new HostProcessRegistry(dir);
    const executor = new RpcStepExecutor({
      cwd: dir,
      registry,
      ompBin: path.join(dir, "definitely-not-a-real-omp-binary"),
    });
    const abort = new AbortController();
    const result = await executor
      .runAgentStep(
        {
          contract: { runId: "r", workflowName: "w", nodeId: "n", attemptId: "a" },
          prompt: "hi",
          accept: async () => ({ ok: true as const, value: null }),
        },
        abort.signal,
      )
      .then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
    expect(result).not.toBe("resolved");
    await executor.close();
  });
  it("selects and reuses children by explicit tool policy, not step identity", async () => {
    const dir = await makeTempDir("omp-rpc-tool-policy");
    const policyLog = path.join(dir, "policy.log");
    const fakeOmp = path.join(dir, "fake-omp.cjs");
    await fs.writeFile(
      fakeOmp,
      `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(
  ${JSON.stringify(policyLog)},
  String(process.env[${JSON.stringify(WORKFLOW_OBSERVATION_ONLY_ENV)}] ?? "<unset>") + ":" + process.pid + "\\n",
);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const event = JSON.parse(line);
  if (event.type !== "prompt") return;
  const { step, attempt } = JSON.parse(event.message);
  process.stderr.write(
    ${JSON.stringify(RPC_SUBMISSION_PREFIX)} +
      JSON.stringify({ action: "submit", step, attempt, output: null }) +
      "\\n",
  );
});
`,
      { encoding: "utf8", mode: 0o755 },
    );
    const executor = new RpcStepExecutor({
      cwd: dir,
      registry: new HostProcessRegistry(dir),
      ompBin: fakeOmp,
    });
    const runStep = (contract: Parameters<RpcStepExecutor["runAgentStep"]>[0]["contract"]) =>
      executor.runAgentStep(
        {
          contract,
          prompt: JSON.stringify({ step: contract.nodeId, attempt: contract.attemptId }),
          accept: async () => ({ ok: true as const, value: null }),
        },
        new AbortController().signal,
      );

    const restrictedContract = {
      runId: "r",
      workflowName: "arbitrary-workflow",
      nodeId: "arbitrary-node",
      attemptId: "restricted",
      toolPolicy: "observation-only" as const,
    };
    await runStep(restrictedContract);
    const restrictedSpawn = (await fs.readFile(policyLog, "utf8")).trim();

    await runStep({ ...restrictedContract, attemptId: "reused" });
    expect((await fs.readFile(policyLog, "utf8")).trim()).toBe(restrictedSpawn);

    await runStep({
      runId: "r",
      workflowName: "monitor",
      nodeId: "check",
      attemptId: "unrestricted",
    });
    const [restricted, unrestricted] = (await fs.readFile(policyLog, "utf8")).trim().split("\n");
    expect(restricted?.split(":")[0]).toBe("1");
    expect(unrestricted?.split(":")[0]).toBe("<unset>");
    expect(unrestricted?.split(":")[1]).not.toBe(restricted?.split(":")[1]);
    await executor.close();
  });

  it("installs the observation allowlist under the generic environment flag", () => {
    let toolCall: ((event: { toolName: string; input: unknown }) => unknown) | undefined;
    const api = {
      registerTool: () => undefined,
      on: (event: string, handler: (event: { toolName: string; input: unknown }) => unknown) => {
        if (event === "tool_call") toolCall = handler;
      },
    } as never;

    vi.stubEnv(WORKFLOW_OBSERVATION_ONLY_ENV, "");
    piWorkflowsRpcBridge(api);
    expect(toolCall).toBeUndefined();

    vi.stubEnv(WORKFLOW_OBSERVATION_ONLY_ENV, "1");
    piWorkflowsRpcBridge(api);

    expect(toolCall?.({ toolName: "read", input: { path: "state.json" } })).toBeUndefined();
    expect(toolCall?.({ toolName: "write", input: { path: "state.json", content: "x" } })).toEqual({
      block: true,
      reason: "This workflow step is observation-only; tool write is not allowed.",
    });
  });
});

describe("RpcStepExecutor.close", () => {
  it("kills the whole process group, including grandchildren", async () => {
    const dir = await makeTempDir("omp-rpc-close");
    // A fake OMP process that leaves a grandchild behind: the parent sleeps
    // while a child sleeps in the same group.
    const fakeOmp = path.join(dir, "fake-omp.sh");
    await fs.writeFile(fakeOmp, "#!/bin/sh\nsleep 60 &\nexec sleep 60\n", {
      encoding: "utf8",
      mode: 0o755,
    });
    const registry = new HostProcessRegistry(dir);
    const executor = new RpcStepExecutor({ cwd: dir, registry, ompBin: fakeOmp });
    const abort = new AbortController();
    const stepPromise = executor
      .runAgentStep(
        {
          contract: { runId: "r", workflowName: "w", nodeId: "n", attemptId: "a" },
          prompt: "hi",
          accept: async () => ({ ok: true as const, value: null }),
        },
        abort.signal,
      )
      .catch((error: unknown) => error);
    // Give the child a moment to spawn, then close and abort the step.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pid = (executor as unknown as { child: { pid?: number } | null }).child?.pid;
    expect(pid).toBeDefined();
    await executor.close();
    abort.abort(new Error("done"));
    await stepPromise;
    // The entire group is gone: a group probe fails, and the registry is empty.
    expect(() => process.kill(-(pid as number), 0)).toThrow();
    expect(registry.size).toBe(0);
  });
});
