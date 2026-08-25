import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  observationOnlyToolBlockReason,
  type ToolInfo,
} from "../src/workflows/observation-tool-policy.js";
import { makeTempDir } from "./helpers.js";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function builtinTool(name: string): ToolInfo {
  return {
    name,
    sourceInfo: {
      path: `<builtin:${name}>`,
      source: "builtin",
      scope: "temporary",
      origin: "top-level",
    },
  };
}

function packageTool(name: string, baseDir: string): ToolInfo {
  return {
    name,
    sourceInfo: {
      path: path.join(baseDir, "src", "extension", "index.ts"),
      source: "@ericjuta/omp-workflows",
      scope: "project",
      origin: "package",
      baseDir,
    },
  };
}

describe("observation-only tool policy", () => {
  it("accepts an exact trusted builtin name and rejects namespaced aliases", () => {
    expect(
      observationOnlyToolBlockReason("read", { path: "state.json" }, [builtinTool("read")]),
    ).toBeNull();
    expect(
      observationOnlyToolBlockReason("evil.read", { path: "state.json" }, [
        builtinTool("evil.read"),
      ]),
    ).toBe("This workflow step is observation-only; tool evil.read is not allowed.");
  });

  it("blocks a custom read winner before its mutation can impact the marker", async () => {
    const directory = await makeTempDir("observation-custom-read");
    const markerPath = path.join(directory, "marker");
    const customRead: ToolInfo = {
      name: "read",
      sourceInfo: {
        path: path.join(directory, "read-override.ts"),
        source: "local",
        scope: "project",
        origin: "top-level",
        baseDir: directory,
      },
    };
    const reason = observationOnlyToolBlockReason("read", { path: markerPath }, [customRead]);
    if (reason === null) {
      await fs.writeFile(markerPath, "mutated");
    }

    expect(reason).toBe("This workflow step is observation-only; tool read is not allowed.");
    await expect(fs.readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires the current workflow tool to resolve within the canonical package owner", async () => {
    const expectedPackageDir = await fs.realpath(PACKAGE_DIR);
    const directory = await makeTempDir("observation-workflow-owner");
    const samePackageAlias = path.join(directory, "same-package-alias");
    await fs.symlink(expectedPackageDir, samePackageAlias, "dir");
    const rpcBridgeTool: ToolInfo = {
      name: "workflow",
      sourceInfo: {
        path: path.join(expectedPackageDir, "src", "host", "rpc-bridge.ts"),
        source: "local",
        scope: "temporary",
        origin: "top-level",
      },
    };

    expect(
      observationOnlyToolBlockReason("workflow", { action: "submit" }, [
        packageTool("workflow", expectedPackageDir),
      ]),
    ).toBeNull();
    expect(
      observationOnlyToolBlockReason("workflow", { action: "update" }, [
        packageTool("workflow", samePackageAlias),
      ]),
    ).toBeNull();
    expect(
      observationOnlyToolBlockReason("workflow", { action: "status" }, [rpcBridgeTool]),
    ).toBeNull();
    expect(
      observationOnlyToolBlockReason("workflow", { action: "start" }, [
        packageTool("workflow", expectedPackageDir),
      ]),
    ).not.toBeNull();
  });

  it("rejects workflow package lookalikes and symlink escapes", async () => {
    const directory = await makeTempDir("observation-workflow-lookalike");
    const lookalike = path.join(directory, "lookalike", "omp-workflows");
    const escapedTarget = path.join(directory, "outside", "omp-workflows");
    const escapedAlias = path.join(directory, "installed", "omp-workflows");
    await fs.mkdir(lookalike, { recursive: true });
    await fs.mkdir(escapedTarget, { recursive: true });
    await fs.mkdir(path.dirname(escapedAlias), { recursive: true });
    await fs.symlink(escapedTarget, escapedAlias, "dir");

    expect(
      observationOnlyToolBlockReason("workflow", { action: "status" }, [
        packageTool("workflow", lookalike),
      ]),
    ).not.toBeNull();
    expect(
      observationOnlyToolBlockReason("workflow", { action: "list" }, [
        packageTool("workflow", escapedAlias),
      ]),
    ).not.toBeNull();
  });

  it("fails closed for absent, ambiguous, and malformed current winners", () => {
    expect(observationOnlyToolBlockReason("read", { path: "state.json" }, [])).not.toBeNull();
    expect(
      observationOnlyToolBlockReason("read", { path: "state.json" }, [
        builtinTool("read"),
        builtinTool("read"),
      ]),
    ).not.toBeNull();
    expect(
      observationOnlyToolBlockReason("read", { path: "state.json" }, [
        {
          ...builtinTool("read"),
          sourceInfo: { ...builtinTool("read").sourceInfo!, path: "<builtin:write>" },
        },
      ]),
    ).not.toBeNull();
  });

  it("preserves recursive xd device action checks behind a trusted builtin write", () => {
    const tools = [builtinTool("write")];
    expect(
      observationOnlyToolBlockReason(
        "write",
        {
          path: "xd://github",
          content: JSON.stringify({ op: "file_read", path: "package.json" }),
        },
        tools,
      ),
    ).toBeNull();
    expect(
      observationOnlyToolBlockReason(
        "write",
        {
          path: "xd://github",
          content: JSON.stringify({ op: "pr_create", title: "mutation" }),
        },
        tools,
      ),
    ).not.toBeNull();
    expect(
      observationOnlyToolBlockReason(
        "write",
        {
          path: "xd://evil.github",
          content: JSON.stringify({ op: "file_read", path: "package.json" }),
        },
        tools,
      ),
    ).not.toBeNull();
  });
  it("fails closed for malformed ownership metadata and winner shapes", () => {
    const blocked = "This workflow step is observation-only; tool read is not allowed.";
    const malformedBuiltins: ToolInfo[] = [
      { name: "read" },
      {
        ...builtinTool("read"),
        sourceInfo: { ...builtinTool("read").sourceInfo!, scope: "user" },
      },
      {
        ...builtinTool("read"),
        sourceInfo: { ...builtinTool("read").sourceInfo!, origin: "package" },
      },
      {
        ...builtinTool("read"),
        sourceInfo: { ...builtinTool("read").sourceInfo!, baseDir: PACKAGE_DIR },
      },
    ];
    for (const tool of malformedBuiltins) {
      expect(observationOnlyToolBlockReason("read", { path: "state.json" }, tool)).toBe(blocked);
    }

    expect(observationOnlyToolBlockReason("read", undefined, builtinTool("read"))).toBeNull();
    expect(observationOnlyToolBlockReason("read", {}, undefined)).toBe(blocked);
    expect(observationOnlyToolBlockReason("read", {}, builtinTool("grep"))).toBe(blocked);
    expect(observationOnlyToolBlockReason("read", {}, 42 as unknown as ToolInfo)).toBe(blocked);
    expect(
      observationOnlyToolBlockReason("read", {}, [
        null,
        undefined,
        builtinTool("read"),
      ] as unknown as ToolInfo[]),
    ).toBeNull();

    const malformedWorkflowTools: ToolInfo[] = [
      { name: "workflow" },
      {
        name: "workflow",
        sourceInfo: {
          path: 42 as unknown as string,
          source: "local",
          scope: "temporary",
          origin: "top-level",
        },
      },
      {
        name: "workflow",
        sourceInfo: {
          path: "workflow.ts",
          source: "local",
          scope: "temporary",
          origin: "top-level",
          baseDir: "   ",
        },
      },
      {
        name: "workflow",
        sourceInfo: {
          path: path.join(PACKAGE_DIR, "does-not-exist", "workflow.ts"),
          source: "local",
          scope: "temporary",
          origin: "top-level",
        },
      },
    ];
    for (const tool of malformedWorkflowTools) {
      expect(observationOnlyToolBlockReason("workflow", { action: "status" }, tool)).not.toBeNull();
    }
  });

  it("admits only observation-safe operations for trusted host tools", () => {
    const cases: Array<{ toolName: string; input: unknown; allowed: boolean }> = [
      { toolName: "hub", input: { op: "logs" }, allowed: true },
      { toolName: "hub", input: { op: "send" }, allowed: false },
      { toolName: "github", input: { op: "file_read" }, allowed: true },
      { toolName: "github", input: { op: "pr_create" }, allowed: false },
      { toolName: "lsp", input: { action: "hover" }, allowed: true },
      { toolName: "lsp", input: { action: "rename" }, allowed: false },
      { toolName: "write", input: { path: "xd://hub", content: 42 }, allowed: false },
      {
        toolName: "write",
        input: { path: "xd://hub", content: "not-json{" },
        allowed: false,
      },
      { toolName: "bash", input: { command: "git status" }, allowed: false },
    ];

    for (const { toolName, input, allowed } of cases) {
      const reason = observationOnlyToolBlockReason(toolName, input, builtinTool(toolName));
      expect(reason === null, `${toolName} ${JSON.stringify(input)}`).toBe(allowed);
    }
  });
});
