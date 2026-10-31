import { describe, expect, it } from "vitest";
import { createRedactor, scrubSecrets } from "../services/redact.js";

describe("secret redaction", () => {
  const token = "ghp_short1234";
  const groq = "gsk_myGroqKey99";

  it("masks known secrets in every encoding git or HTTP clients use", () => {
    const redact = createRedactor([token, groq]);
    const basicAuth = Buffer.from(`x-access-token:${token}`).toString("base64");
    const plainB64 = Buffer.from(token).toString("base64");
    const text = [
      `token=${token}`,
      `header: AUTHORIZATION: basic ${basicAuth}`,
      `b64=${plainB64}`,
      `groq ${groq}`,
    ].join("\n");
    const out = redact(text);
    for (const secret of [token, groq, basicAuth, plainB64]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("token=***");
  });

  it("replaces server paths", () => {
    const redact = createRedactor([], {
      paths: [{ value: "C:\\Temp\\repomind-jobs\\__repomind_1", replacement: "<workdir>" }],
    });
    expect(redact("fatal: C:\\Temp\\repomind-jobs\\__repomind_1\\x and C:/Temp/repomind-jobs/__repomind_1/y")).toBe(
      "fatal: <workdir>\\x and <workdir>/y",
    );
  });

  it("scrubs token-shaped strings even when they are not known", () => {
    const classic = `ghp_${"a".repeat(36)}`;
    const fine = `github_pat_${"B".repeat(30)}_${"c".repeat(20)}`;
    const groqKey = `gsk_${"Z".repeat(40)}`;
    const out = scrubSecrets(
      `${classic} ${fine} ${groqKey} Authorization: Bearer abc.def https://user:pass@github.com/a/b`,
    );
    expect(out).not.toContain(classic);
    expect(out).not.toContain(fine);
    expect(out).not.toContain(groqKey);
    expect(out).toContain("Authorization: Bearer ***");
    expect(out).toContain("https://***@github.com/a/b");
  });

  it("handles empty input", () => {
    expect(createRedactor(["", null, "abc"])(undefined)).toBe("");
  });
});
