import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKFLOW_OBSERVATION_ONLY_ENV = "PI_WORKFLOWS_OBSERVATION_ONLY";

export interface ToolSourceInfo {
  path: string;
  source: string;
  scope?: "user" | "project" | "temporary";
  origin?: "package" | "top-level";
  baseDir?: string;
}

export interface ToolInfo {
  name: string;
  description?: string;
  parameters?: unknown;
  promptGuidelines?: string[];
  sourceInfo?: ToolSourceInfo;
}

const READ_TOOLS: Readonly<Record<string, true>> = {
  read: true,
  grep: true,
  glob: true,
  find: true,
  ls: true,
  web_search: true,
  inspect_image: true,
  ast_grep: true,
  recall: true,
  reflect: true,
};

const WORKFLOW_ACTIONS: Readonly<Record<string, true>> = {
  submit: true,
  update: true,
  list: true,
  status: true,
};

const HUB_OPS: Readonly<Record<string, true>> = {
  list: true,
  jobs: true,
  ps: true,
  logs: true,
  describe: true,
  wait: true,
  inbox: true,
};

const GITHUB_OPS: Readonly<Record<string, true>> = {
  repo_view: true,
  file_read: true,
  search_issues: true,
  search_prs: true,
  search_code: true,
  search_commits: true,
  search_repos: true,
  run_watch: true,
};

const LSP_ACTIONS: Readonly<Record<string, true>> = {
  diagnostics: true,
  definition: true,
  references: true,
  hover: true,
  symbols: true,
  type_definition: true,
  implementation: true,
  status: true,
  capabilities: true,
};

let cachedCanonicalPackageDir: string | null = null;

function canonicalPackageBaseDir(): string {
  if (!cachedCanonicalPackageDir) {
    const rawPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    cachedCanonicalPackageDir = fs.realpathSync(rawPath);
  }
  return cachedCanonicalPackageDir;
}

export function isTrustedBuiltinTool(tool: ToolInfo): boolean {
  if (!tool.sourceInfo || typeof tool.sourceInfo !== "object") return false;
  const { source, scope, origin, path: toolSourcePath, baseDir } = tool.sourceInfo;
  if (source !== "builtin") return false;
  if (scope !== "temporary") return false;
  if (origin !== "top-level") return false;
  if (baseDir !== undefined) return false;
  return toolSourcePath === `<builtin:${tool.name}>`;
}

export function isTrustedWorkflowTool(tool: ToolInfo): boolean {
  if (!tool.sourceInfo || typeof tool.sourceInfo !== "object") return false;
  const { path: toolPath, baseDir } = tool.sourceInfo;
  const toolDirectory =
    baseDir ?? (typeof toolPath === "string" ? path.dirname(toolPath) : undefined);
  if (typeof toolDirectory !== "string" || toolDirectory.trim() === "") return false;
  let canonicalToolDirectory: string;
  let canonicalExpectedBaseDir: string;
  try {
    canonicalToolDirectory = fs.realpathSync(path.resolve(toolDirectory));
    canonicalExpectedBaseDir = canonicalPackageBaseDir();
  } catch {
    return false;
  }
  const relativeOwnerPath = path.relative(canonicalExpectedBaseDir, canonicalToolDirectory);
  return (
    relativeOwnerPath === "" ||
    (relativeOwnerPath !== ".." &&
      !relativeOwnerPath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeOwnerPath))
  );
}

function findWinningTool(
  toolName: string,
  tools?: ToolInfo | ToolInfo[] | null,
): { status: "ok"; tool: ToolInfo } | { status: "missing" } | { status: "ambiguous" } {
  if (!tools) {
    return { status: "missing" };
  }
  if (Array.isArray(tools)) {
    const matches = tools.filter((t) => t && t.name === toolName);
    if (matches.length === 0) return { status: "missing" };
    if (matches.length > 1) return { status: "ambiguous" };
    return { status: "ok", tool: matches[0]! };
  }
  if (typeof tools === "object" && tools !== null && "name" in tools) {
    if (tools.name !== toolName) return { status: "missing" };
    return { status: "ok", tool: tools };
  }
  return { status: "missing" };
}

function blocked(toolName: string): string {
  return `This workflow step is observation-only; tool ${toolName} is not allowed.`;
}

function observationOnlyInputAllowed(toolName: string, input?: unknown): boolean {
  const record =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  if (READ_TOOLS[toolName] === true) return true;
  if (toolName === "workflow") return WORKFLOW_ACTIONS[String(record.action)] === true;
  if (toolName === "write" && typeof record.path === "string" && record.path.startsWith("xd://")) {
    if (typeof record.content !== "string") return false;
    const deviceName = record.path.slice("xd://".length);
    try {
      return observationOnlyInputAllowed(deviceName, JSON.parse(record.content));
    } catch {
      return false;
    }
  }
  if (toolName === "hub") return HUB_OPS[String(record.op)] === true;
  if (toolName === "github") return GITHUB_OPS[String(record.op)] === true;
  if (toolName === "lsp") return LSP_ACTIONS[String(record.action)] === true;
  return false;
}

export function observationOnlyToolBlockReason(
  toolName: string,
  input?: unknown,
  tools?: ToolInfo | ToolInfo[] | null,
): string | null {
  const winner = findWinningTool(toolName, tools);
  if (winner.status !== "ok" || !observationOnlyInputAllowed(toolName, input)) {
    return blocked(toolName);
  }
  const trusted =
    toolName === "workflow"
      ? isTrustedWorkflowTool(winner.tool)
      : isTrustedBuiltinTool(winner.tool);
  return trusted ? null : blocked(toolName);
}
