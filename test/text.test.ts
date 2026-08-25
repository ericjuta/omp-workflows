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

  it("redacts namespaced secret assignments", () => {
    const text = [
      "OPENAI_API_KEY=sk-live-secret",
      "export GITHUB_TOKEN='ghp_live_secret'",
      'AWS_SECRET_ACCESS_KEY="aws-secret-access-key"',
      "SESSION_COOKIE=session-cookie-value",
    ].join("\n");

    const redacted = redactSensitiveText(text);

    expect(redacted).not.toMatch(
      /sk-live-secret|ghp_live_secret|aws-secret-access-key|session-cookie-value/,
    );
    expect(redacted).toBe(
      [
        "OPENAI_API_KEY=[redacted]",
        "export GITHUB_TOKEN='[redacted]'",
        'AWS_SECRET_ACCESS_KEY="[redacted]"',
        "SESSION_COOKIE=[redacted]",
      ].join("\n"),
    );
  });

  it("redacts Basic auth, cookies, private keys, and URI userinfo", () => {
    const text = [
      "Basic dXNlcjpwYXNz",
      "Cookie: session=cookie-secret; csrf=csrf-secret",
      "Set-Cookie: refresh=refresh-secret; HttpOnly",
      "clone https://git-user:git-password@example.test/repository.git",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "private-key-material",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");

    const redacted = redactSensitiveText(text);

    expect(redacted).not.toMatch(
      /dXNlcjpwYXNz|cookie-secret|csrf-secret|refresh-secret|git-user|git-password|private-key-material/,
    );
    expect(redacted).toContain("Basic [redacted]");
    expect(redacted).toContain("Cookie: [redacted]");
    expect(redacted).toContain("Set-Cookie: [redacted]");
    expect(redacted).toContain("https://[redacted]@example.test/repository.git");
    expect(redacted).toContain("[private key redacted]");
  });

  it("redacts sensitive URL query values without changing other parameters", () => {
    expect(
      redactSensitiveText(
        "GET https://example.test/items?token=query-token&api-key=query-key&X-Amz-Signature=aws-signature&X-Goog-Signature=google-signature&sig=short-signature&page=2#details",
      ),
    ).toBe(
      "GET https://example.test/items?token=[redacted]&api-key=[redacted]&X-Amz-Signature=[redacted]&X-Goog-Signature=[redacted]&sig=[redacted]&page=2#details",
    );
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
      '{"message":"request failed","tokenCount":3,"secret_sauce":"recipe"} PATH=/usr/bin:/bin NODE_ENV=production Basic documentation https://example.test/items?page=2';

    expect(redactSensitiveText(text)).toBe(text);
  });
});
