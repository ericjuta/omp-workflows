import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attestReviewerRuntime,
  repositoryId,
} from "../src/builtins/autoimplement-command-batches.js";
import autoimplementWorkflow from "../src/builtins/autoimplement.workflow.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { digest } from "../src/workflows/human-decision.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";
const execFileAsync = promisify(execFile);
const ALTERNATE_HEAD_REVISION = "f".repeat(40);
const HEAD_ONE_REVISION = "3".repeat(40);
const HEAD_TWO_REVISION = "4".repeat(40);

let originalPath = "";
let originalHome: string | undefined;
let commandDir = "";
let fallbackCommandDir = "";
let repository = "";
let publishedBaseRevision = "";
let publishedHeadRevision = "";

async function installCommand(name: string, body: string, directory = commandDir): Promise<void> {
  const target = path.join(directory, name);
  await fs.writeFile(target, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function reviewerCommand(cwd = repository) {
  return {
    command: path.join(commandDir, "omp-reviewer"),
    args: ["--base", publishedBaseRevision],
    cwd,
    expectedCommit: publishedHeadRevision,
    timeoutMs: 600_000,
  };
}

function documentedPlan(plan: unknown) {
  return {
    plan,
    documentation: { status: "current" as const, planDigest: digest(plan), documents: [] },
    approval: { mode: "skip" as const },
  };
}

function published(
  headRevision = publishedHeadRevision,
  branch = "feat/demo",
  pr = "https://github.com/example/repository/pull/1",
) {
  return {
    repositories: [
      {
        repository,
        branch,
        baseBranch: "main",
        baseRevision: publishedBaseRevision,
        headRevision,
        pr,
        pushed: true,
      },
    ],
  };
}
function publishedState() {
  return {
    repositories: published().repositories.map(({ pushed: _pushed, ...entry }) => ({
      id: repositoryId(entry.repository),
      ...entry,
    })),
  };
}

function autoimplementWithTimeout(nodeId: string, timeoutMs: number) {
  const node = autoimplementWorkflow.nodes[nodeId];
  if (node === undefined) throw new Error(`autoimplement node is missing: ${nodeId}`);
  return {
    ...autoimplementWorkflow,
    nodes: {
      ...autoimplementWorkflow.nodes,
      [nodeId]: { ...node, timeoutMs },
    },
  };
}
async function reviewerPreparation(): Promise<unknown> {
  const prepare = autoimplementWorkflow.nodes.prepare;
  if (prepare?.nodeType !== "compute") throw new Error("prepare must be compute");
  const output = await prepare.run({
    input: { task: "demo", ...documentedPlan({ steps: ["demo"] }), repository },
    outputs: {},
    results: {},
    state: { steps: [] },
    signal: new AbortController().signal,
  } as never);
  if ((output as { route?: string }).route === "blocked") {
    throw new Error(`reviewer preparation failed: ${JSON.stringify(output)}`);
  }
  return output;
}

function cleanReview(headRevision = publishedHeadRevision) {
  return {
    repositories: [
      {
        id: repositoryId(repository),
        invocationSucceeded: true,
        p0: [],
        p1: [],
        p2: [],
        lower: [],
        reason: `No findings for ${headRevision}.`,
      },
    ],
    reason: "No P0, P1, or P2 findings.",
  };
}

function ciInspection(
  route: "green" | "failed" | "pending" | "unavailable",
  _headRevision = publishedHeadRevision,
  _pr = "https://github.com/example/repository/pull/1",
) {
  return {
    targets: [
      {
        id: repositoryId(repository),
        route,
        reason: route,
        relatedFailures: [],
        unrelatedFailures: [],
        ...(route === "pending"
          ? {
              trackingCommand: {
                command: "gh",
                args: ["pr", "checks", "--watch"],
                timeoutMs: 300_000,
                maxOutputChars: 1_000_000,
              },
            }
          : {}),
      },
    ],
  };
}

function commonExecutor(publication: unknown = published()): ScriptedExecutor {
  return new ScriptedExecutor()
    .respond("implement", {
      output: {
        status: "implemented",
        summary: "implemented",
        files: ["src/change.ts"],
        issueKind: null,
        evidence: "complete",
      },
    })
    .respond("classifyImplementation", {
      output: { route: "verify", summary: "ready", evidence: "implementation complete" },
    })
    .respond("planVerification", {
      output: {
        commands: [
          {
            id: "verify",
            command: "npm",
            args: ["test"],
            cwd: repository,
            timeoutMs: 60_000,
            maxOutputChars: 100_000,
          },
        ],
        untested: [],
      },
    })
    .respond("verify", {
      output: {
        passed: true,
        commands: [{ command: "node verification", outcome: "passed" }],
        failures: [],
        untested: [],
      },
    })
    .respond("classifyVerification", {
      output: { route: "publish", summary: "checks passed", evidence: "npm test" },
    })
    .respond("publish", { output: publication });
}

function continueChallenge(
  reason: string,
  nextAction: string,
  origin:
    | "implementation"
    | "verification"
    | "reviewer"
    | "comments"
    | "ci"
    | "delivery" = "implementation",
  recovery:
    | "redesign"
    | "fix"
    | "planVerification"
    | "repairReviewCommand"
    | "selectReviewCommands"
    | "inspectComments"
    | "inspectCi"
    | "opportunisticTest" = "redesign",
) {
  return {
    route: "continue",
    origin,
    recovery,
    blockingNow: false,
    outsideAuthority: false,
    canProceed: true,
    reason,
    nextAction,
    alternativesChecked: ["Use the supported path", "Keep rollback ready"],
    evidence: ["The task authorizes the required local and rollout work"],
  };
}

function confirmedChallenge(
  reason: string,
  origin:
    | "implementation"
    | "verification"
    | "reviewer"
    | "comments"
    | "ci"
    | "delivery" = "implementation",
  recovery = "redesign",
) {
  return {
    route: "blocked",
    origin,
    recovery,
    blockingNow: true,
    outsideAuthority: true,
    canProceed: false,
    reason,
    nextAction: "",
    alternativesChecked: ["Complete without the prohibited remote mutation"],
    evidence: ["The required external authorization is absent"],
  };
}

function addRedesignResponses(executor: ScriptedExecutor, plans: unknown[]): ScriptedExecutor {
  return executor
    .respond("redesign/design/frame", {
      output: {
        problem: "finish the task",
        success: ["work completes"],
        inScope: ["repository and authorized rollout"],
        outOfScope: ["unapproved remote mutation"],
        constraints: [],
        controlBoundary: "authorized repository and rollout",
      },
    })
    .respond("redesign/design/propose", {
      output: {
        solution: "use the supported path",
        rationale: "it is authorized",
        parts: ["adjust plan", "verify"],
        tradeoffs: [],
      },
    })
    .respond("redesign/design/ideal", {
      output: { ideal: "completed work", outsideDependencies: [], additionalValue: [] },
    })
    .respond("redesign/design/choose", {
      output: {
        status: "ready",
        selected: "use the supported path",
        why: "it completes in scope",
        relationshipToIdeal: "same result",
        excluded: [],
        compromises: [],
      },
    })
    .respond("redesign/design/plan", ...plans.map((plan) => ({ output: plan })))
    .respond("redesign/documentation/inspectDocumentation", {
      output: {
        route: "current",
        files: ["docs/workflows.md"],
        digests: {},
        reason: "The revised plan is documented.",
        evidence: "checked",
      },
    });
}

beforeEach(async () => {
  originalPath = process.env.PATH ?? "";
  originalHome = process.env.HOME;
  commandDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workflows-commands-"));
  fallbackCommandDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workflows-fallback-commands-"));
  repository = await makeTempDir("pi-workflows-autoimplement-repo");
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: repository,
  });
  const trackedFile = path.join(repository, "tracked.txt");
  await fs.writeFile(trackedFile, "base\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: repository });
  await execFileAsync("git", ["commit", "-q", "-m", "base"], { cwd: repository });
  publishedBaseRevision = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim();
  await execFileAsync("git", ["checkout", "-q", "-b", "feat/demo"], { cwd: repository });
  await fs.writeFile(trackedFile, "published\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: repository });
  await execFileAsync("git", ["commit", "-q", "-m", "published"], { cwd: repository });
  publishedHeadRevision = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim();
  await installCommand("omp", "exit 0", fallbackCommandDir);
  await installCommand("omp-reviewer", "printf '%s\\n' \"review complete\"");
  await installCommand("gh", "printf '%s\\n' \"checks complete\"");
  process.env.PATH = `${commandDir}:${originalPath}:${fallbackCommandDir}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("built-in autoimplement", () => {
  it("validates input, reviewer severities, repair commands, and CI tracking", async () => {
    const parseInput = autoimplementWorkflow.input;
    if (parseInput === undefined) throw new Error("autoimplement input parser is missing");
    expect(() => parseInput({ task: "demo" })).toThrow(/repository/);
    expect(await parseInput({ task: "demo", repository })).toMatchObject({
      task: "demo",
      repository,
      merge: false,
      approval: {
        mode: "auto",
        audience: "operator",
        timeoutMinutes: 10,
        maxReplans: 3,
      },
    });
    expect(
      await parseInput({
        task: "demo",
        plan: {},
        scope: "repo",
        constraints: ["keep API"],
        repository,
        baseBranch: "main",
        merge: false,
      }),
    ).toMatchObject({ task: "demo", scope: "repo", merge: false });
    expect(() => parseInput(null)).toThrow("object");
    expect(() => parseInput({ task: "" })).toThrow("non-empty");
    expect(() => parseInput({ task: "demo", constraints: "bad" })).toThrow("constraints");
    expect(() => parseInput({ task: "demo", constraints: [3] })).toThrow("constraints");
    expect(() => parseInput({ task: "demo", merge: "yes" })).toThrow("boolean");
    expect(() => parseInput({ task: "demo", repository: "relative/repository" })).toThrow(
      /absolute/,
    );
    for (const baseBranch of ["--all", "HEAD~1", "main..next", "main@{1}"]) {
      expect(() => parseInput({ task: "demo", repository, baseBranch })).toThrow(/Git ref|dash/);
    }
    expect(() =>
      parseInput({
        task: "demo",
        documentation: { status: "current", planDigest: digest({}), documents: [] },
      }),
    ).toThrow("requires an explicit plan");
    expect(() =>
      parseInput({
        task: "demo",
        plan: {},
        documentation: { status: "current", planDigest: "sha256:wrong", documents: [] },
      }),
    ).toThrow("does not match");

    const validate = async (
      nodeId: string,
      output: unknown,
      overrides: Record<string, unknown> = {},
    ) => {
      const node = autoimplementWorkflow.nodes[nodeId];
      if (node?.nodeType !== "agent" || node.validate === undefined) {
        throw new Error(`${nodeId} must be a validated agent node`);
      }
      return await node.validate(output, {
        input: { task: "demo", plan: {}, repository },
        outputs: {},
        results: {},
        state: { steps: [] },
        signal: new AbortController().signal,
        ...overrides,
      } as never);
    };

    const normalizedPublished = {
      id: repositoryId(repository),
      repository,
      branch: "feat/demo",
      baseBranch: "main",
      baseRevision: publishedBaseRevision,
      headRevision: publishedHeadRevision,
      pr: "https://github.com/example/repository/pull/1",
    };
    const reviewSelection = {
      route: "run",
      repositories: [normalizedPublished],
      commands: [reviewerCommand()],
    };
    const reviewExecution = {
      route: "assess",
      batch: {
        schema: "pi-workflows.command-batch-result.v1",
        items: [{ id: normalizedPublished.id, outcome: "succeeded", exitCode: 0 }],
        completed: 1,
        total: 1,
      },
    };
    const reviewContext = {
      outputs: { selectReviewCommands: reviewSelection, runReview: reviewExecution },
      state: {
        steps: [
          { nodeId: "selectReviewCommands", output: reviewSelection },
          { nodeId: "runReview", output: reviewExecution },
        ],
      },
    };
    await expect(
      validate(
        "assessReview",
        {
          repositories: [
            {
              id: normalizedPublished.id,
              invocationSucceeded: true,
              p0: [{ kind: "design", summary: "P0 design" }],
              p1: [{ kind: "implementation", summary: "P1 code" }],
              p2: [{ kind: "implementation", summary: "P2 code" }],
              lower: [{ kind: "implementation", summary: "lower" }],
              reason: "findings",
            },
          ],
          reason: "findings",
        },
        reviewContext,
      ),
    ).resolves.toMatchObject({ route: "critical", p0: [{ severity: "P0" }] });
    await expect(
      validate(
        "assessReview",
        {
          repositories: [
            {
              id: normalizedPublished.id,
              invocationSucceeded: false,
              p0: [],
              p1: [],
              p2: [],
              lower: [],
              reason: "invalid invocation",
            },
          ],
          reason: "invalid invocation",
        },
        reviewContext,
      ),
    ).resolves.toMatchObject({ route: "command_error" });
    await expect(
      validate("assessReview", { repositories: "bad", reason: "bad" }, reviewContext),
    ).rejects.toThrow("must be an array");
    await expect(
      validate(
        "assessReview",
        {
          repositories: [
            {
              id: "unexpected",
              invocationSucceeded: true,
              p0: [],
              p1: [],
              p2: [],
              lower: [],
              reason: "bad",
            },
          ],
          reason: "bad",
        },
        reviewContext,
      ),
    ).rejects.toThrow("was not in the batch");
    await expect(
      validate(
        "assessReview",
        {
          repositories: [
            {
              id: normalizedPublished.id,
              invocationSucceeded: true,
              p0: "bad",
              p1: [],
              p2: [],
              lower: [],
              reason: "bad",
            },
          ],
          reason: "bad",
        },
        reviewContext,
      ),
    ).rejects.toThrow("p0 must be an array");
    await expect(
      validate("assessReview", { repositories: [], reason: "bad" }, reviewContext),
    ).rejects.toThrow("missing repository ids");

    const selectReview = autoimplementWorkflow.nodes.selectReviewCommands;
    if (selectReview?.nodeType !== "compute") {
      throw new Error("selectReviewCommands must be a compute node");
    }
    const reviewedRepository = {
      ...normalizedPublished,
      invocationSucceeded: true,
    };
    const reviewPreparation = await reviewerPreparation();
    const reviewSelectionContext = (overrides: Record<string, unknown>) =>
      ({
        input: { task: "demo", plan: {} },
        results: {},
        state: { steps: [] },
        signal: new AbortController().signal,
        ...overrides,
        outputs: {
          prepare: reviewPreparation,
          ...(overrides.outputs as Record<string, unknown> | undefined),
        },
      }) as never;
    expect(
      await selectReview.run(
        reviewSelectionContext({
          outputs: { publish: { repositories: [normalizedPublished] } },
          state: {
            steps: [
              {
                nodeId: "assessReview",
                outcome: "ok",
                output: { repositories: [reviewedRepository] },
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ route: "reuse", repositories: [] });
    expect(
      await selectReview.run(
        reviewSelectionContext({
          outputs: { publish: { repositories: [normalizedPublished] } },
          state: {
            steps: [
              {
                nodeId: "assessReview",
                outcome: "ok",
                output: {
                  repositories: [{ ...reviewedRepository, invocationSucceeded: false }],
                },
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ route: "run", repositories: [normalizedPublished] });
    const changedHead = { ...normalizedPublished, headRevision: ALTERNATE_HEAD_REVISION };
    expect(
      await selectReview.run(
        reviewSelectionContext({
          outputs: { publish: { repositories: [changedHead] } },
          state: {
            steps: [
              {
                nodeId: "assessReview",
                outcome: "ok",
                output: { repositories: [reviewedRepository] },
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ route: "run", repositories: [changedHead] });
    const changedBase = { ...normalizedPublished, baseRevision: ALTERNATE_HEAD_REVISION };
    expect(
      await selectReview.run(
        reviewSelectionContext({
          outputs: { publish: { repositories: [changedBase] } },
          state: {
            steps: [
              {
                nodeId: "assessReview",
                outcome: "ok",
                output: { repositories: [reviewedRepository] },
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ route: "run", repositories: [changedBase] });

    await expect(
      validate("repairReviewCommand", { route: "blocked", reason: "reviewer missing" }),
    ).resolves.toMatchObject({ route: "blocked" });
    await expect(
      validate("repairCiCommand", { route: "blocked", reason: "CI unavailable" }),
    ).resolves.toMatchObject({ route: "blocked" });
    await expect(
      validate("inspectCi", ciInspection("pending"), {
        outputs: { publish: { repositories: [normalizedPublished] } },
      }),
    ).resolves.toMatchObject({ route: "pending", targets: [{ route: "pending" }] });
    await expect(
      validate(
        "inspectCi",
        { targets: [{ repository, route: "pending" }] },
        {
          outputs: { publish: { repositories: [normalizedPublished] } },
        },
      ),
    ).rejects.toThrow();
    await expect(
      validate(
        "inspectCi",
        {
          targets: [
            {
              ...ciInspection("green").targets[0],
              id: "not-published",
            },
          ],
        },
        {
          outputs: { publish: { repositories: [normalizedPublished] } },
        },
      ),
    ).rejects.toThrow("not a published repository");
    const additionalPublished = {
      ...normalizedPublished,
      id: repositoryId(path.join(repository, "additional")),
      repository: path.join(repository, "additional"),
      pr: "https://github.com/example/repository/pull/3",
    };
    await expect(
      validate("inspectCi", ciInspection("green"), {
        outputs: { publish: { repositories: [normalizedPublished, additionalPublished] } },
      }),
    ).rejects.toThrow("missing repository ids");

    const refreshedPublished = {
      ...normalizedPublished,
      headRevision: ALTERNATE_HEAD_REVISION,
    };
    await expect(
      validate(
        "verifyP2",
        {
          passed: true,
          commands: [{ command: "npm test", outcome: "passed" }],
          pushed: true,
          repositories: [{ ...refreshedPublished, pushed: true }],
        },
        { outputs: { publish: { repositories: [normalizedPublished] } } },
      ),
    ).resolves.toMatchObject({ repositories: [{ headRevision: ALTERNATE_HEAD_REVISION }] });
    await expect(
      validate(
        "verifyP2",
        {
          passed: true,
          commands: [],
          pushed: true,
        },
        { outputs: { publish: { repositories: [normalizedPublished] } } },
      ),
    ).rejects.toThrow("repositories");
    await expect(
      validate(
        "verifyP2",
        {
          passed: "yes",
          pushed: true,
          repositories: [{ ...refreshedPublished, pushed: true }],
        },
        { outputs: { publish: { repositories: [normalizedPublished] } } },
      ),
    ).rejects.toThrow("passed must be a boolean");
    await expect(
      validate(
        "verifyP2",
        {
          passed: true,
          pushed: false,
          repositories: [{ ...refreshedPublished, pushed: true }],
        },
        { outputs: { publish: { repositories: [normalizedPublished] } } },
      ),
    ).rejects.toThrow("pushed must be true");
    await expect(
      validate(
        "verifyP2",
        {
          passed: true,
          pushed: true,
          repositories: [{ ...refreshedPublished, branch: "other", pushed: true }],
        },
        { outputs: { publish: { repositories: [normalizedPublished] } } },
      ),
    ).rejects.toThrow("does not match publication");
    const secondPublished = {
      ...normalizedPublished,
      id: repositoryId(path.join(repository, "second")),
      repository: path.join(repository, "second"),
      pr: "https://github.com/example/repository/pull/2",
    };
    await expect(
      validate(
        "verifyP2",
        {
          passed: true,
          pushed: true,
          repositories: [{ ...refreshedPublished, pushed: true }],
        },
        {
          outputs: {
            publish: { repositories: [normalizedPublished, secondPublished] },
          },
        },
      ),
    ).rejects.toThrow("missing repository ids");

    const pendingInspection = ciInspection("pending");
    const trackedInspection = {
      ...pendingInspection,
      targets: pendingInspection.targets.map((target) => ({
        ...target,
        id: normalizedPublished.id,
      })),
    };
    const trackedContext = {
      outputs: {
        inspectCi: trackedInspection,
        trackCi: {
          route: "assess",
          batch: { items: [{ id: normalizedPublished.id }] },
        },
      },
    };
    await expect(
      validate(
        "assessTrackedCi",
        {
          route: "green",
          reason: "green",
          targets: [],
          relatedFailures: [],
          unrelatedFailures: [],
        },
        trackedContext,
      ),
    ).rejects.toThrow("exactly cover watched ids");
    await expect(
      validate(
        "assessTrackedCi",
        {
          route: "green",
          reason: "green",
          targets: [{ id: normalizedPublished.id, route: "pending", reason: "still pending" }],
          relatedFailures: [],
          unrelatedFailures: [],
        },
        trackedContext,
      ),
    ).rejects.toThrow("route must be pending");
    await expect(
      validate(
        "assessTrackedCi",
        {
          route: "pending",
          reason: "still pending",
          targets: [{ id: normalizedPublished.id, route: "pending", reason: "still pending" }],
          relatedFailures: [],
          unrelatedFailures: [],
        },
        trackedContext,
      ),
    ).resolves.toMatchObject({ route: "pending", targets: [{ id: normalizedPublished.id }] });
    await expect(
      validate(
        "assessTrackedCi",
        { route: "pending", reason: "pending", targets: "bad" },
        trackedContext,
      ),
    ).rejects.toThrow("targets must be an array");
    await expect(
      validate(
        "assessTrackedCi",
        {
          route: "pending",
          reason: "pending",
          targets: [
            { id: normalizedPublished.id, route: "pending", reason: "pending" },
            { id: normalizedPublished.id, route: "pending", reason: "pending" },
          ],
        },
        trackedContext,
      ),
    ).rejects.toThrow("duplicated");
    await expect(
      validate(
        "assessTrackedCi",
        {
          route: "pending",
          reason: "pending",
          targets: [{ id: "unexpected", route: "pending", reason: "pending" }],
        },
        trackedContext,
      ),
    ).rejects.toThrow("unexpected: unexpected");
    await expect(
      validate(
        "assessTrackedCi",
        {
          route: "pending",
          reason: "pending",
          targets: [{ id: normalizedPublished.id, route: "unknown", reason: "unknown" }],
        },
        trackedContext,
      ),
    ).rejects.toThrow("route is invalid");
    for (const route of ["green", "failed", "unavailable"] as const) {
      await expect(
        validate(
          "assessTrackedCi",
          {
            route,
            reason: route,
            targets: [{ id: normalizedPublished.id, route, reason: route }],
          },
          trackedContext,
        ),
      ).resolves.toMatchObject({ route, relatedFailures: [], unrelatedFailures: [] });
    }
    await expect(
      validate(
        "assessTrackedCi",
        {
          route: "pending",
          reason: "pending",
          targets: [
            { id: normalizedPublished.id, route: "pending", reason: "pending" },
            { id: "unexpected", route: "pending", reason: "pending" },
          ],
        },
        trackedContext,
      ),
    ).rejects.toThrow("unexpected: unexpected");
    await expect(
      validate(
        "assessTrackedCi",
        {
          route: "green",
          reason: "green",
          targets: [{ id: normalizedPublished.id, route: "green", reason: "green" }],
          relatedFailures: "bad",
          unrelatedFailures: [],
        },
        trackedContext,
      ),
    ).rejects.toThrow("relatedFailures must be an array");

    await expect(
      validate(
        "planVerification",
        {
          commands: [
            {
              id: "unsafe",
              command: "bash",
              args: ["-c", "npm test"],
              cwd: repository,
              timeoutMs: 1_000,
              maxOutputChars: 1_000,
            },
          ],
          untested: [],
        },
        {
          input: { task: "demo", plan: {}, repository },
          outputs: { implement: { repositories: [repository] } },
        },
      ),
    ).rejects.toThrow("not allowed");
    const safeVerification = {
      commands: [
        {
          id: "verify",
          command: "npm",
          args: ["test"],
          cwd: repository,
          timeoutMs: 1_000,
          maxOutputChars: 1_000,
        },
      ],
      untested: [],
    };
    await expect(
      validate("planVerification", safeVerification, {
        input: { task: "demo", plan: {}, repository },
        outputs: { implement: { repositories: [repository] } },
      }),
    ).resolves.toMatchObject({ commands: [{ id: "verify" }] });
    await expect(
      validate("planVerification", safeVerification, {
        input: { task: "demo", plan: {}, repository },
        outputs: { implement: { repositories: [] } },
      }),
    ).rejects.toThrow(/provenance/);
    await expect(
      validate(
        "planVerification",
        {
          ...safeVerification,
          commands: [
            safeVerification.commands[0]!,
            { ...safeVerification.commands[0]!, id: "verify-second" },
          ],
        },
        {
          input: { task: "demo", plan: {}, repository },
          outputs: { implement: { repositories: [repository] } },
        },
      ),
    ).resolves.toMatchObject({ commands: [{ id: "verify" }, { id: "verify-second" }] });
    await expect(
      validate(
        "planVerification",
        {
          ...safeVerification,
          commands: [{ ...safeVerification.commands[0]!, cwd: path.join(repository, "other") }],
        },
        {
          input: { task: "demo", plan: {}, repository },
          outputs: { implement: { repositories: [repository] } },
        },
      ),
    ).rejects.toThrow("must match the target repository");
    await expect(
      validate("planVerification", safeVerification, {
        input: { task: "demo", plan: {}, repository },
        outputs: {
          implement: { repositories: [repository, path.join(repository, "second")] },
        },
      }),
    ).rejects.toThrow("provenance");
    const implementation = {
      status: "implemented",
      summary: "implemented",
      files: ["src/change.ts"],
      repositories: [repository],
      issueKind: null,
      evidence: "complete",
    };
    await expect(
      validate("implement", implementation, {
        input: { task: "demo", plan: {}, repository },
      }),
    ).resolves.toMatchObject({ repository, repositories: [repository] });
    await expect(
      validate(
        "implement",
        { ...implementation, repositories: [path.join(repository, "other")] },
        {
          input: { task: "demo", plan: {}, repository },
        },
      ),
    ).rejects.toThrow(/contain only/);
    await expect(
      validate(
        "implement",
        { ...implementation, files: ["../escape.ts"] },
        {
          input: { task: "demo", plan: {}, repository },
        },
      ),
    ).rejects.toThrow(/stay inside/);
    await expect(
      validate("publish", published(), {
        input: { task: "demo", plan: {}, repository },
      }),
    ).resolves.toMatchObject({ repositories: [{ repository }] });
    await expect(
      validate(
        "publish",
        {
          repositories: [
            ...published().repositories,
            { ...published().repositories[0]!, repository: path.join(repository, "other") },
          ],
        },
        {
          input: { task: "demo", plan: {}, repository },
        },
      ),
    ).rejects.toThrow(/contain only/);
    await expect(
      validate("repairReviewCommand", { route: "unknown", reason: "bad" }),
    ).rejects.toThrow("one of retry, blocked");
    await expect(validate("repairCiCommand", { route: "unknown", reason: "bad" })).rejects.toThrow(
      "one of retry, blocked",
    );
    const challengeContext = {
      outputs: {
        challengeBlockerGuard: {
          route: "challenge",
          origin: "implementation",
          recoveries: ["redesign", "fix"],
        },
      },
    };
    await expect(
      validate(
        "challengeBlocker",
        continueChallenge("rollout is authorized", "deploy safely"),
        challengeContext,
      ),
    ).resolves.toMatchObject({ route: "continue", canProceed: true });
    await expect(
      validate(
        "challengeBlocker",
        confirmedChallenge("external authorization is required"),
        challengeContext,
      ),
    ).resolves.toMatchObject({ route: "blocked", outsideAuthority: true });
    await expect(
      validate(
        "challengeBlocker",
        { ...confirmedChallenge("contradictory blocker"), canProceed: true },
        challengeContext,
      ),
    ).rejects.toThrow("blocked challenge requires");
    await expect(
      validate(
        "challengeBlocker",
        { ...continueChallenge("no next action", "deploy safely"), nextAction: "" },
        challengeContext,
      ),
    ).rejects.toThrow("practical nextAction");
    await expect(
      validate(
        "challengeBlocker",
        {
          ...continueChallenge("wrong origin", "retry review"),
          origin: "reviewer",
          recovery: "selectReviewCommands",
        },
        challengeContext,
      ),
    ).rejects.toThrow("origin must match");
    await expect(
      validate("inspectComments", { route: "unknown", summary: "bad", evidence: [] }),
    ).rejects.toThrow("route must be one of");
    await expect(
      validate("assessReview", {
        invocationSucceeded: true,
        p0: "bad",
        p1: [],
        p2: [],
        lower: [],
        reason: "bad",
      }),
    ).rejects.toThrow("must be an array");
  });

  it("normalizes repository input to an absolute path", async () => {
    const parseInput = autoimplementWorkflow.input;
    if (parseInput === undefined) throw new Error("autoimplement input parser is missing");

    const unnormalized = `${repository}${path.sep}nested${path.sep}..`;
    expect(parseInput({ task: "demo", repository: unnormalized })).toMatchObject({
      repository: path.resolve(repository),
    });
    expect(() => parseInput({ task: "demo", repository: "relative/repository" })).toThrow(
      /absolute/,
    );
  });

  it("pins mutating stages to the prepared repository and preserves ignored files", async () => {
    const input = { task: "demo", plan: { step: "change" }, repository };
    const context = {
      input,
      outputs: {
        implement: {
          status: "implemented",
          files: ["src/change.ts"],
          repositories: [repository],
        },
        runReview: { route: "repair", batch: { items: [] } },
        trackCi: { route: "repair", batch: { items: [] } },
      },
      results: {},
      state: {
        steps: [
          {
            nodeId: "classifyImplementation",
            outcome: "ok",
            output: { route: "fix", evidence: "repair current change" },
          },
        ],
      },
      signal: new AbortController().signal,
    } as never;
    for (const nodeId of [
      "implement",
      "planVerification",
      "fix",
      "publish",
      "repairReviewCommand",
      "verifyP2",
      "repairCiCommand",
      "opportunisticTest",
    ]) {
      const node = autoimplementWorkflow.nodes[nodeId];
      if (node?.nodeType !== "agent") throw new Error(`${nodeId} must be an agent`);
      const prompt = await node.prompt(context);
      expect(prompt, nodeId).toContain(`Prepared repository: ${repository}`);
      expect(prompt, nodeId).toContain(`Run every repository command from exactly ${repository}`);
      expect(prompt, nodeId).toContain("Preserve every pre-existing untracked and ignored file");
      expect(prompt, nodeId).toContain("Never run git clean");
    }
  });

  it("projects redesign evidence, plan changes, blocked reasons, and command history", async () => {
    const makeContext = (overrides: Record<string, unknown> = {}) =>
      ({
        outputs: {},
        results: {},
        state: { steps: [] },
        signal: new AbortController().signal,
        ...overrides,
        input: {
          task: "demo",
          scope: "repo",
          constraints: ["safe"],
          plan: { old: true },
          repository,
          ...(overrides.input as Record<string, unknown> | undefined),
        },
      }) as never;

    const redesign = autoimplementWorkflow.includes?.redesign;
    if (redesign?.input === undefined) throw new Error("redesign input mapper is missing");
    expect(
      await redesign.input(
        makeContext({
          outputs: { adoptPlan: { plan: { revised: true } } },
          state: {
            steps: [
              {
                nodeId: "classifyVerification",
                output: { route: "redesign", evidence: "new failure" },
              },
            ],
          },
        }),
      ),
    ).toMatchObject({
      task: "demo",
      scope: "repo",
      constraints: ["safe"],
      previousPlan: { revised: true },
      newEvidence: { route: "redesign", evidence: "new failure" },
      approval: { mode: "auto", audience: "operator", timeoutMinutes: 10 },
    });

    const documented = {
      exit: "ready",
      output: {
        status: "ready",
        task: "demo",
        plan: { old: true },
        planDigest: digest({ old: true }),
        documentation: {
          state: "current",
          files: ["docs/current-plan.md"],
          digests: {},
          evidence: null,
        },
        verification: { passed: true },
      },
    };
    expect(
      await redesign.input(makeContext({ outputs: { documentation: documented } })),
    ).toMatchObject({
      previousPlan: { old: true },
      documentation: {
        status: "current",
        planDigest: digest({ old: true }),
        documents: ["docs/current-plan.md"],
      },
    });

    const adopt = autoimplementWorkflow.nodes.adoptPlan;
    if (adopt?.nodeType !== "compute") throw new Error("adoptPlan must be compute");
    const ready = {
      exit: "ready",
      output: {
        status: "ready",
        plan: { revised: true },
        planDigest: "sha256:plan",
        documents: ["docs/plan.md"],
        revision: 1,
        approval: { provenance: "skipped", revision: 1 },
        documentation: { state: "current", files: ["docs/plan.md"], digests: {}, evidence: null },
      },
    };
    expect(await adopt.run(makeContext({ outputs: { redesign: ready } }))).toMatchObject({
      plan: { revised: true },
      planDigest: "sha256:plan",
      documents: ["docs/plan.md"],
    });
    expect(() =>
      adopt.run(
        makeContext({ outputs: { redesign: { exit: "blocked", output: { reason: "no plan" } } } }),
      ),
    ).toThrow("ready plan");

    const blocked = autoimplementWorkflow.nodes.blocked;
    if (blocked?.nodeType !== "compute") throw new Error("blocked must be compute");
    expect(
      await blocked.run(
        makeContext({
          state: {
            steps: [
              { nodeId: "other", output: {} },
              { nodeId: "classifyCi", output: { blocker: "CI blocked" } },
            ],
          },
        }),
      ),
    ).toMatchObject({ reason: "CI blocked" });
    expect(await blocked.run(makeContext())).toMatchObject({
      reason: "Autoimplementation could not continue within the authorized scope.",
    });

    const track = autoimplementWorkflow.nodes.trackCi;
    if (track?.nodeType !== "action" || !("run" in track)) {
      throw new Error("trackCi must be a function action");
    }
    const pendingTarget = ciInspection("pending").targets[0]!;
    const pending = {
      route: "pending",
      reason: `${pendingTarget.id}: pending`,
      relatedFailures: [],
      unrelatedFailures: [],
      targets: [
        {
          ...pendingTarget,
          repository,
          headRevision: publishedHeadRevision,
          pr: "https://github.com/example/repository/pull/1",
          trackingCommand: {
            ...pendingTarget.trackingCommand!,
            id: pendingTarget.id,
            cwd: repository,
          },
        },
      ],
    };
    expect(
      await track.run(
        makeContext({
          input: { task: "demo", concurrency: { reviewer: 1, ciWatch: 1, verification: 1 } },
          outputs: { inspectCi: { ...pending } },
          publishUpdate: async () => ({ updateId: "u1", seq: 1, at: "now", type: "x", key: "y" }),
        }),
      ),
    ).toMatchObject({ route: "assess", batch: { items: [{ id: repositoryId(repository) }] } });

    await installCommand("gh", "printf '%s\\n' 'checks failed'; exit 1");
    expect(
      await track.run(
        makeContext({
          input: { task: "demo", concurrency: { reviewer: 1, ciWatch: 1, verification: 1 } },
          outputs: { inspectCi: { ...pending } },
          publishUpdate: async () => ({ updateId: "u2", seq: 2, at: "now", type: "x", key: "y" }),
        }),
      ),
    ).toMatchObject({
      route: "assess",
      batch: { items: [{ outcome: "failed", exitCode: 1 }] },
    });

    const review = autoimplementWorkflow.nodes.runReview;
    if (review?.nodeType !== "action" || !("run" in review)) {
      throw new Error("runReview must be a function action");
    }
    await installCommand("omp-reviewer", "printf '%s\\n' 'P1 finding'; exit 1");
    const reviewerRuntime = attestReviewerRuntime();
    const reviewerExecutable = reviewerRuntime.reviewer?.executable;
    if (reviewerExecutable === undefined) throw new Error("reviewer fixture was not attested");
    expect(
      await review.run(
        makeContext({
          input: { task: "demo", concurrency: { reviewer: 1, ciWatch: 1, verification: 1 } },
          outputs: {
            selectReviewCommands: {
              route: "run",
              reviewerRuntime,
              repositories: [
                {
                  id: repositoryId(repository),
                  repository,
                  branch: "feat/demo",
                  baseBranch: "main",
                  baseRevision: publishedBaseRevision,
                  headRevision: publishedHeadRevision,
                  pr: "https://github.com/example/repository/pull/1",
                },
              ],
              commands: [
                {
                  id: repositoryId(repository),
                  command: reviewerExecutable,
                  args: ["--base", "main"],
                  cwd: repository,
                  timeoutMs: 600_000,
                  maxOutputChars: 1_000_000,
                  ...reviewerRuntime.reviewerEnvironment,
                },
              ],
            },
          },
          publishUpdate: async () => ({ updateId: "u1", seq: 1, at: "now", type: "x", key: "y" }),
        }),
      ),
    ).toMatchObject({
      route: "assess",
      batch: { items: [{ outcome: "failed", exitCode: 1, stdout: "P1 finding\n" }] },
    });

    const delivery = autoimplementWorkflow.nodes.finalizeDelivery;
    if (delivery?.nodeType !== "agent") throw new Error("finalizeDelivery must be agent");
    expect(
      await delivery.prompt(
        makeContext({
          input: { task: "demo", merge: false },
          outputs: { publish: publishedState() },
        }),
      ),
    ).toContain("without merging");
    expect(
      await delivery.prompt(
        makeContext({
          input: { task: "demo", merge: true },
          outputs: { publish: publishedState() },
        }),
      ),
    ).toContain("merge each");
    expect(() => delivery.validate?.({ status: "invalid" }, makeContext())).toThrow(
      "delivery status",
    );
    expect(() =>
      delivery.validate?.(
        { status: "completed", merged: true, reason: "merged" },
        makeContext({ input: { task: "demo", merge: false } }),
      ),
    ).toThrow("explicit merge: true");
    expect(
      delivery.validate?.(
        {
          status: "completed",
          merged: false,
          pr: "https://github.com/example/repository/pull/1",
          reportComment: "done",
          reason: "ready",
        },
        makeContext({
          input: { task: "demo", merge: false },
          outputs: { publish: publishedState() },
        }),
      ),
    ).toMatchObject({ repositories: [{ repository, merged: false }] });

    const secondRepository = path.join(path.dirname(repository), "second-repository");
    const multiPublication = {
      repositories: [
        ...publishedState().repositories,
        {
          id: repositoryId(secondRepository),
          repository: secondRepository,
          branch: "feat/second",
          baseBranch: "main",
          baseRevision: publishedBaseRevision,
          headRevision: ALTERNATE_HEAD_REVISION,
          pr: "https://github.com/example/repository/pull/2",
          pushed: true,
        },
      ],
    };
    expect(() =>
      delivery.validate?.(
        {
          status: "completed",
          merged: false,
          pr: "https://github.com/example/repository/pull/1",
          reportComment: "done",
          reason: "ready",
          repositories: [
            {
              id: repositoryId(repository),
              merged: false,
              reportComment: "done",
              reason: "ready",
            },
          ],
        },
        makeContext({
          input: { task: "demo", merge: false },
          outputs: { publish: multiPublication },
        }),
      ),
    ).toThrow("does not match published repository and PR");
    const assessment = autoimplementWorkflow.nodes.assessReview;
    const recovery = autoimplementWorkflow.nodes.recoverReviewAssessment;
    if (assessment?.nodeType !== "agent" || recovery?.nodeType !== "agent") {
      throw new Error("review assessment nodes must be agents");
    }
    const hugeOutput = "review output ".repeat(10_000);
    const reviewRepositories = Array.from({ length: 64 }, (_, index) => {
      const repositoryPath = path.join(
        path.dirname(repository),
        `projected-repository-${index}-${"long-path-segment-".repeat(24)}`,
      );
      return {
        id: repositoryId(repositoryPath),
        repository: repositoryPath,
        branch: `feat/projected-${index}`,
        baseBranch: "main",
        baseRevision: publishedBaseRevision,
        headRevision: `head-${index}`,
        pr: `https://github.com/example/repository/pull/${index + 10}`,
      };
    });
    const reviewSelection = {
      route: "run",
      repositories: reviewRepositories,
      commands: reviewRepositories.map((entry) => reviewerCommand(entry.repository)),
    };
    const persistedReview = {
      route: "assess",
      batch: {
        schema: "pi-workflows.command-batch-result.v1",
        completed: reviewRepositories.length,
        total: reviewRepositories.length,
        items: reviewRepositories.map((entry) => ({
          id: entry.id,
          outcome: "succeeded",
          exitCode: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdout: hugeOutput,
          stderr: hugeOutput,
        })),
      },
    };
    const promptContext = makeContext({
      outputs: { selectReviewCommands: reviewSelection, runReview: persistedReview },
    });
    const assessmentPrompt = await assessment.prompt(promptContext);
    const recoveryPrompt = await recovery.prompt(promptContext);
    expect(assessmentPrompt.length).toBeLessThan(40_000);
    expect(recoveryPrompt.length).toBeLessThan(40_000);
    expect(assessmentPrompt).toContain("[TRUNCATED");
    expect(recoveryPrompt).toContain("[TRUNCATED");
    expect(assessmentPrompt).toContain(`"completed":${reviewRepositories.length}`);
    expect(recoveryPrompt).toContain(`"total":${reviewRepositories.length}`);
    for (const entry of reviewRepositories) {
      expect(assessmentPrompt).toContain(entry.id);
      expect(recoveryPrompt).toContain(entry.id);
    }
    const inspectCi = autoimplementWorkflow.nodes.inspectCi;
    if (inspectCi?.nodeType !== "agent") throw new Error("inspectCi must be an agent");
    const publishedContext = makeContext({
      input: { task: "demo", merge: false },
      outputs: { publish: { repositories: reviewRepositories } },
    });
    const ciPrompt = await inspectCi.prompt(publishedContext);
    const deliveryPrompt = await delivery.prompt(publishedContext);
    expect(ciPrompt.length).toBeLessThan(32_000);
    expect(deliveryPrompt.length).toBeLessThan(32_000);
    for (const entry of reviewRepositories) {
      expect(ciPrompt).toContain(entry.id);
      expect(ciPrompt).toContain(entry.pr);
      expect(ciPrompt).not.toContain(entry.repository);
      expect(deliveryPrompt).toContain(entry.id);
      expect(deliveryPrompt).toContain(entry.pr);
      expect(deliveryPrompt).not.toContain(entry.repository);
    }
    const ciResult = await inspectCi.validate?.(
      {
        targets: reviewRepositories.map((entry) => ({
          id: entry.id,
          route: "green",
          reason: "green",
          relatedFailures: [],
          unrelatedFailures: [],
        })),
      },
      publishedContext,
    );
    expect(ciResult).toMatchObject({
      targets: reviewRepositories.map((entry) => ({
        repository: entry.repository,
        headRevision: entry.headRevision,
        pr: entry.pr,
      })),
    });
    const deliveryResult = await delivery.validate?.(
      {
        status: "completed",
        merged: false,
        reportComment: "report-0",
        reason: "ready",
        repositories: reviewRepositories.map((entry, index) => ({
          id: entry.id,
          merged: false,
          reportComment: `report-${index}`,
          reason: "ready",
        })),
      },
      publishedContext,
    );
    expect(deliveryResult).toMatchObject({
      pr: reviewRepositories[0]!.pr,
      repositories: reviewRepositories.map((entry) => ({
        repository: entry.repository,
        pr: entry.pr,
      })),
    });
    const cleanRepositories = reviewRepositories.map((entry) => ({
      id: entry.id,
      invocationSucceeded: true,
      p0: [],
      p1: [],
      p2: [],
      lower: [],
      reason: "clean",
    }));
    expect(
      await assessment.validate?.(
        { repositories: cleanRepositories, reason: "all clean" },
        promptContext,
      ),
    ).toMatchObject({ route: "clean", repositories: cleanRepositories });
    expect(
      await recovery.validate?.(
        { repositories: cleanRepositories, reason: "all clean" },
        promptContext,
      ),
    ).toMatchObject({ route: "clean", repositories: cleanRepositories });
    expect(persistedReview.batch.items).toHaveLength(reviewRepositories.length);
    for (const item of persistedReview.batch.items) {
      expect(item.stdout).toHaveLength(140_000);
      expect(item.stderr).toHaveLength(140_000);
    }
    const challenge = autoimplementWorkflow.nodes.challengeBlocker;
    const fix = autoimplementWorkflow.nodes.fix;
    const implement = autoimplementWorkflow.nodes.implement;
    if (
      challenge?.nodeType !== "agent" ||
      fix?.nodeType !== "agent" ||
      implement?.nodeType !== "agent"
    ) {
      throw new Error("implementation, blocker challenge, and fix nodes must be agents");
    }
    const hugePlan = { steps: [hugeOutput], evidence: hugeOutput };
    const hugeRequest = {
      task: hugeOutput,
      scope: hugeOutput,
      plan: hugePlan,
      constraints: [hugeOutput],
    };
    const implementPrompt = await implement.prompt(makeContext({ input: hugeRequest }));
    const challengePrompt = await challenge.prompt(
      makeContext({
        input: hugeRequest,
        outputs: {
          challengeBlockerGuard: {
            route: "challenge",
            origin: "implementation",
            recoveries: ["redesign", "fix"],
          },
        },
        state: {
          steps: [
            {
              nodeId: "classifyImplementation",
              outcome: "ok",
              output: { route: "blocked", evidence: hugeOutput },
              error: hugeOutput,
              startedAt: "2026-01-01T00:00:00.000Z",
              finishedAt: "2026-01-01T00:00:01.000Z",
            },
          ],
        },
      }),
    );
    const fixPrompt = await fix.prompt(
      makeContext({
        input: { task: "demo", plan: hugePlan },
        state: {
          steps: [
            {
              nodeId: "classifyImplementation",
              outcome: "ok",
              output: { route: "fix", evidence: hugeOutput },
            },
          ],
        },
      }),
    );
    expect(implementPrompt.length).toBeLessThan(40_000);
    expect(challengePrompt.length).toBeLessThan(90_000);
    expect(fixPrompt.length).toBeLessThan(50_000);
    expect(implementPrompt).toContain("[TRUNCATED");
    expect(challengePrompt).toContain("[TRUNCATED");
    expect(fixPrompt).toContain("\u2026");
    expect(hugeRequest.task).toHaveLength(140_000);
    expect(hugeRequest.scope).toHaveLength(140_000);
    expect(hugeRequest.constraints[0]).toHaveLength(140_000);
    expect(hugePlan.steps[0]).toHaveLength(140_000);
  });

  it("challenges the Bob artifact mismatch and continues through redesign", async () => {
    const executor = new ScriptedExecutor()
      .respond(
        "implement",
        {
          output: {
            status: "blocked",
            summary: "Bob owns an incompatible artifact, so deployment cannot continue.",
            files: [],
            issueKind: "design",
            evidence: "The current artifact does not match the supported package.",
          },
        },
        {
          output: {
            status: "implemented",
            summary: "Deployed through the supported cutover with rollback ready.",
            files: ["deploy/cutover.ts"],
            issueKind: null,
            evidence: "The supported artifact is active.",
          },
        },
      )
      .respond(
        "classifyImplementation",
        {
          output: {
            route: "blocked",
            summary: "Artifact ownership prevents deployment.",
            evidence: "Bob artifact mismatch",
          },
        },
        { output: { route: "verify", summary: "cutover complete", evidence: "deployed" } },
      )
      .respond("challengeBlocker", {
        output: continueChallenge(
          "The mismatch needs an authorized supported cutover, not an external permission.",
          "Revise the rollout plan and deploy the supported artifact with rollback ready.",
        ),
      })
      .respond("planVerification", {
        output: {
          commands: [
            {
              id: "verify-cutover",
              command: "npm",
              args: ["test"],
              cwd: repository,
              timeoutMs: 60_000,
              maxOutputChars: 100_000,
            },
          ],
          untested: [],
        },
      })
      .respond("verify", {
        output: {
          passed: true,
          commands: [{ command: "npm test", outcome: "passed" }],
          failures: [],
          untested: [],
        },
      })
      .respond("classifyVerification", {
        output: { route: "publish", summary: "verified", evidence: "npm test" },
      })
      .respond("publish", {
        output: published(
          publishedHeadRevision,
          "feat/cutover",
          "https://github.com/example/repository/pull/2",
        ),
      })
      .respond("assessReview", { output: cleanReview(publishedHeadRevision) })
      .respond("inspectComments", {
        output: { route: "ci", summary: "clear", evidence: [] },
      })
      .respond("inspectCi", {
        output: ciInspection("green", "cutover123", "https://github.com/example/repository/pull/2"),
      })
      .respond("finalizeDelivery", {
        output: {
          status: "completed",
          merged: false,
          pr: "https://github.com/example/repository/pull/2",
          reportComment: "done",
          reason: "ready without merge",
        },
      });
    addRedesignResponses(executor, [
      {
        summary: "Use the supported cutover.",
        steps: ["prepare rollback", "deploy supported artifact"],
        revision: 1,
      },
    ]);
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-bob"),
    });

    const { state } = await engine.run(autoimplementWorkflow, {
      task: "Resolve the Bob artifact mismatch and deploy safely",
      ...documentedPlan({ steps: ["deploy Bob artifact"] }),
      scope: "repository deployment and rollback",
      constraints: ["Safe deployment and rollback are authorized"],
      repository,
      merge: false,
    });

    expect(state.status, state.error).toBe("completed");
    expect(state.finalOutput).toMatchObject({ status: "completed" });
    expect(state.steps.filter((step) => step.nodeId === "challengeBlocker")).toHaveLength(1);
    expect(state.steps.map((step) => step.nodeId)).toContain("redesign/design/frame");
    expect(state.steps.filter((step) => step.nodeId === "implement")).toHaveLength(2);

    const challengeRequest = executor.requests.find(
      (request) => request.contract.nodeId === "challengeBlocker",
    );
    expect(challengeRequest?.prompt).toContain("Are you really blocked?");
    expect(challengeRequest?.prompt).toContain("Is this really a blocker right now?");
    expect(challengeRequest?.prompt).toContain(
      "Can you find a safe way to move forward and finish this?",
    );
    expect(challengeRequest?.prompt).toContain("outside authority");
    expect(challengeRequest?.prompt).toContain("Bob artifact mismatch");

    const redesignRequest = executor.requests.find(
      (request) => request.contract.nodeId === "redesign/design/frame",
    );
    expect(redesignRequest?.prompt).toContain(
      "Revise the rollout plan and deploy the supported artifact with rollback ready.",
    );
  });

  it("allows a confirmed missing external authorization to stop", async () => {
    const executor = new ScriptedExecutor()
      .respond("implement", {
        output: {
          status: "blocked",
          summary: "The task requires a prohibited remote mutation.",
          files: [],
          issueKind: "design",
          evidence: "No external authorization is present.",
        },
      })
      .respond("classifyImplementation", {
        output: {
          route: "blocked",
          summary: "Required remote mutation lacks authorization.",
          evidence: "The non-mutating paths do not meet the task.",
        },
      })
      .respond("challengeBlocker", {
        output: confirmedChallenge("The required remote mutation is outside current authority."),
      });
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-confirmed-blocker"),
    });

    const { state } = await engine.run(autoimplementWorkflow, {
      task: "Complete the protected remote mutation",
      ...documentedPlan({ steps: ["mutate protected remote"] }),
      scope: "local repository only",
      constraints: ["Do not mutate the protected remote without approval"],
      repository,
      merge: false,
    });

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "The required remote mutation is outside current authority.",
    });
  });

  it("limits blocker challenges to three and supplies prior challenge context", async () => {
    const executor = new ScriptedExecutor()
      .respond("implement", {
        output: {
          status: "blocked",
          summary: "The same unsupported blocker was asserted again.",
          files: [],
          issueKind: "design",
          evidence: "claim only",
        },
      })
      .respond("classifyImplementation", {
        output: {
          route: "blocked",
          summary: "Cannot continue.",
          evidence: "No new evidence.",
        },
      })
      .respond(
        "challengeBlocker",
        { output: continueChallenge("challenge one", "revise plan one") },
        { output: continueChallenge("challenge two", "revise plan two") },
        { output: continueChallenge("challenge three", "revise plan three") },
      );
    addRedesignResponses(executor, [
      { summary: "revision one", revision: 1 },
      { summary: "revision two", revision: 2 },
      { summary: "revision three", revision: 3 },
    ]);
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-challenge-limit"),
    });

    const { state } = await engine.run(autoimplementWorkflow, {
      task: "Finish despite repeated unsupported blocker claims",
      ...documentedPlan({ summary: "initial plan", revision: 0 }),
      repository,
      merge: false,
    });

    const challengeRequests = executor.requests.filter(
      (request) => request.contract.nodeId === "challengeBlocker",
    );
    expect(challengeRequests).toHaveLength(3);
    expect(challengeRequests[2]?.prompt).toContain("challenge one");
    expect(challengeRequests[2]?.prompt).toContain("challenge two");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "Blocker challenge reached the 3-attempt workflow safety limit.",
      evidence: { evidence: { attempts: 3 } },
    });
  });

  it("routes model blockers through the challenge and preserves hard stops", () => {
    const edge = (from: string) =>
      autoimplementWorkflow.edges.find((candidate) => candidate.from === from);

    expect(edge("classifyImplementation")).toMatchObject({
      switch: { cases: { blocked: "challengeBlockerGuard" } },
    });
    expect(edge("classifyVerification")).toMatchObject({
      switch: { cases: { blocked: "challengeBlockerGuard" } },
    });
    expect(edge("repairReviewCommand")).toMatchObject({
      switch: { cases: { blocked: "blocked" } },
    });
    expect(edge("runReview")).toMatchObject({
      switch: { cases: { blocked: "blocked" } },
    });
    expect(edge("assessReview")).toMatchObject({
      switch: {
        on: "$result.outcome",
        cases: { ok: "routeReviewAssessment", timed_out: "recoverReviewAssessment" },
      },
    });
    expect(edge("recoverReviewAssessment")).toMatchObject({
      switch: {
        on: "$result.outcome",
        cases: {
          ok: "routeReviewAssessment",
          timed_out: "reviewAssessmentRecoveryBlocked",
        },
      },
    });
    expect(edge("routeReviewAssessment")).toMatchObject({
      switch: { cases: { blocked: "blocked" } },
    });
    expect(edge("routeInspectCommentsResult")).toMatchObject({
      switch: { cases: { blocked: "challengeBlockerGuard" } },
    });
    expect(edge("routeInspectCiResult")).toMatchObject({
      switch: { cases: { unavailable: "challengeBlockerGuard" } },
    });
    expect(edge("repairCiCommand")).toMatchObject({
      switch: { cases: { blocked: "challengeBlockerGuard" } },
    });
    expect(edge("assessTrackedCi")).toMatchObject({
      switch: { cases: { unavailable: "challengeBlockerGuard" } },
    });
    expect(edge("classifyCi")).toMatchObject({
      switch: { cases: { blocked: "challengeBlockerGuard" } },
    });
    expect(edge("routeFinalizeDeliveryResult")).toMatchObject({
      switch: { cases: { blocked: "challengeBlockerGuard" } },
    });

    expect(Object.hasOwn(autoimplementWorkflow.includes ?? {}, "approval")).toBe(false);
    expect(edge("redesign.blocked")).toMatchObject({ to: "blocked" });
    expect(edge("documentation.blocked")).toMatchObject({ to: "blocked" });
    expect(edge("challengeBlocker")).toMatchObject({
      switch: { cases: { continue: "routeBlockerRecovery", blocked: "blocked" } },
    });
    const recoveryEdge = edge("routeBlockerRecovery");
    if (recoveryEdge === undefined || !("switch" in recoveryEdge)) {
      throw new Error("routeBlockerRecovery must use a switch edge");
    }
    const recoveryCases = recoveryEdge.switch.cases;
    expect(recoveryCases).toEqual({
      redesign: "redesign",
      fix: "fix",
      planVerification: "planVerification",
      repairReviewCommand: "repairReviewCommand",
      selectReviewCommands: "selectReviewCommands",
      inspectComments: "inspectComments",
      inspectCi: "inspectCi",
      opportunisticTest: "opportunisticTest",
    });
    expect(Object.values(recoveryCases ?? {})).not.toContain("finalizeDelivery");
    expect(Object.values(recoveryCases ?? {})).not.toContain("finalize");
  });

  it("derives every blocker origin from the immediate guarded stage", async () => {
    const guard = autoimplementWorkflow.nodes.challengeBlockerGuard;
    if (guard?.nodeType !== "compute") {
      throw new Error("challengeBlockerGuard must be a compute node");
    }
    const origins = {
      classifyImplementation: { origin: "implementation", recoveries: ["redesign", "fix"] },
      classifyVerification: { origin: "verification", recoveries: ["planVerification", "fix"] },
      runReview: {
        origin: "reviewer",
        recoveries: ["repairReviewCommand", "selectReviewCommands"],
      },
      repairReviewCommand: {
        origin: "reviewer",
        recoveries: ["repairReviewCommand", "selectReviewCommands"],
      },
      routeInspectCommentsResult: { origin: "comments", recoveries: ["inspectComments", "fix"] },
      routeInspectCiResult: { origin: "ci", recoveries: ["inspectCi", "opportunisticTest"] },
      repairCiCommand: { origin: "ci", recoveries: ["inspectCi", "opportunisticTest"] },
      assessTrackedCi: { origin: "ci", recoveries: ["inspectCi", "opportunisticTest"] },
      classifyCi: { origin: "ci", recoveries: ["inspectCi", "opportunisticTest"] },
      routeFinalizeDeliveryResult: {
        origin: "delivery",
        recoveries: ["inspectComments", "inspectCi"],
      },
    } as const;
    for (const [nodeId, expected] of Object.entries(origins)) {
      const result = await guard.run({
        input: { task: "demo" },
        outputs: {},
        results: {},
        state: { steps: [{ nodeId, outcome: "ok", output: { route: "blocked" } }] },
        signal: new AbortController().signal,
      } as never);
      expect(result).toMatchObject({
        route: "challenge",
        origin: expected.origin,
        recoveries: expected.recoveries,
      });
    }
    const unsupported = await guard.run({
      input: { task: "demo" },
      outputs: {},
      results: {},
      state: { steps: [{ nodeId: "publish", outcome: "ok", output: {} }] },
      signal: new AbortController().signal,
    } as never);
    expect(unsupported).toMatchObject({ route: "blocked" });
  });

  it("addresses P2 findings without running a second review round", async () => {
    const executor = commonExecutor()
      .respond("assessReview", {
        output: {
          repositories: [
            {
              id: repositoryId(repository),
              invocationSucceeded: true,
              p0: [],
              p1: [],
              p2: [{ kind: "implementation", summary: "simplify one branch" }],
              lower: [],
              reason: "One P2 finding.",
            },
          ],
          reason: "One P2 finding.",
        },
      })
      .respond("addressP2", {
        output: { addressed: ["simplified branch"], skipped: [] },
      })

      .respond("verifyP2", {
        output: {
          passed: true,
          commands: [{ command: "npm test", outcome: "passed" }],
          pushed: true,
          repositories: published(ALTERNATE_HEAD_REVISION).repositories,
        },
      })
      .respond("inspectComments", {
        output: { route: "ci", summary: "no actionable comments", evidence: [] },
      })
      .respond("inspectCi", { output: ciInspection("green", ALTERNATE_HEAD_REVISION) })
      .respond("finalizeDelivery", {
        output: {
          status: "completed",
          merged: true,
          pr: "https://github.com/example/repository/pull/1",
          reportComment: "https://github.com/example/repository/pull/1#comment",
          reason: "merged",
        },
      });
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-p2"),
    });

    const { state } = await engine.run(autoimplementWorkflow, {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: true,
    });

    expect(state.status).toBe("completed");
    expect(
      executor.requests.filter((request) => request.contract.nodeId === "assessReview"),
    ).toHaveLength(1);
    expect(state.steps.filter((step) => step.nodeId === "runReview")).toHaveLength(1);
    expect(state.steps.map((step) => step.nodeId)).toContain("verifyP2");
    expect(
      executor.requests.some((request) => request.contract.nodeId === "challengeBlocker"),
    ).toBe(false);
    const result = state.finalOutput as { reviewRounds: Array<{ p2: unknown[] }> };
    expect(result.reviewRounds).toHaveLength(1);
    expect(result.reviewRounds[0]?.p2).toHaveLength(1);
  });
  it("reassesses a persisted reviewer batch once after assessment timeout", async () => {
    const executor = commonExecutor()
      .respond("assessReview", { hang: true })
      .respond("recoverReviewAssessment", { output: cleanReview() })
      .respond("inspectComments", {
        output: { route: "ci", summary: "clear", evidence: [] },
      })
      .respond("inspectCi", { output: ciInspection("green") })
      .respond("finalizeDelivery", {
        output: {
          status: "completed",
          merged: false,
          pr: "https://github.com/example/repository/pull/1",
          reportComment: "done",
          reason: "ready",
        },
      });
    const { state } = await new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-review-assessment-timeout"),
    }).run(autoimplementWithTimeout("assessReview", 20), {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: false,
    });

    expect(state.status, state.error).toBe("completed");
    expect(state.steps.filter((step) => step.nodeId === "runReview")).toHaveLength(1);
    expect(state.steps.filter((step) => step.nodeId === "assessReview")).toHaveLength(1);
    expect(state.steps.find((step) => step.nodeId === "assessReview")?.outcome).toBe("timed_out");
    expect(state.steps.filter((step) => step.nodeId === "recoverReviewAssessment")).toHaveLength(1);
    expect(
      executor.requests.find((request) => request.contract.nodeId === "recoverReviewAssessment")
        ?.prompt,
    ).toContain("Persisted reviewer results");
    expect((state.finalOutput as { reviewRounds: unknown[] }).reviewRounds).toHaveLength(1);
  });

  it("stops after the bounded reviewer assessment recovery also times out", async () => {
    const primaryTimeout = autoimplementWithTimeout("assessReview", 20);
    const recovery = primaryTimeout.nodes.recoverReviewAssessment;
    if (recovery === undefined) throw new Error("recoverReviewAssessment node is missing");
    const boundedRecovery = {
      ...primaryTimeout,
      nodes: {
        ...primaryTimeout.nodes,
        recoverReviewAssessment: { ...recovery, timeoutMs: 20 },
      },
    };
    const executor = commonExecutor()
      .respond("assessReview", { hang: true })
      .respond("recoverReviewAssessment", { hang: true });
    const { state } = await new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-review-recovery-timeout"),
    }).run(boundedRecovery, {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: false,
    });

    expect(state.status, state.error).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason:
        "Reviewer commands completed, but both the primary and bounded recovery assessments timed out.",
    });
    expect(state.steps.filter((step) => step.nodeId === "runReview")).toHaveLength(1);
    expect(state.steps.filter((step) => step.nodeId === "recoverReviewAssessment")).toHaveLength(1);
    expect(
      executor.requests.some((request) => request.contract.nodeId === "challengeBlocker"),
    ).toBe(false);
  });

  it("runs another review after a P1 implementation fix", async () => {
    const executor = commonExecutor()
      .respond(
        "verify",
        {
          output: {
            passed: true,
            commands: [{ command: "npm test", outcome: "passed" }],
            failures: [],
            untested: [],
          },
        },
        {
          output: {
            passed: true,
            commands: [{ command: "npm test", outcome: "passed again" }],
            failures: [],
            untested: [],
          },
        },
      )
      .respond(
        "classifyVerification",
        { output: { route: "publish", summary: "passed", evidence: "first" } },
        { output: { route: "publish", summary: "passed", evidence: "second" } },
      )
      .respond("publish", async (request) => {
        const head = (
          await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })
        ).stdout.trim();
        const accepted = await request.accept(published(head));
        if (!accepted.ok) throw new Error(accepted.error);
        return { output: accepted.value };
      })
      .respond(
        "assessReview",
        {
          output: {
            repositories: [
              {
                id: repositoryId(repository),
                invocationSucceeded: true,
                p0: [],
                p1: [{ kind: "implementation", summary: "fix race" }],
                p2: [],
                lower: [],
                reason: "One P1.",
              },
            ],
            reason: "One P1.",
          },
        },
        { output: cleanReview("two") },
      )
      .respond("fix", async (request) => {
        await fs.writeFile(path.join(repository, "tracked.txt"), "fixed race\n");
        await execFileAsync("git", ["add", "tracked.txt"], { cwd: repository });
        await execFileAsync("git", ["commit", "-q", "-m", "fix race"], { cwd: repository });
        const accepted = await request.accept({ fixed: "fixed race", files: ["src/change.ts"] });
        if (!accepted.ok) throw new Error(accepted.error);
        return { output: accepted.value };
      })
      .respond("inspectComments", {
        output: { route: "ci", summary: "clear", evidence: [] },
      })
      .respond("inspectCi", { output: ciInspection("green", "one") })
      .respond("finalizeDelivery", {
        output: {
          status: "completed",
          merged: true,
          pr: "https://github.com/example/repository/pull/1",
          reportComment: "done",
          reason: "merged",
        },
      });
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-p1"),
    });

    const { state } = await engine.run(autoimplementWorkflow, {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: true,
    });

    expect(state.status, state.error).toBe("completed");
    expect(
      executor.requests.filter((request) => request.contract.nodeId === "assessReview"),
    ).toHaveLength(2);
    const result = state.finalOutput as { reviewRounds: unknown[] };
    expect(result.reviewRounds).toHaveLength(2);
  });

  it("blocks before model-controlled work when reviewer attestation is unavailable", async () => {
    const isolatedHome = await makeTempDir("pi-workflows-missing-reviewer-home");
    const isolatedPath = await makeTempDir("pi-workflows-missing-reviewer-path");
    process.env.HOME = isolatedHome;
    process.env.PATH = isolatedPath;
    const executor = new ScriptedExecutor();

    const { state } = await new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-missing-reviewer"),
    }).run(autoimplementWorkflow, {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: false,
    });

    expect(state.status, state.error).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "omp-reviewer was not available as an initial trusted executable.",
    });
    expect(executor.requests).toHaveLength(0);
  });

  it("rejects a replaced OMP dependency before reviewer execution", async () => {
    const select = autoimplementWorkflow.nodes.selectReviewCommands;
    const review = autoimplementWorkflow.nodes.runReview;
    if (select?.nodeType !== "compute") throw new Error("selectReviewCommands must be compute");
    if (review?.nodeType !== "action" || !("run" in review)) {
      throw new Error("runReview must be a function action");
    }
    const marker = path.join(commandDir, "reviewer-ran-after-omp-replacement");
    await installCommand("omp", "exit 0");
    await installCommand("omp-reviewer", `printf '%s\\n' invoked > ${JSON.stringify(marker)}`);
    const preparation = await reviewerPreparation();
    const publication = publishedState();
    const selection = await select.run({
      input: { task: "demo", concurrency: { reviewer: 1 } },
      outputs: { prepare: preparation, publish: publication },
      results: {},
      state: { steps: [] },
      signal: new AbortController().signal,
    } as never);
    await installCommand("omp", "exit 1");

    const execution = await review.run({
      input: {
        task: "demo",
        concurrency: { reviewer: 1, ciWatch: 1, verification: 1 },
      },
      outputs: { selectReviewCommands: selection },
      results: {},
      state: {
        steps: [{ nodeId: "selectReviewCommands", outcome: "ok", output: selection }],
      },
      signal: new AbortController().signal,
      publishUpdate: async () => ({
        updateId: "review-omp-replacement",
        seq: 1,
        at: "now",
        type: "command-batch",
        key: "review",
      }),
    } as never);

    expect(execution).toMatchObject({
      route: "repair",
      batch: {
        items: [
          {
            outcome: "failed",
            exitCode: null,
            error: "The initially attested OMP executable changed.",
          },
        ],
      },
    });
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it("does not invoke the reviewer after published HEAD drifts and assesses invocation failure", async () => {
    const select = autoimplementWorkflow.nodes.selectReviewCommands;
    const review = autoimplementWorkflow.nodes.runReview;
    const assess = autoimplementWorkflow.nodes.assessReview;
    if (select?.nodeType !== "compute") throw new Error("selectReviewCommands must be compute");
    if (review?.nodeType !== "action" || !("run" in review)) {
      throw new Error("runReview must be a function action");
    }
    if (assess?.nodeType !== "agent" || assess.validate === undefined) {
      throw new Error("assessReview must be a validated agent");
    }
    const publication = publishedState();
    const marker = path.join(commandDir, "reviewer-invoked-after-drift");
    await installCommand("omp-reviewer", `printf '%s\\n' invoked > ${JSON.stringify(marker)}`);
    const preparation = await reviewerPreparation();
    const selection = await select.run({
      input: { task: "demo", concurrency: { reviewer: 1 } },
      outputs: { prepare: preparation, publish: publication },
      results: {},
      state: { steps: [] },
      signal: new AbortController().signal,
    } as never);
    await fs.writeFile(path.join(repository, "tracked.txt"), "changed after publication\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: repository });
    await execFileAsync("git", ["commit", "-q", "-m", "head drift"], { cwd: repository });

    const execution = await review.run({
      input: {
        task: "demo",
        concurrency: { reviewer: 1, ciWatch: 1, verification: 1 },
      },
      outputs: { selectReviewCommands: selection },
      results: {},
      state: {
        steps: [{ nodeId: "selectReviewCommands", outcome: "ok", output: selection }],
      },
      signal: new AbortController().signal,
      publishUpdate: async () => ({
        updateId: "review-drift",
        seq: 1,
        at: "now",
        type: "command-batch",
        key: "review",
      }),
    } as never);
    expect(execution).toMatchObject({
      route: "repair",
      batch: {
        items: [
          {
            outcome: "failed",
            exitCode: null,
            error: expect.stringContaining("expected Git HEAD"),
          },
        ],
      },
    });
    await expect(fs.stat(marker)).rejects.toThrow();
    expect(
      assess.validate(
        {
          repositories: [
            {
              id: repositoryId(repository),
              invocationSucceeded: true,
              p0: [],
              p1: [],
              p2: [],
              lower: [],
              reason: "Published checkout precondition failed.",
            },
          ],
          reason: "Reviewer was not invoked.",
        },
        {
          input: { task: "demo" },
          outputs: { selectReviewCommands: selection, runReview: execution },
          results: {},
          state: {
            steps: [
              { nodeId: "selectReviewCommands", outcome: "ok", output: selection },
              { nodeId: "runReview", outcome: "ok", output: execution },
            ],
          },
          signal: new AbortController().signal,
        } as never,
      ),
    ).toMatchObject({ route: "command_error", invocationSucceeded: false });
    expect(
      assess.validate(
        {
          repositories: [
            {
              id: repositoryId(repository),
              invocationSucceeded: true,
              p0: [],
              p1: [],
              p2: [],
              lower: [],
              reason: "Assessor falsely claimed the invocation succeeded.",
            },
          ],
          reason: "False success after reviewer repair.",
        },
        {
          input: { task: "demo" },
          outputs: { selectReviewCommands: selection, runReview: execution },
          results: {},
          state: {
            steps: [
              { nodeId: "selectReviewCommands", outcome: "ok", output: selection },
              { nodeId: "runReview", outcome: "ok", output: execution },
              {
                nodeId: "repairReviewCommand",
                outcome: "ok",
                output: { route: "retry", reason: "reviewer configuration repaired" },
              },
            ],
          },
          signal: new AbortController().signal,
        } as never,
      ),
    ).toMatchObject({ route: "blocked", invocationSucceeded: false });
  });

  it("uses the attested Git executable instead of a malicious PATH wrapper", async () => {
    const select = autoimplementWorkflow.nodes.selectReviewCommands;
    const review = autoimplementWorkflow.nodes.runReview;
    if (select?.nodeType !== "compute") throw new Error("selectReviewCommands must be compute");
    if (review?.nodeType !== "action" || !("run" in review)) {
      throw new Error("runReview must be a function action");
    }
    const publication = publishedState();
    const forgedMarker = path.join(commandDir, "forged-reviewer-ran-during-preconditions");
    const gitMarker = path.join(commandDir, "malicious-git-precondition-ran");
    const forgedReviewer = path.join(commandDir, "forged-reviewer");
    const reviewerPath = path.join(commandDir, "omp-reviewer");
    const preparation = await reviewerPreparation();
    const realGit = (
      await execFileAsync("sh", ["-c", "command -v git"], {
        env: { ...process.env, PATH: originalPath },
      })
    ).stdout.trim();
    const selection = await select.run({
      input: { task: "demo", concurrency: { reviewer: 1 } },
      outputs: { prepare: preparation, publish: publication },
      results: {},
      state: { steps: [] },
      signal: new AbortController().signal,
    } as never);
    await fs.writeFile(
      forgedReviewer,
      `#!/bin/sh\nprintf '%s\\n' forged > ${JSON.stringify(forgedMarker)}\n`,
      { mode: 0o755 },
    );
    await installCommand(
      "git",
      `cp ${JSON.stringify(forgedReviewer)} ${JSON.stringify(reviewerPath)}\nprintf '%s\\n' wrapped > ${JSON.stringify(gitMarker)}\nexec ${JSON.stringify(realGit)} "$@"`,
    );

    const execution = await review.run({
      input: {
        task: "demo",
        concurrency: { reviewer: 1, ciWatch: 1, verification: 1 },
      },
      outputs: { selectReviewCommands: selection },
      results: {},
      state: {
        steps: [{ nodeId: "selectReviewCommands", outcome: "ok", output: selection }],
      },
      signal: new AbortController().signal,
      publishUpdate: async () => ({
        updateId: "review-precondition-substitution",
        seq: 1,
        at: "now",
        type: "command-batch",
        key: "review",
      }),
    } as never);

    expect(execution).toMatchObject({
      route: "assess",
      batch: {
        items: [
          {
            outcome: "succeeded",
            exitCode: 0,
          },
        ],
      },
    });
    await expect(fs.access(gitMarker)).rejects.toThrow();
    await expect(fs.access(forgedMarker)).rejects.toThrow();
  });

  it("reuses the prior reviewer attestation when selection is revisited after repair", async () => {
    const select = autoimplementWorkflow.nodes.selectReviewCommands;
    if (select?.nodeType !== "compute") {
      throw new Error("selectReviewCommands must be a compute node");
    }
    const publication = publishedState();
    const preparation = await reviewerPreparation();
    const first = (await select.run({
      input: { task: "demo" },
      outputs: { prepare: preparation, publish: publication },
      results: {},
      state: { steps: [] },
      signal: new AbortController().signal,
    } as never)) as {
      reviewerRuntime: { reviewer?: { executable: string } };
      commands: Array<{
        command: string;
        env?: NodeJS.ProcessEnv;
        expectedCommit?: string;
      }>;
    };
    const forgedDir = await makeTempDir("pi-workflows-reselected-reviewer");
    const forgedReviewer = path.join(forgedDir, "omp-reviewer");
    await fs.writeFile(forgedReviewer, "#!/bin/sh\n", { mode: 0o755 });
    process.env.PATH = `${forgedDir}${path.delimiter}${process.env.PATH ?? ""}`;

    const revisited = (await select.run({
      input: { task: "demo" },
      outputs: { prepare: preparation, publish: publication },
      results: {},
      state: {
        steps: [
          { nodeId: "selectReviewCommands", outcome: "ok", output: first },
          {
            nodeId: "repairReviewCommand",
            outcome: "ok",
            output: { route: "retry", reason: "configuration repaired" },
          },
        ],
      },
      signal: new AbortController().signal,
    } as never)) as typeof first;

    expect(first.reviewerRuntime.reviewer?.executable).toBe(path.join(commandDir, "omp-reviewer"));
    expect(revisited.reviewerRuntime).toEqual(first.reviewerRuntime);
    expect(revisited.commands).toEqual(first.commands);
    expect(revisited.commands[0]?.command).not.toBe(forgedReviewer);

    const republished = {
      repositories: publication.repositories.map((entry) => ({
        ...entry,
        headRevision: ALTERNATE_HEAD_REVISION,
      })),
    };
    const refreshed = (await select.run({
      input: { task: "demo" },
      outputs: { prepare: preparation, publish: republished },
      results: {},
      state: {
        steps: [
          { nodeId: "selectReviewCommands", outcome: "ok", output: first },
          {
            nodeId: "repairReviewCommand",
            outcome: "ok",
            output: { route: "retry", reason: "configuration repaired" },
          },
        ],
      },
      signal: new AbortController().signal,
    } as never)) as typeof first;

    expect(refreshed.reviewerRuntime).toEqual(first.reviewerRuntime);
    expect(refreshed.commands[0]).toMatchObject({
      command: first.commands[0]?.command,
      env: first.commands[0]?.env,
      expectedCommit: ALTERNATE_HEAD_REVISION,
    });
  });

  it("uses the originally attested reviewer after PATH changes during repair", async () => {
    const marker = path.join(commandDir, "reviewer-retried");
    const forgedDir = await makeTempDir("pi-workflows-forged-reviewer-path");
    const forgedMarker = path.join(forgedDir, "forged-reviewer-ran");
    await installCommand(
      "omp-reviewer",
      `if [ ! -f ${JSON.stringify(marker)} ]; then touch ${JSON.stringify(marker)}; exit 1; fi\nprintf '%s\\n' "review complete"`,
    );
    const executor = commonExecutor()
      .respond("repairReviewCommand", async (request) => {
        await fs.writeFile(
          path.join(forgedDir, "omp-reviewer"),
          `#!/bin/sh\nprintf '%s\\n' forged > ${JSON.stringify(forgedMarker)}\n`,
          { mode: 0o755 },
        );
        process.env.PATH = `${forgedDir}${path.delimiter}${process.env.PATH ?? ""}`;
        const accepted = await request.accept({
          route: "retry",
          reason: "reviewer configuration repaired",
        });
        if (!accepted.ok) throw new Error(accepted.error);
        return { output: accepted.value };
      })
      .respond(
        "assessReview",
        {
          output: {
            repositories: [
              {
                id: repositoryId(repository),
                invocationSucceeded: false,
                p0: [],
                p1: [],
                p2: [],
                lower: [],
                reason: "The reviewer exited without a valid review.",
              },
            ],
            reason: "The first invocation did not produce a valid review.",
          },
        },
        { output: cleanReview() },
      )
      .respond("inspectComments", {
        output: { route: "ci", summary: "clear", evidence: [] },
      })
      .respond("inspectCi", { output: ciInspection("green") })
      .respond("finalizeDelivery", {
        output: {
          status: "completed",
          merged: true,
          pr: "https://github.com/example/repository/pull/1",
          reportComment: "done",
          reason: "merged",
        },
      });
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-command"),
    });

    const { state } = await engine.run(autoimplementWorkflow, {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: true,
    });

    expect(state.status).toBe("completed");
    expect(
      executor.requests.some((request) => request.contract.nodeId === "repairReviewCommand"),
    ).toBe(true);
    expect(state.steps.filter((step) => step.nodeId === "runReview")).toHaveLength(2);
    await expect(fs.access(forgedMarker)).rejects.toThrow();
  });

  it("blocks when the attested reviewer file is replaced during repair", async () => {
    const forgedMarker = path.join(commandDir, "replaced-reviewer-ran");
    await installCommand("omp-reviewer", "kill -TERM $$");
    const executor = commonExecutor().respond("repairReviewCommand", async (request) => {
      await installCommand(
        "omp-reviewer",
        `printf '%s\\n' forged > ${JSON.stringify(forgedMarker)}`,
      );
      const accepted = await request.accept({
        route: "retry",
        reason: "reviewer executable replaced",
      });
      if (!accepted.ok) throw new Error(accepted.error);
      return { output: accepted.value };
    });
    const { state } = await new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-reviewer-replaced"),
    }).run(autoimplementWorkflow, {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: false,
    });

    expect(state.status, state.error).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "The initially attested omp-reviewer executable changed.",
    });
    expect(state.steps.filter((step) => step.nodeId === "repairReviewCommand")).toHaveLength(1);
    expect(state.steps.filter((step) => step.nodeId === "runReview")).toHaveLength(1);
    await expect(fs.access(forgedMarker)).rejects.toThrow();
  });

  it("blocks a second reviewer command error after one repair", async () => {
    await installCommand("omp-reviewer", "kill -TERM $$");
    const executor = commonExecutor().respond("repairReviewCommand", {
      output: { route: "retry", reason: "reviewer configuration repaired" },
    });
    const { state } = await new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-review-repair-limit"),
    }).run(autoimplementWorkflow, {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: false,
    });

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "omp-reviewer failed again after one reviewer repair attempt.",
    });
    expect(state.steps.filter((step) => step.nodeId === "repairReviewCommand")).toHaveLength(1);
    expect(state.steps.filter((step) => step.nodeId === "runReview")).toHaveLength(2);
    expect(state.steps.filter((step) => step.nodeId === "assessReview")).toHaveLength(0);
    expect(state.steps.filter((step) => step.nodeId === "challengeBlockerGuard")).toHaveLength(0);
    expect(
      executor.requests.some((request) => request.contract.nodeId === "challengeBlocker"),
    ).toBe(false);
  });

  it("rejects publication outside the prepared repository before review", async () => {
    const secondRepository = await makeTempDir("pi-workflows-autoimplement-second-repo");
    const publication = {
      repositories: [
        {
          repository,
          branch: "feat/demo",
          baseBranch: "main",
          baseRevision: publishedBaseRevision,
          headRevision: HEAD_ONE_REVISION,
          pr: "https://github.com/example/repository/pull/1",
          pushed: true,
        },
        {
          repository: secondRepository,
          branch: "feat/demo-two",
          baseBranch: "main",
          baseRevision: publishedBaseRevision,
          headRevision: HEAD_TWO_REVISION,
          pr: "https://github.com/example/repository/pull/2",
          pushed: true,
        },
      ],
    };
    const { state } = await new WorkflowEngine({
      executor: commonExecutor(publication),
      outputRoot: await makeTempDir("pi-workflows-autoimplement-publication-boundary"),
    }).run(autoimplementWorkflow, {
      task: "implement in the prepared repository",
      ...documentedPlan({ steps: ["change the prepared repository"] }),
      repository,
      merge: false,
    });
    expect(state.status).toBe("failed");
    expect(state.error).toContain(`publication repositories must contain only ${repository}`);
    expect(state.steps.some((step) => step.nodeId === "runReview")).toBe(false);
  });
  it("rejects self-base publication before review", async () => {
    const publication = published();
    publication.repositories[0]!.baseRevision = publishedHeadRevision;
    const { state } = await new WorkflowEngine({
      executor: commonExecutor(publication),
      outputRoot: await makeTempDir("pi-workflows-autoimplement-self-base"),
    }).run(autoimplementWorkflow, {
      task: "reject an empty reviewer range",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: false,
    });
    expect(state.status).toBe("failed");
    expect(state.error).toContain("cannot review self-base");
    expect(state.steps.some((step) => step.nodeId === "runReview")).toBe(false);
  });

  it("rejects publication against a different requested base branch before review", async () => {
    const { state } = await new WorkflowEngine({
      executor: commonExecutor({
        repositories: [
          {
            repository,
            branch: "feat/demo",
            baseBranch: "release",
            baseRevision: publishedBaseRevision,
            headRevision: HEAD_ONE_REVISION,
            pr: "https://github.com/example/repository/pull/1",
            pushed: true,
          },
        ],
      }),
      outputRoot: await makeTempDir("pi-workflows-autoimplement-base-boundary"),
    }).run(autoimplementWorkflow, {
      task: "implement from the requested base branch",
      ...documentedPlan({ steps: ["change the prepared repository"] }),
      repository,
      baseBranch: "main",
      merge: false,
    });
    expect(state.status).toBe("failed");
    expect(state.error).toContain("publication repository must use base branch main");
    expect(state.steps.some((step) => step.nodeId === "runReview")).toBe(false);
  });

  it("routes a timed-out implementation through the shared fallback", async () => {
    const executor = new ScriptedExecutor()
      .respond(
        "implement",
        { hang: true },
        {
          output: {
            status: "implemented",
            summary: "continued existing work",
            files: ["src/change.ts"],
            repositories: [repository],
            issueKind: null,
            evidence: "worktree inspection showed the remaining work",
          },
        },
      )
      .respond("timeoutFallback", {
        output: {
          route: "retry",
          reason: "The timed-out implementation has incomplete local work.",
          evidence: ["The current diff still has the planned incomplete change."],
        },
      })
      .respond("classifyImplementation", {
        output: { route: "verify", summary: "ready", evidence: "implementation complete" },
      })
      .respond("planVerification", {
        output: {
          commands: [
            {
              id: "verify",
              command: "npm",
              args: ["test"],
              cwd: repository,
              timeoutMs: 60_000,
              maxOutputChars: 100_000,
            },
          ],
          untested: [],
        },
      })
      .respond("verify", {
        output: {
          passed: true,
          commands: [{ command: "node verification", outcome: "passed" }],
          failures: [],
          untested: [],
        },
      })
      .respond("classifyVerification", {
        output: { route: "publish", summary: "checks passed", evidence: "verification" },
      })
      .respond("publish", { output: published() })
      .respond("assessReview", { output: cleanReview() })
      .respond("inspectComments", {
        output: { route: "ci", summary: "no actionable comments", evidence: [] },
      })
      .respond("inspectCi", { output: ciInspection("green") })
      .respond("finalizeDelivery", {
        output: {
          status: "completed",
          merged: false,
          pr: "https://github.com/example/repository/pull/1",
          reportComment: "https://github.com/example/repository/pull/1#comment",
          reason: "ready",
        },
      });
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-timeout-fallback"),
    });

    const { state } = await engine.run(autoimplementWithTimeout("implement", 500), {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: false,
    });

    expect(state.status, state.error).toBe("completed");
    expect(
      state.steps.filter((step) => step.nodeId === "implement").map((step) => step.outcome),
    ).toEqual(["timed_out", "ok"]);
    expect(state.steps.filter((step) => step.nodeId === "timeoutFallback")).toHaveLength(1);
    const fallbackRequest = executor.requests.find(
      (request) => request.contract.nodeId === "timeoutFallback",
    );
    expect(fallbackRequest?.contract.toolPolicy).toBe("observation-only");
    const fallbackPrompt = fallbackRequest?.prompt;
    expect(fallbackPrompt).toContain("read-only fallback step");
    expect(fallbackPrompt).not.toContain("Accepted outputs:");
    const recentAttemptsJson =
      fallbackPrompt?.split("Recent workflow attempts: ")[1]?.split("\n")[0] ?? "[]";
    const recentAttempts = JSON.parse(recentAttemptsJson) as Array<Record<string, unknown>>;
    const timedOutAttempt = recentAttempts.find((attempt) => attempt.nodeId === "implement");
    expect(timedOutAttempt).toMatchObject({
      nodeId: "implement",
      outcome: "timed_out",
      error: "Timed out after 500ms",
      durationMs: expect.any(Number),
    });
    expect(Object.keys(timedOutAttempt ?? {}).sort()).toEqual(
      ["durationMs", "error", "nodeId", "outcome"].sort(),
    );
  });

  it("stops after three timeout fallback executions", async () => {
    const executor = new ScriptedExecutor()
      .respond("implement", { hang: true }, { hang: true }, { hang: true }, { hang: true })
      .respond(
        "timeoutFallback",
        {
          output: {
            route: "retry",
            reason: "Implementation remains incomplete.",
            evidence: ["The current diff is incomplete."],
          },
        },
        {
          output: {
            route: "retry",
            reason: "Implementation remains incomplete.",
            evidence: ["The current diff is still incomplete."],
          },
        },
        {
          output: {
            route: "retry",
            reason: "Implementation remains incomplete.",
            evidence: ["The current diff remains incomplete."],
          },
        },
      );
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-timeout-limit"),
    });

    const { state } = await engine.run(autoimplementWithTimeout("implement", 10), {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: false,
    });

    expect(state.status).toBe("completed");
    expect((state.finalOutput as { status: string }).status).toBe("blocked");
    expect(state.steps.filter((step) => step.nodeId === "timeoutFallback")).toHaveLength(3);
    expect(state.steps.filter((step) => step.nodeId === "implement")).toHaveLength(4);
    expect(state.finalOutput).toMatchObject({
      evidence: {
        evidence: {
          attempts: 3,
          limit: 3,
          timeouts: [
            { nodeId: "implement", error: "Timed out after 10ms" },
            { nodeId: "implement", error: "Timed out after 10ms" },
            { nodeId: "implement", error: "Timed out after 10ms" },
            { nodeId: "implement", error: "Timed out after 10ms" },
          ],
        },
      },
    });
  });

  it("keeps a fallback blocked result terminal and rejects stale forward routes", async () => {
    const executor = new ScriptedExecutor()
      .respond("implement", { hang: true })
      .respond("timeoutFallback", {
        output: {
          route: "blocked",
          reason: "No safe route exists.",
          evidence: ["Repository inspection found an unresolved conflict."],
        },
      });
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-timeout-blocked"),
    });

    const { state } = await engine.run(autoimplementWithTimeout("implement", 10), {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: false,
    });

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({ status: "blocked", reason: "No safe route exists." });
    expect(
      executor.requests.some((request) => request.contract.nodeId === "challengeBlocker"),
    ).toBe(false);

    const fallback = autoimplementWorkflow.nodes.timeoutFallback;
    if (fallback?.nodeType !== "agent" || fallback.validate === undefined) {
      throw new Error("timeoutFallback must be a validated agent node");
    }
    await expect(
      Promise.resolve().then(() =>
        fallback.validate?.(
          {
            route: "review",
            reason: "A prior publication exists.",
            evidence: ["The old PR is open."],
          },
          {
            input: { task: "demo", plan: {} },
            outputs: { publish: published("old-head") },
            results: {},
            state: {
              steps: [
                { nodeId: "publish", outcome: "ok", output: published("old-head") },
                { nodeId: "implement", outcome: "timed_out", output: null },
              ],
            },
          } as never,
        ),
      ),
    ).rejects.toThrow("route review is not safe after timed-out implement");

    await expect(
      Promise.resolve().then(() =>
        fallback.validate?.(
          {
            route: "review",
            reason: "The old PR can be reviewed.",
            evidence: ["The old PR is open."],
          },
          {
            input: { task: "demo", plan: {} },
            outputs: { publish: published("old-head") },
            results: {},
            state: {
              steps: [
                { nodeId: "publish", outcome: "ok", output: published("old-head") },
                { nodeId: "implement", outcome: "ok", output: { status: "implemented" } },
                { nodeId: "inspectComments", outcome: "timed_out", output: null },
              ],
            },
          } as never,
        ),
      ),
    ).rejects.toThrow("without a current published head");
    const staleHeadContext = {
      input: { task: "demo", plan: {} },
      outputs: {
        publish: published("new-head"),
        inspectComments: { route: "ci" },
        assessTrackedCi: { route: "green" },
        classifyCi: { route: "unrelated" },
      },
      results: {},
      state: {
        steps: [
          { nodeId: "publish", outcome: "ok", output: published("old-head") },
          { nodeId: "inspectComments", outcome: "ok", output: { route: "ci" } },
          { nodeId: "assessTrackedCi", outcome: "ok", output: { route: "green" } },
          { nodeId: "fix", outcome: "ok", output: { status: "implemented" } },
          { nodeId: "publish", outcome: "ok", output: published("new-head") },
          { nodeId: "inspectCi", outcome: "timed_out", output: null },
        ],
      },
    } as never;
    await expect(
      Promise.resolve().then(() =>
        fallback.validate?.(
          {
            route: "deliver",
            reason: "The old head passed CI.",
            evidence: ["A prior CI assessment was green."],
          },
          staleHeadContext,
        ),
      ),
    ).rejects.toThrow("cannot route to delivery before CI is ready");
    await expect(
      Promise.resolve().then(() =>
        fallback.validate?.(
          {
            route: "ci",
            reason: "The old head comments were clear.",
            evidence: ["A prior comment inspection routed to CI."],
          },
          staleHeadContext,
        ),
      ),
    ).rejects.toThrow("cannot route to CI before comment inspection completed");

    const currentHeadContext = {
      input: { task: "demo", plan: {} },
      outputs: {},
      results: {},
      state: {
        steps: [
          { nodeId: "publish", outcome: "ok", output: published("current-head") },
          { nodeId: "inspectComments", outcome: "ok", output: { route: "ci" } },
          { nodeId: "inspectCi", outcome: "ok", output: { route: "green" } },
          { nodeId: "finalizeDelivery", outcome: "timed_out", output: null },
        ],
      },
    } as never;
    await expect(
      Promise.resolve().then(() =>
        fallback.validate?.(
          {
            route: "deliver",
            reason: "The current published head passed CI.",
            evidence: ["Current-head comment and CI gates completed in order."],
          },
          currentHeadContext,
        ),
      ),
    ).resolves.toMatchObject({ route: "deliver" });
  });

  it("keeps failed implementation and cancellation out of timeout fallback", async () => {
    const failedEngine = new WorkflowEngine({
      executor: new ScriptedExecutor().respond("implement", { error: "implementation failed" }),
      outputRoot: await makeTempDir("pi-workflows-autoimplement-failed"),
    });
    const failed = await failedEngine.run(autoimplementWorkflow, {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: false,
    });
    expect(failed.state.status).toBe("failed");
    expect(failed.state.error).toBe("implementation failed");
    expect(failed.state.steps.some((step) => step.nodeId === "timeoutFallback")).toBe(false);

    const cancelledExecutor = new ScriptedExecutor().respond("implement", { hang: true });
    const cancelledEngine = new WorkflowEngine({
      executor: cancelledExecutor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-cancelled"),
    });
    const cancelledPromise = cancelledEngine.run(autoimplementWithTimeout("implement", 1_000), {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    cancelledEngine.cancel();
    const cancelled = await cancelledPromise;
    expect(cancelled.state.status).toBe("cancelled");
    expect(cancelled.state.steps.some((step) => step.nodeId === "timeoutFallback")).toBe(false);
  });

  it("uses the eight-hour implementation timeout and shared outcome routes", () => {
    expect(autoimplementWorkflow.nodes.implement?.timeoutMs).toBe(8 * 60 * 60_000);
    expect(autoimplementWorkflow.nodes.timeoutFallback?.timeoutMs).toBe(8 * 60_000);
    expect(autoimplementWorkflow.nodes.timeoutFallback?.toolPolicy).toBe("observation-only");
    for (const nodeId of [
      "findPlan",
      "classifyImplementation",
      "classifyVerification",
      "assessReview",
      "recoverReviewAssessment",
      "inspectCi",
      "assessTrackedCi",
      "classifyCi",
    ]) {
      const node = autoimplementWorkflow.nodes[nodeId];
      expect(node?.nodeType, nodeId).toBe("agent");
      if (node?.nodeType !== "agent") throw new Error(`${nodeId} must be an agent`);
      expect(node.toolPolicy, nodeId).toBe("observation-only");
    }
    expect(autoimplementWorkflow.nodes.implement).not.toHaveProperty("toolPolicy");
    const compiled = compileWorkflowDefinition(autoimplementWorkflow);
    expect(
      compiled.edges.find((candidate) => candidate.from === "routeTimeoutFallback"),
    ).toMatchObject({ switch: { cases: { blocked: "blocked" } } });
    for (const nodeId of [
      "implement",
      "planVerification",
      "verify",
      "fix",
      "publish",
      "addressP2",
      "verifyP2",
      "inspectComments",
      "inspectCi",
      "opportunisticTest",
      "finalizeDelivery",
    ]) {
      const edge = compiled.edges.find((candidate) => candidate.from === nodeId);
      expect(edge).toMatchObject({
        switch: {
          on: "$result.outcome",
          cases: {
            timed_out: "timeoutFallbackGuard",
            failed: "propagateSupportedFailure",
          },
        },
      });
    }
  });

  it("routes completed CI batches through per-PR assessment", () => {
    const compiled = compileWorkflowDefinition(autoimplementWorkflow);
    const track = compiled.nodes.trackCi;
    const edge = compiled.edges.find((candidate) => candidate.from === "trackCi");
    expect(track?.nodeType).toBe("action");
    expect(edge).toMatchObject({
      switch: {
        on: "$.route",
        cases: { assess: "assessTrackedCi", repair: "repairCiCommand" },
      },
    });
  });
});
