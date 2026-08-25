import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  WORKFLOW_OBSERVATION_ONLY_ENV,
  observationOnlyToolBlockReason,
  type ToolInfo,
} from "../workflows/observation-tool-policy.js";
import {
  parseWorkflowSubmissionInput,
  WorkflowSubmissionToolParameters,
} from "../workflows/tool-input.js";

export const RPC_SUBMISSION_PREFIX = "PI_WORKFLOWS_STEP_SUBMISSION ";

/**
 * Loaded into headless `omp --mode rpc` children spawned by the standalone
 * host. The child has no workflow engine, so this bridge only registers the
 * `workflow` tool and reports every submission to the host over stderr; the
 * host validates against the engine and re-prompts on rejection.
 */
export default function piWorkflowsRpcBridge(pi: ExtensionAPI) {
  if (process.env[WORKFLOW_OBSERVATION_ONLY_ENV] === "1") {
    pi.on("tool_call", (event) => {
      let currentTools: ToolInfo[];
      try {
        currentTools = pi.getAllTools();
      } catch {
        currentTools = [];
      }
      const reason = observationOnlyToolBlockReason(event.toolName, event.input, currentTools);
      return reason === null ? undefined : { block: true, reason };
    });
  }

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Publish an update or submit the output for the pending workflow step.",
      "Only call this tool when a workflow step contract in the conversation asks you to.",
      "Pass the exact step and attempt ids from the contract.",
    ].join(" "),
    parameters: WorkflowSubmissionToolParameters,
    async execute(toolCallId, rawParams) {
      const params = parseWorkflowSubmissionInput(rawParams);
      process.stderr.write(
        `${RPC_SUBMISSION_PREFIX}${JSON.stringify({ ...params, idempotencyKey: toolCallId })}\n`,
      );
      return {
        content: [
          {
            type: "text",
            text:
              params.action === "update"
                ? "Workflow update recorded; continue the current step."
                : "Submission recorded. Continue only when the workflow sends the next step.",
          },
        ],
        details: {},
      };
    },
  });
}
