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
    revision: "2",
    definitionDigest: "sha256:d24a183306754a6dd83e71b56976e9cbed13b19a919c3ae8fa43e010bf6aac11",
    definition: autoplanWorkflow,
  },
  {
    id: "autodoc",
    revision: "4",
    definitionDigest: "sha256:ed630127a5fe44f054111aa3b3c75c40c722e99160e681b7ce7030d76884b058",
    definition: autodocWorkflow,
  },
  {
    id: "autoimplement",
    revision: "16",
    definitionDigest: "sha256:051abf4bf638e1f1984c19a6656da8057f64c0571c604e98eac500ede733385d",
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
    revision: "12",
    definitionDigest: "sha256:375fb95c240443dd580bc5ea9da02b39678b8162296fa6bec51b526c25321bb7",
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
