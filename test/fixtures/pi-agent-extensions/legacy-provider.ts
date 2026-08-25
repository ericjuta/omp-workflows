import fs from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function legacyProvider(pi: ExtensionAPI): void {
  pi.registerProvider("fixture-legacy", {
    baseUrl: process.env.PI_AGENT_FIXTURE_BASE_URL ?? "http://127.0.0.1:1/v1",
    apiKey: "$PI_AGENT_FIXTURE_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "fixture-legacy-model",
        name: "Fixture legacy model",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
      },
    ],
  });

  const record = async (event: string) => {
    const marker = process.env.PI_AGENT_FIXTURE_LIFECYCLE_FILE;
    if (marker) await fs.appendFile(marker, `${event}\n`, "utf8");
  };
  pi.on("session_start", async () => await record("session_start"));
  pi.on("session_shutdown", async () => await record("session_shutdown"));
}
