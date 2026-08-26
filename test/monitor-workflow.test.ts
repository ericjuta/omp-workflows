import { describe, expect, it } from "vitest";
import monitor, {
  prepareMonitorInput,
  validateMonitorCheck,
  waitForMonitorInterval,
} from "../src/builtins/monitor.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { AgentStepExecutor, WorkflowNotificationRequest } from "../src/workflows/types.js";
import { makeTempDir, ScriptedExecutor, waitUntil } from "./helpers.js";

function scriptedExecutor(outputs: unknown[], prompts: string[] = []): AgentStepExecutor {
  const remaining = [...outputs];
  return {
    async runAgentStep(request) {
      prompts.push(request.prompt);
      const output = remaining.shift();
      if (output === undefined) throw new Error("No scripted monitor output remains");
      const accepted = await request.accept(output);
      if (!accepted.ok) throw new Error(accepted.error);
      return { output: accepted.value };
    },
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    task: "Check pull request 123",
    stopWhen: "The pull request is merged or closed",
    maxChecks: 5,
    ...overrides,
  };
}

function check(overrides: Record<string, unknown> = {}) {
  return {
    route: "stop",
    goalState: "complete",
    workState: "stopped",
    observation: "Pull request 123 is merged.",
    report: "PR 123 is merged.",
    targetStateId: "pr-123:merged",
    authorizedActions: [] as string[],
    reason: "The stop condition is true.",
    ...overrides,
  };
}

function actionRequest(
  kind: "advance" | "recover" | "repair" = "advance",
  overrides: Record<string, unknown> = {},
) {
  return {
    kind,
    incomplete: "One requested unit remains.",
    evidence: { completed: 4, total: 5 },
    nextAction: kind === "recover" ? "Resume the saved unit." : "Start the missing unit.",
    authority: {
      status: "authorized",
      basis: "The task explicitly authorizes finishing the remaining unit.",
      allowedMutations: ["the saved unit and its launch process"],
      forbiddenMutations: ["provider changes"],
      costLimit: "No paid resources",
      providerRuntime: "Keep the current runtime",
      requiredChecks: ["confirm the worker is active"],
      stopConditions: ["stop on a protected contract change"],
      allowedRecoveryActions: ["resume saved work"],
      merge: false,
      repairApproval: { mode: "skip" },
    },
    cost: {
      paidAction: false,
      status: "not-applicable",
      evidence: "The action uses local resources.",
    },
    defect: {
      sharedCodeOrDataDefect: false,
      paidWorkers: "not-applicable",
      evidence: "No shared defect is present.",
    },
    verification: "Confirm that the worker is active.",
    failureId: "unit-5-idle",
    targetStateId: "units:4-of-5:idle",
    ...overrides,
  };
}

function actCheck(
  kind: "advance" | "recover" | "repair" = "advance",
  overrides: Record<string, unknown> = {},
) {
  return check({
    route: "act",
    goalState: "incomplete",
    workState: kind === "recover" ? "stopped" : "idle",
    observation: "Four of five units are complete and no worker is active.",
    report: "The target is idle with one unit missing.",
    targetStateId: "units:4-of-5:idle",
    authorizedActions: ["start the missing unit"],
    reason: "One safe authorized action is available.",
    action: actionRequest(kind),
    ...overrides,
  });
}

function actionResult(
  status: "succeeded" | "failed" | "blocked" = "succeeded",
  overrides: Record<string, unknown> = {},
) {
  return {
    status,
    summary: status === "succeeded" ? "Started the missing unit." : "The start command failed.",
    evidence: { process: status === "succeeded" ? "active" : "not-found" },
    verification: "Checked the real worker process.",
    failureId: "unit-5-idle",
    targetStateId: "units:4-of-5:idle",
    ...overrides,
  };
}

function waitCheck(overrides: Record<string, unknown> = {}) {
  return check({
    route: "wait",
    goalState: "incomplete",
    workState: "running",
    observation: "PR 123 remains open.",
    report: "PR 123 remains open.",
    targetStateId: "pr-123:open",
    reason: "It is not merged.",
    ...overrides,
  });
}
function monitorWithFastTimeoutRetry() {
  const checkNode = monitor.nodes.check;
  const sleepNode = monitor.nodes.sleep;
  if (checkNode === undefined || sleepNode?.nodeType !== "compute") {
    throw new Error("monitor check and sleep nodes are required");
  }
  return {
    ...monitor,
    nodes: {
      ...monitor.nodes,
      check: { ...checkNode, timeoutMs: 20 },
      sleep: {
        ...sleepNode,
        run: async () => ({ waitedMinutes: 1, interrupted: false }),
      },
    },
  };
}

