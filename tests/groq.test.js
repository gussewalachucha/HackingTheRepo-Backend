import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GROQ_CHAT_URL,
  LlmError,
  createGroqClient,
  describeGroqError,
  extractJson,
  parseApiKeys,
  resetGroqKeyHealth,
} from "../services/groq.js";

function httpError(status, message, { headers = {}, code, failed_generation } = {}) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = {
    status,
    headers,
    data: { error: { message, code, failed_generation } },
  };
  return error;
}

function reply(content, finishReason = "stop") {
  return { data: { choices: [{ message: { content }, finish_reason: finishReason }] } };
}

function fakeHttp(...outcomes) {
  const post = vi.fn(async () => {
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return { post };
}

const budget = { structureChars: 12000, contextChars: 24000 };
const build = vi.fn((b) => [
  { role: "system", content: "sys" },
  { role: "user", content: `ctx ${b.contextChars}` },
]);

function client(http, extra = {}) {
  return createGroqClient({
    apiKey: "gsk_unit_test_key",
    model: "test-model",
    maxOutputTokens: 8192,
    http,
    sleep: vi.fn(async () => {}),
    ...extra,
  });
}

afterEach(() => {
  build.mockClear();
  resetGroqKeyHealth();
});

describe("extractJson", () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ['```json\n{"a":1}\n```', { a: 1 }],
    ['Sure! Here it is:\n{"a":{"b":[1,2]}}\nThanks.', { a: { b: [1, 2] } }],
    ['{"code":"if (x) { y(); }","md":"```js\\nx\\n```"}', { code: "if (x) { y(); }", md: "```js\nx\n```" }],
    ['noise {"broken": } then {"ok": true}', { ok: true }],
  ])("extracts %j", (text, expected) => {
    expect(extractJson(text)).toEqual(expected);
  });

  it.each([[""], ["not json"], ["[1,2,3]"], ['{"a": ']])("rejects %j", (text) => {
    expect(() => extractJson(text)).toThrow();
  });
});

