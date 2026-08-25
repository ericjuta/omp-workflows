import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function resourcesCapability(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => ({ skillPaths: [] }));
}
