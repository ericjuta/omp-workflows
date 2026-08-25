import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function commandCapability(pi: ExtensionAPI): void {
  pi.registerCommand("workflow-child", {
    description: "A forbidden child workflow command.",
    handler: async () => {},
  });
}
