export const WORKFLOW_OBSERVATION_ONLY_ENV = "PI_WORKFLOWS_OBSERVATION_ONLY";

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

function blocked(toolName: string): string {
  return `This workflow step is observation-only; tool ${toolName} is not allowed.`;
}

export function observationOnlyToolBlockReason(toolName: string, input?: unknown): string | null {
  const shortName = toolName.toLowerCase().split(/[.:/]/).at(-1) ?? toolName.toLowerCase();
  const record =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  if (READ_TOOLS[shortName] === true) return null;
  if (shortName === "workflow" && WORKFLOW_ACTIONS[String(record.action)] === true) return null;
  if (shortName === "write" && typeof record.path === "string" && record.path.startsWith("xd://")) {
    const deviceName = record.path.slice("xd://".length);
    if (typeof record.content !== "string") return blocked(toolName);
    try {
      return observationOnlyToolBlockReason(
        deviceName,
        JSON.parse(record.content) as Record<string, unknown>,
      );
    } catch {
      return blocked(toolName);
    }
  }
  if (shortName === "hub" && HUB_OPS[String(record.op)] === true) return null;
  if (shortName === "github" && GITHUB_OPS[String(record.op)] === true) return null;
  if (shortName === "lsp" && LSP_ACTIONS[String(record.action)] === true) return null;
  return blocked(toolName);
}