describe("Groq client", () => {
  it("sends JSON mode with the configured model and limits", async () => {
    const http = fakeHttp(reply('{"analysis":"ok","plan":[]}'));
    const value = await client(http).completeJson({ step: "analyze", buildMessages: build, budget });
    expect(value).toEqual({ analysis: "ok", plan: [] });
    const [url, body, config] = http.post.mock.calls[0];
    expect(url).toBe(GROQ_CHAT_URL);
    expect(body).toMatchObject({
      model: "test-model",
      temperature: 0.2,
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
    });
    expect(config.headers.Authorization).toBe("Bearer gsk_unit_test_key");
    expect(config.timeout).toBeGreaterThan(0);
  });

  it("retries 429 responses honouring retry-after", async () => {
    const sleep = vi.fn(async () => {});
    const http = fakeHttp(
      httpError(429, "Rate limit reached. Please try again in 1.5s.", { headers: { "retry-after": "2" } }),
      reply('{"ok":true}'),
    );
    const value = await client(http, { sleep }).completeJson({ step: "edit", buildMessages: build, budget });
    expect(value).toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(2000, undefined);
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 retries", async () => {
    const http = fakeHttp(
      httpError(503, "down"),
      httpError(503, "down"),
      httpError(503, "down"),
      httpError(503, "down"),
    );
    await expect(
      client(http).completeJson({ step: "edit", buildMessages: build, budget }),
    ).rejects.toThrow(/unavailable/);
    expect(http.post).toHaveBeenCalledTimes(4);
  });

  it("fails fast when the rate limit resets in more than 60 seconds", async () => {
    const sleep = vi.fn(async () => {});
    const http = fakeHttp(
      httpError(429, "Rate limit reached on tokens per day (TPD): Limit 200000, Used 199000, Requested 5000. Please try again in 7m12s."),
    );
    await expect(
      client(http, { sleep }).completeJson({ step: "edit", buildMessages: build, budget }),
    ).rejects.toThrow(/rate limit reached.*Try again in 8 min/i);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("halves the context and lowers max tokens after a too-large error", async () => {
    const http = fakeHttp(
      httpError(413, "Request too large for model `test-model` on tokens per minute (TPM): Limit 8000, Requested 17000, please reduce your message size and try again."),
      reply('{"ok":1}'),
    );
    const groq = client(http);
    const value = await groq.completeJson({ step: "analyze", buildMessages: build, budget });
    expect(value).toEqual({ ok: 1 });
    expect(groq.tokenLimit()).toBe(8000);
    // The small prompt already fits: only the reply budget is lowered.
    expect(build.mock.calls[0][0]).toEqual(budget);
    const retried = http.post.mock.calls[1][1];
    expect(retried.max_completion_tokens).toBeLessThan(8000);
    expect(retried.max_completion_tokens).toBeGreaterThanOrEqual(512);
  });

  it("shrinks a large prompt to fit the plan's limit learned from Groq's headers", async () => {
    const big = vi.fn((b) => [{ role: "user", content: "x".repeat(b.contextChars) }]);
    const http = fakeHttp(
      { ...reply('{"ok":1}'), headers: { "x-ratelimit-limit-tokens": "8000" } },
      reply('{"ok":2}'),
    );
    const groq = client(http, { model: "openai/gpt-oss-120b" });
    await groq.completeJson({ step: "analyze", buildMessages: big, budget, reasoningEffort: "high" });
    expect(groq.tokenLimit()).toBe(8000);
    await groq.completeJson({ step: "file", buildMessages: big, budget, maxTokens: 16384, reasoningEffort: "high" });
    const second = http.post.mock.calls[1][1];
    const promptTokens = Math.ceil((second.messages[0].content.length + 16) / 3.2);
    expect(promptTokens + second.max_completion_tokens).toBeLessThanOrEqual(8000);
    expect(second.max_completion_tokens).toBeGreaterThanOrEqual(3000);
    expect(second.reasoning_effort).toBe("low");
  });

  it("retries with lighter reasoning when the reply is empty because thinking used the budget", async () => {
    const http = fakeHttp(reply("", "length"), reply('{"ok":true}'));
    await client(http, { model: "openai/gpt-oss-120b" }).completeJson({
      step: "file",
      buildMessages: build,
      budget,
      reasoningEffort: "high",
    });
    expect(http.post.mock.calls[0][1].reasoning_effort).toBe("high");
    expect(http.post.mock.calls[1][1].reasoning_effort).toBe("low");
    expect(http.post.mock.calls[1][1].messages).toHaveLength(2); // no format-repair note
  });

  it("only shrinks once", async () => {
    const tooLarge = () => httpError(413, "Request too large: Limit 8000, Requested 9000");
    const http = fakeHttp(tooLarge(), tooLarge(), tooLarge());
    await expect(
      client(http).completeJson({ step: "analyze", buildMessages: build, budget }),
    ).rejects.toThrow(/too large/);
    expect(http.post).toHaveBeenCalledTimes(3);
  });

  it("applies per-call output budget, temperature and reasoning effort (gpt-oss only)", async () => {
    const http = fakeHttp(reply('{"ok":true}'), reply('{"ok":true}'));
    const options = { step: "file", buildMessages: build, budget, maxTokens: 16384, reasoningEffort: "high", temperature: 0.3 };
    await client(http, { model: "openai/gpt-oss-120b" }).completeJson(options);
    expect(http.post.mock.calls[0][1]).toMatchObject({
      max_completion_tokens: 16384,
      reasoning_effort: "high",
      temperature: 0.3,
    });
    await client(http, { model: "llama-3.3-70b-versatile" }).completeJson(options);
    expect(http.post.mock.calls[1][1]).not.toHaveProperty("reasoning_effort");
  });

  it("retries without reasoning_effort when the model rejects it", async () => {
    const http = fakeHttp(httpError(400, "`reasoning_effort` is not supported with this model"), reply('{"ok":true}'));
    await client(http, { model: "openai/gpt-oss-20b" }).completeJson({
      step: "file",
      buildMessages: build,
      budget,
      reasoningEffort: "high",
    });
    expect(http.post.mock.calls[0][1].reasoning_effort).toBe("high");
    expect(http.post.mock.calls[1][1]).not.toHaveProperty("reasoning_effort");
  });

  it("retries without response_format when the model rejects JSON mode", async () => {
    const http = fakeHttp(
      httpError(400, "response_format `json_object` is not supported with this model"),
      reply('{"ok":true}'),
    );
    await client(http).completeJson({ step: "analyze", buildMessages: build, budget });
    expect(http.post.mock.calls[0][1].response_format).toEqual({ type: "json_object" });
    expect(http.post.mock.calls[1][1]).not.toHaveProperty("response_format");
  });

  it("makes one repair request for invalid JSON or missing fields", async () => {
    const http = fakeHttp(reply("I think you should edit the file."), reply('{"changes":[]}'));
    const validate = (value) =>
      Array.isArray(value.changes) ? { ok: true, value } : { ok: false, error: "missing changes" };
    const value = await client(http).completeJson({ step: "edit", buildMessages: build, budget, validate });
    expect(value).toEqual({ changes: [] });
    const repairMessages = http.post.mock.calls[1][1].messages;
    expect(repairMessages.at(-1).role).toBe("user");
    expect(repairMessages.at(-1).content).toMatch(/could not be used/);
  });

  it("gives up after the repair attempt", async () => {
    const http = fakeHttp(reply("nope"), reply('{"other":1}'));
    const validate = (value) =>
      value.changes ? { ok: true, value } : { ok: false, error: 'the "changes" array is missing' };
    await expect(
      client(http).completeJson({ step: "edit", buildMessages: build, budget, validate }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it("uses Groq's failed_generation when JSON validation fails server-side", async () => {
    const http = fakeHttp(
      httpError(400, "Failed to generate JSON", {
        code: "json_validate_failed",
        failed_generation: 'Here: {"recovered": true}',
      }),
    );
    const value = await client(http).completeJson({ step: "edit", buildMessages: build, budget });
    expect(value).toEqual({ recovered: true });
  });

  it("maps a bad API key to a friendly error", async () => {
    const http = fakeHttp(httpError(401, "Invalid API Key"));
    await expect(
      client(http).completeJson({ step: "analyze", buildMessages: build, budget }),
    ).rejects.toThrow(/Groq key in Settings/);
  });

  it("stops when the job is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("job timed out"));
    const http = { post: vi.fn(async () => { throw new Error("canceled"); }) };
    await expect(
      client(http).completeJson({ step: "analyze", buildMessages: build, budget, signal: controller.signal }),
    ).rejects.toThrow(/job timed out/);
  });

  it("classifies errors", () => {
    expect(describeGroqError(httpError(413, "Request too large")).tooLarge).toBe(true);
    expect(describeGroqError(httpError(400, "x", { code: "context_length_exceeded" })).tooLarge).toBe(true);
    const rate = describeGroqError(httpError(429, "Please try again in 1m2.5s"));
    expect(rate).toMatchObject({ retryable: true, retryAfterMs: 62500 });
    const network = new Error("socket hang up");
    network.code = "ECONNRESET";
    expect(describeGroqError(network).retryable).toBe(true);
  });
});

describe("several Groq keys", () => {
  const keysUsed = (http) => http.post.mock.calls.map(([, , config]) => config.headers.Authorization.slice(7));

  it("parses keys from new lines, commas and spaces, without duplicates", () => {
    expect(parseApiKeys("gsk_a\ngsk_b, gsk_c", ["gsk_b gsk_d"], undefined)).toEqual(["gsk_a", "gsk_b", "gsk_c", "gsk_d"]);
  });

  it("switches to the next key when one is expired", async () => {
    const log = vi.fn(async () => {});
    const http = fakeHttp(httpError(401, "Invalid API Key"), reply('{"ok":true}'));
    const value = await client(http, { apiKey: undefined, apiKeys: ["gsk_old", "gsk_new"], log })
      .completeJson({ step: "analyze", buildMessages: build, budget });
    expect(value).toEqual({ ok: true });
    expect(keysUsed(http)).toEqual(["gsk_old", "gsk_new"]);
    expect(log).toHaveBeenCalledWith("warn", expect.stringMatching(/rejected API key 1 of 2.*switching to key 2 of 2/));
  });

  it("remembers an expired key so the next job starts with a working one", async () => {
    const options = { apiKey: undefined, apiKeys: ["gsk_old", "gsk_new"] };
    await client(fakeHttp(httpError(401, "Invalid API Key"), reply('{"ok":1}')), options)
      .completeJson({ step: "analyze", buildMessages: build, budget });
    const http = fakeHttp(reply('{"ok":2}'));
    await client(http, options).completeJson({ step: "analyze", buildMessages: build, budget });
    expect(keysUsed(http)).toEqual(["gsk_new"]);
  });

  it("uses another key at once instead of waiting out a rate limit", async () => {
    const sleep = vi.fn(async () => {});
    const http = fakeHttp(
      httpError(429, "Rate limit reached on tokens per day (TPD). Please try again in 7m12s."),
      reply('{"ok":true}'),
    );
    await client(http, { apiKey: undefined, apiKeys: ["gsk_a", "gsk_b"], sleep })
      .completeJson({ step: "file", buildMessages: build, budget });
    expect(keysUsed(http)).toEqual(["gsk_a", "gsk_b"]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits for the soonest key when every key is rate limited", async () => {
    const sleep = vi.fn(async () => {});
    const http = fakeHttp(
      httpError(429, "Rate limit", { headers: { "retry-after": "5" } }),
      httpError(429, "Rate limit", { headers: { "retry-after": "2" } }),
      reply('{"ok":true}'),
    );
    await client(http, { apiKey: undefined, apiKeys: ["gsk_a", "gsk_b"], sleep })
      .completeJson({ step: "file", buildMessages: build, budget });
    expect(sleep).toHaveBeenCalledWith(2000, undefined);
    expect(keysUsed(http)).toEqual(["gsk_a", "gsk_b", "gsk_b"]);
  });

  it("explains when every key is rejected", async () => {
    const http = fakeHttp(httpError(401, "Invalid API Key"), httpError(403, "Organization has been restricted"));
    await expect(
      client(http, { apiKey: undefined, apiKeys: ["gsk_a", "gsk_b"] })
        .completeJson({ step: "analyze", buildMessages: build, budget }),
    ).rejects.toThrow(/rejected all 2 API keys/);
    expect(http.post).toHaveBeenCalledTimes(2);
  });
});