describe("built-in monitor workflow", () => {
  it("declares and forwards the observation-only check policy", async () => {
    expect(monitor.nodes.check).toMatchObject({
      nodeType: "agent",
      toolPolicy: "observation-only",
    });
    const executor = new ScriptedExecutor().respond("check", { output: check() });
    const engine = new WorkflowEngine({
      executor,
      store: new WorkflowRunStore(await makeTempDir("observation-tool-policy")),
      notificationSink: {
        notify() {
          return { notificationId: "n1", targetSessionId: "s1" };
        },
      },
    });

    await engine.run(monitor, input());

    expect(executor.requests[0]?.contract).toMatchObject({
      nodeId: "check",
      toolPolicy: "observation-only",
    });
  });

  it("defaults to 30 minutes and explicit-user-stop when no finish rule is supplied", () => {
    expect(prepareMonitorInput({ task: "Observe the target" })).toMatchObject({
      everyMinutes: 30,
      stopWhen: "Stop only when the user explicitly asks to stop.",
      maxChecks: 1_000,
      checkTimeoutMinutes: 60,
    });
    expect(() => prepareMonitorInput({ task: "Observe", reportWhen: "state changes" })).toThrow(
      "reportWhen is not supported",
    );
  });

  it("reports every accepted stop check before completion", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([check()]),
      store: new WorkflowRunStore(await makeTempDir("monitor-stop")),
      notificationSink: {
        notify(request) {
          notifications.push(request);
          return { notificationId: "n1", targetSessionId: "s1" };
        },
      },
    });

    const result = await engine.run(monitor, input());

    expect(result.state.status).toBe("completed");
    expect(notifications[0]?.content).toContain("PR 123 is merged.");
    expect(notifications[0]?.content).toContain("Goal: complete");
    expect(notifications[0]?.content).toContain("Work: stopped");
    expect(result.state.steps.map((step) => step.nodeId)).toEqual([
      "prepare",
      "check",
      "estimate",
      "publish_progress",
      "report",
      "decide",
      "finish",
    ]);
    expect(result.state.finalOutput).toMatchObject({
      reported: true,
      checks: 1,
      goalState: "complete",
    });
  });

  it("reports a wait check and then stops at the disclosed safety limit", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([waitCheck()]),
      store: new WorkflowRunStore(await makeTempDir("monitor-limit")),
      notificationSink: {
        notify(request) {
          notifications.push(request);
          return { notificationId: "n1", targetSessionId: "s1" };
        },
      },
    });

    const result = await engine.run(monitor, input({ maxChecks: 1 }));

    expect(result.state.status).toBe("completed");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.content).toContain("Reached the 1-check safety limit.");
    expect(result.state.finalOutput).toMatchObject({
      reason: "Reached the 1-check safety limit.",
      reported: true,
    });
    expect(result.state.steps.some((step) => step.nodeId === "sleep")).toBe(false);
  });

  it("lets an authorized act finish a goal without sleeping", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([actCheck("advance"), actionResult(), check()]),
      store: new WorkflowRunStore(await makeTempDir("monitor-act-finish")),
      notificationSink: {
        notify(request) {
          notifications.push(request);
          return { notificationId: `n${notifications.length}`, targetSessionId: "s1" };
        },
      },
    });

    const result = await engine.run(monitor, input());
    const steps = result.state.steps.map((step) => step.nodeId);
    const actIndex = steps.indexOf("act");

    expect(result.state.status).toBe("completed");
    expect(actIndex).toBeGreaterThan(-1);
    expect(steps[actIndex + 1]).toBe("check");
    expect(steps).not.toContain("schedule");
    expect(steps).not.toContain("sleep");
    expect(result.state.finalOutput).toMatchObject({ goalState: "complete" });
    expect(notifications[0]?.content).toContain("Next action: Start the missing unit.");
    expect(notifications[1]?.content).toContain("Goal: complete");
  });

  it("stops without mutating when the next act is unauthorized", async () => {
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([
        check({
          goalState: "blocked",
          workState: "idle",
          observation: "The required repository mutation is not authorized.",
          report: "The next action is outside recorded authority.",
          targetStateId: "blocked:unauthorized",
          reason: "The required repository mutation is not authorized.",
        }),
      ]),
      store: new WorkflowRunStore(await makeTempDir("monitor-unauthorized-stop")),
      notificationSink: {
        notify() {
          return { notificationId: "n1", targetSessionId: "s1" };
        },
      },
    });

    const result = await engine.run(monitor, input());

    expect(result.state.status).toBe("completed");
    expect(result.state.steps.some((step) => step.nodeId === "act")).toBe(false);
    expect(result.state.finalOutput).toMatchObject({
      goalState: "blocked",
      reason: "The required repository mutation is not authorized.",
    });
  });

  it("retries timed-out checks through schedule and sleep, then stops truthfully", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const executor = new ScriptedExecutor().respond(
      "check",
      { hang: true },
      { hang: true },
      { hang: true },
    );
    const engine = new WorkflowEngine({
      executor,
      store: new WorkflowRunStore(await makeTempDir("monitor-check-timeouts")),
      notificationSink: {
        notify(request) {
          notifications.push(request);
          return { notificationId: `n${notifications.length}`, targetSessionId: "s1" };
        },
      },
    });

    const result = await engine.run(
      monitorWithFastTimeoutRetry(),
      input({ everyMinutes: 1, maxChecks: 5 }),
    );

    expect(result.state.status).toBe("completed");
    expect(
      result.state.steps.filter((step) => step.nodeId === "check").map((step) => step.outcome),
    ).toEqual(["timed_out", "timed_out", "timed_out"]);
    expect(result.state.steps.filter((step) => step.nodeId === "schedule")).toHaveLength(2);
    expect(result.state.steps.filter((step) => step.nodeId === "sleep")).toHaveLength(2);
    expect(
      result.state.steps
        .filter((step) => step.nodeId === "recordCheckTimeout")
        .map((step) => (step.output as { route: string }).route),
    ).toEqual(["retry", "retry", "stop"]);
    expect(notifications.map((notification) => notification.content)).toEqual([
      "Monitor check timed out (1/3); another check will be scheduled after the configured interval.",
      "Monitor check timed out (2/3); another check will be scheduled after the configured interval.",
      "Monitor check timed out 3 consecutive times; stopping without a current observation.",
    ]);
    expect(result.state.finalOutput).toMatchObject({
      consecutiveTimeouts: 3,
      checks: 0,
      reported: true,
    });
    const finalOutput = result.state.finalOutput as Record<string, unknown>;
    expect(finalOutput).not.toHaveProperty("observation");
    expect(finalOutput).not.toHaveProperty("report");
    expect(finalOutput).not.toHaveProperty("progress");
    expect(finalOutput).not.toHaveProperty("repair");
  });

  it("keeps cancellation terminal instead of routing it as a timeout retry", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const executor = new ScriptedExecutor().respond("check", { hang: true });
    const engine = new WorkflowEngine({
      executor,
      store: new WorkflowRunStore(await makeTempDir("monitor-check-cancel")),
      notificationSink: {
        notify(request) {
          notifications.push(request);
          return { notificationId: "n1", targetSessionId: "s1" };
        },
      },
    });
    const running = engine.run(monitor, input());
    await waitUntil(() => executor.requests.length > 0);
    expect(executor.requests).toHaveLength(1);
    engine.cancel();
    const result = await running;

    expect(result.state.status).toBe("cancelled");
    expect(result.state.steps.some((step) => step.nodeId === "recordCheckTimeout")).toBe(false);
    expect(notifications).toHaveLength(0);
  });

  it("routes only timed-out checks through the bounded retry graph", () => {
    const checkEdge = monitor.edges.find((edge) => edge.from === "check");
    const timeoutEdge = monitor.edges.find((edge) => edge.from === "recordCheckTimeout");
    expect(checkEdge).toMatchObject({
      switch: {
        on: "$result.outcome",
        cases: { ok: "estimate", timed_out: "recordCheckTimeout", failed: "recordCheckFailure" },
      },
    });
    expect(timeoutEdge).toMatchObject({
      switch: {
        cases: { retry: "checkTimeoutRetryReport", stop: "checkTimeoutStopReport" },
      },
    });
    expect(monitor.edges).toContainEqual({ from: "checkTimeoutRetryReport", to: "schedule" });
    expect(monitor.edges).toContainEqual({ from: "schedule", to: "sleep" });
    expect(JSON.stringify([checkEdge, timeoutEdge])).not.toContain("planChange");
    expect(JSON.stringify([checkEdge, timeoutEdge])).not.toContain("implementation");
  });

  it("publishes progress and adds a model-free estimate to the report", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([
        check({
          report: "Checks are still running.",
          progress: {
            tracks: [
              {
                key: "checks",
                data: {
                  schema: "pi-workflows.progress.v1",
                  label: "Checks",
                  status: "running",
                  completed: 8,
                  total: 10,
                  unit: "checks",
                },
              },
            ],
          },
        }),
      ]),
      store: new WorkflowRunStore(await makeTempDir("monitor-progress")),
      notificationSink: {
        notify(request) {
          notifications.push(request);
          return { notificationId: "n1", targetSessionId: "s1" };
        },
      },
    });

    const result = await engine.run(monitor, input());

    expect(result.state.updates).toHaveLength(1);
    expect(result.state.updates?.[0]).toMatchObject({ type: "progress", key: "checks" });
    expect(notifications[0]?.content).toContain("Progress: Checks  8/10 checks");
    expect(notifications[0]?.content).toContain("ETA unavailable (needs another progress sample)");
    expect(notifications[0]?.content).toContain("Goal: complete");
  });

  it("paces large progress batches below the engine update limit", async () => {
    const tracks = Array.from({ length: 101 }, (_, index) => ({
      key: `track-${index}`,
      data: progress(1, 2),
    }));
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([check({ progress: { tracks } })]),
      store: new WorkflowRunStore(await makeTempDir("monitor-progress-batch")),
      notificationSink: {
        notify() {
          return { notificationId: "n1", targetSessionId: "s1" };
        },
      },
    });
    const result = await engine.run(monitor, input());

    expect(result.state.status).toBe("completed");
    expect(result.state.updates).toHaveLength(101);
  }, 30_000);

  it("includes the prior observation and progress summary in the next prompt", async () => {
    const prompts: string[] = [];
    const executor = scriptedExecutor([], prompts);
    const checkNode = monitor.nodes.check;
    if (checkNode?.nodeType !== "agent") throw new Error("check must be an agent node");
    const previousCheck = check({ observation: "The target is at 4 of 10." });
    const state = {
      steps: [{ nodeId: "check", outcome: "ok", output: previousCheck }],
    } as never;
    const prompt = await checkNode.prompt({
      input: input(),
      outputs: {
        prepare: prepareMonitorInput(input()),
        check: previousCheck,
        estimate: { tracks: [] },
      },
      results: {},
      state,
      signal: new AbortController().signal,
    });
    expect(prompt).toContain("Perform monitoring check 2 of at most 5");
    expect(prompt).toContain("Previous accepted observation: The target is at 4 of 10.");
    expect(prompt).toContain("You are the regular Pi model running this check");
    expect(prompt).toContain("publish them with workflow action update");
    expect(prompt).toContain("Do not require the monitored target to implement a Pi-specific");
    expect(prompt).toContain("This check itself is observation-only");
    expect(prompt).toContain("action.kind repair is forbidden");
    expect(prompt).toContain("Choose route wait, act, or stop");
    expect(executor).toBeDefined();
  });

  it("requires explicit authorization and details for repair actions", () => {
    const repair = actCheck("repair", {
      workState: "failed",
      observation: "A fixable defect is present.",
      report: "A fixable defect is present.",
      action: actionRequest("repair", {
        incomplete: "Fix the defect",
        nextAction: "Fix the deterministic test failure",
        failureId: "issue-a",
        targetStateId: "units:4-of-5:idle",
      }),
    });
    expect(() => validateMonitorCheck(repair)).toThrow("authorization");
    expect(validateMonitorCheck(repair, true)).toMatchObject({
      route: "act",
      action: { kind: "repair", failureId: "issue-a" },
    });
    expect(() => validateMonitorCheck({ ...repair, action: undefined }, true)).toThrow(
      "requires action details",
    );
    expect(() =>
      validateMonitorCheck(
        waitCheck({
          targetStateId: "units:4-of-5:idle",
          action: actionRequest("repair"),
        }),
      ),
    ).toThrow("only valid for route act");
    expect(() =>
      validateMonitorCheck(
        actCheck("advance", {
          action: actionRequest("advance", {
            authority: {
              ...(actionRequest().authority as Record<string, unknown>),
              status: "outside",
            },
          }),
        }),
      ),
    ).toThrow("unauthorized act cannot mutate");
    expect(() => validateMonitorCheck(check({ goalState: "complete", route: "wait" }))).toThrow(
      "goalState complete requires route stop",
    );
  });

  it("rejects quiet routes, missing reports, duplicate tracks, and unknown fields", () => {
    expect(() => validateMonitorCheck(check({ route: "continue" }))).toThrow("route");
    expect(() => validateMonitorCheck(check({ route: "stop_quiet" }))).toThrow("route");
    const { report: _report, ...withoutReport } = check();
    expect(() => validateMonitorCheck(withoutReport)).toThrow("report");
    expect(() => validateMonitorCheck(check({ extra: true }))).toThrow("not supported");
    expect(() =>
      validateMonitorCheck(
        check({
          progress: {
            tracks: [
              { key: "same", data: progress(1, 2) },
              { key: "same", data: progress(1, 2) },
            ],
          },
        }),
      ),
    ).toThrow("duplicated");
  });

  it("mounts the shared plan change and validates the repair approval policy", () => {
    expect(prepareMonitorInput(input()).repair).toBeUndefined();
    expect(
      prepareMonitorInput(
        input({
          repair: {
            authorized: true,
            scope: "current repo",
            constraints: ["keep API"],
            repository: "/repo",
            baseBranch: "main",
            merge: false,
            approval: { mode: "required", audience: "operator", maxReplans: 4 },
          },
        }),
      ),
    ).toMatchObject({
      repair: {
        authorized: true,
        scope: "current repo",
        constraints: ["keep API"],
        repository: "/repo",
        baseBranch: "main",
        merge: false,
        approval: { mode: "required", audience: "operator", maxReplans: 4 },
      },
    });
    expect(() => prepareMonitorInput(input({ repair: { authorized: false } }))).toThrow(
      "authorized",
    );
    expect(() =>
      prepareMonitorInput(input({ repair: { authorized: true, constraints: "bad" } })),
    ).toThrow("constraints");
    expect(() =>
      prepareMonitorInput(input({ repair: { authorized: true, constraints: [3] } })),
    ).toThrow("constraints");
    expect(() =>
      prepareMonitorInput(input({ repair: { authorized: true, merge: "yes" } })),
    ).toThrow("boolean");
    expect(() =>
      prepareMonitorInput(
        input({
          repair: {
            authorized: true,
            repository: "/repo",
            approval: { mode: "auto", maxReplans: 0 },
          },
        }),
      ),
    ).toThrow("maxReplans");
    expect(() => prepareMonitorInput(input({ repair: { authorized: true } }))).toThrow(
      "repair repository",
    );
    expect(() =>
      prepareMonitorInput(input({ repair: { authorized: true, repository: "relative/repo" } })),
    ).toThrow("absolute path");
    expect(
      prepareMonitorInput(input({ repair: { authorized: true, repository: "/repo" } })),
    ).toMatchObject({
      repair: {
        repository: "/repo",
        approval: {
          mode: "auto",
          audience: "operator",
          timeoutMinutes: 10,
          maxReplans: 3,
        },
      },
    });
    expect(Object.keys(monitor.includes ?? {})).toEqual(["planChange", "implementation"]);
  });

  it("has no presentation prompt, report acknowledgement, or quiet routing", () => {
    expect(monitor.presentationPrompt).toBeUndefined();
    expect(monitor.nodes.report?.nodeType).toBe("notify");
    expect(monitor.nodes.report_continue).toBeUndefined();
    expect(monitor.nodes.report_stop).toBeUndefined();
    expect(JSON.stringify(monitor.edges)).not.toContain("quiet");
    expect(JSON.stringify(monitor.edges)).toContain('"wait":"schedule"');
    expect(JSON.stringify(monitor.edges)).toContain('"advance":"act"');
  });

  it("waits for the next check in-process without a child or node timeout", async () => {
    const sleep = monitor.nodes.sleep;

    expect(sleep?.nodeType).toBe("compute");
    expect(sleep).toHaveProperty("timeoutMs", null);
    expect(sleep).not.toHaveProperty("command");
    expect(sleep).not.toHaveProperty("shell");
    expect(monitor.edges).toContainEqual({ from: "sleep", to: "check" });
    if (sleep?.nodeType !== "compute") throw new Error("sleep must be a compute node");

    await expect(
      sleep.run({
        outputs: {
          prepare: prepareMonitorInput(input()),
          schedule: { nextCheckAt: "not-a-date" },
        },
        signal: new AbortController().signal,
      } as never),
    ).resolves.toEqual({ waitedMinutes: 30, interrupted: true });
    await expect(
      waitForMonitorInterval(Date.now() - 1, new AbortController().signal),
    ).resolves.toEqual({ interrupted: false });

    const abort = new AbortController();
    const waiting = waitForMonitorInterval(Date.now() + 60_000, abort.signal);
    abort.abort(new Error("stop monitor"));
    await expect(waiting).rejects.toThrow("stop monitor");
  });
});

function progress(completed: number, total: number) {
  return {
    schema: "pi-workflows.progress.v1",
    status: "running",
    completed,
    total,
    unit: "items",
  };
}
