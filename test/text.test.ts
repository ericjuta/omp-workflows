import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../src/workflows/text.js";

describe("redactSensitiveText", () => {
  it("redacts quoted JSON credential values", () => {
    const text = JSON.stringify({
      token: "json-token",
      api_key: "json-api-key",
      secret: "json-secret",
      password: "json-password",
      authorization: "Basic json-authorization",
      message: "request failed",
    });

    const redacted = redactSensitiveText(text);

    expect(redacted).not.toMatch(
      /json-token|json-api-key|json-secret|json-password|json-authorization/,
    );
    expect(redacted).toContain('"token":"[redacted]"');
    expect(redacted).toContain('"message":"request failed"');
  });
  it("redacts credentials in escaped JSON diagnostics", () => {
    const text = String.raw`request failed with {\"api_key\":\"sk-live-secret\"}`;

    const redacted = redactSensitiveText(text);

    expect(redacted).toContain(String.raw`\"[redacted]\"`);
    expect(redacted).not.toContain("sk-live-secret");
  });

  it("redacts authorization and API key headers", () => {
    const text = [
      "Authorization: Basic header-secret",
      "X-Api-Key: header-api-key",
      "Content-Type: application/json",
    ].join("\n");

    expect(redactSensitiveText(text)).toBe(
      ["Authorization: [redacted]", "X-Api-Key: [redacted]", "Content-Type: application/json"].join(
        "\n",
      ),
    );
  });

  it("redacts Bearer tokens outside headers", () => {
    expect(redactSensitiveText("request failed with Bearer bearer-token at upstream")).toBe(
      "request failed with Bearer [redacted] at upstream",
    );
  });

  it("redacts sensitive URL query values without changing other parameters", () => {
    expect(
      redactSensitiveText(
        "GET https://example.test/items?token=query-token&api-key=query-key&page=2#details",
      ),
    ).toBe("GET https://example.test/items?token=[redacted]&api-key=[redacted]&page=2#details");
  });

  it("redacts multiline quoted values", () => {
    const text = '{"password":"first line\nsecond line","message":"visible\ncontext"}';

    expect(redactSensitiveText(text)).toBe(
      '{"password":"[redacted]","message":"visible\ncontext"}',
    );
  });

  it("truncates only after secrets have been redacted", () => {
    const text = `prefix token=${"s".repeat(100)} visible suffix`;
    const redacted = redactSensitiveText(text, 32);

    expect(redacted).toHaveLength(32);
    expect(redacted).not.toContain("ssss");
    expect(redacted).toBe("prefix token=… [error truncated]");
  });

  it("preserves nonsecret text", () => {
    const text =
      '{"message":"request failed","tokenCount":3,"secret_sauce":"recipe"} https://example.test/items?page=2';

    expect(redactSensitiveText(text)).toBe(text);
  });
});
