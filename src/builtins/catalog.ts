import { BuiltinWorkflowCatalog } from "../workflows/catalog.js";
import autodocWorkflow from "./autodoc.workflow.js";
import autoimplementWorkflow from "./autoimplement.workflow.js";
import autoplanWorkflow from "./autoplan.workflow.js";
import monitorWorkflow from "./monitor.workflow.js";
import planApprovalWorkflow from "./plan-approval.workflow.js";
import sanityCheckWorkflow from "./sanity-check.workflow.js";

export const builtinWorkflowCatalog = new BuiltinWorkflowCatalog([
  {
    id: "autoplan",
    revision: "1",
    definitionDigest: "sha256:c25be200e438e09f7c5a52fb01dc0f325323193715272c5a63daeb3fc8c804f9",
    definition: autoplanWorkflow,
  },
  {
    id: "autodoc",
    revision: "3",
    definitionDigest: "sha256:6f85f8e57cd2205cb9402a4281e9b2fb9a0a9ffcad942805246bda1ea19dec93",
    definition: autodocWorkflow,
  },
  {
    id: "autoimplement",
    revision: "12",
    definitionDigest: "sha256:714d016d2de1b01b3e886763321222b095e7cd0dfa19f8f523d5a49fe9a880e0",
    definition: autoimplementWorkflow,
  },
  {
    id: "plan-approval",
    revision: "4",
    definitionDigest: "sha256:fc52c790a4dc9d4f655a54675aaaaa06328e4adcec2c14c8b6f17bc082a1ddff",
    definition: planApprovalWorkflow,
  },
  {
    id: "sanity-check",
    revision: "3",
    definitionDigest: "sha256:ebebb86dc2eb83c4510dfb79840014b1d4d02a27974ecec9f080cabb05fae5df",
    definition: sanityCheckWorkflow,
  },
  {
    id: "monitor",
    revision: "11",
    definitionDigest: "sha256:68e760f74bbe7c40f83b6f8440c41c776d0dcc5f1953007e0263c7501a331b65",
    definition: monitorWorkflow,
    legacySources: [
      {
        workflowHash: "7a22158da94d18ec1c9fe42e70d72017a4e0620d5e5142ae839d0cd6eea55c06",
        revision: "2",
        pathSuffixes: [
          "/src/builtins/monitor.workflow.ts",
          "/dist/builtins/monitor.workflow.js",
          "/src/workflows/monitor.workflow.ts",
          "/dist/workflows/monitor.workflow.js",
        ],
      },
      {
        workflowHash: "352fc09c88922c7375281b52f049c1039d05441ce37f2082f5ff07fea66d5318",
        revision: "2",
        pathSuffixes: ["/dist/builtins/monitor.workflow.js"],
      },
      {
        workflowHash: "dc601e2323a8213f5d52fa555e804ae8ed0846f809b3a1e9e5073a3c9c3a114e",
        revision: "2",
        pathSuffixes: ["/dist/builtins/monitor.workflow.js"],
      },
    ],
  },
]);
