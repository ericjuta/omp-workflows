import type { OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function oauthProvider(pi: ExtensionAPI): void {
  pi.registerProvider("fixture-legacy", {
    baseUrl: process.env.PI_AGENT_FIXTURE_BASE_URL ?? "http://127.0.0.1:1/v1",
    api: "openai-completions",
    models: [
      {
        id: "fixture-legacy-model",
        name: "Fixture OAuth model",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
      },
    ],
    oauth: {
      name: "Fixture OAuth",
      async login(): Promise<OAuthCredentials> {
        throw new Error("fixture login is not available");
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        return {
          refresh: credentials.refresh,
          access: "rotated-access-token",
          expires: Date.now() + 60_000,
        };
      },
      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },
    },
  });
}
