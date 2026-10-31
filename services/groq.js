// Groq chat-completions client used by the PR pipeline.
//
// Free-tier limits are tight (as low as ~8k tokens per minute), so:
// - 429 / 5xx / network errors are retried (max 3) honouring retry-after,
//   capped at 60s; a longer wait (e.g. a daily quota) fails fast.
// - 413 / "Request too large" / context-length errors shrink the prompt
//   budget by half and retry once, also lowering max_completion_tokens when
//   Groq reports the token limit.
// - JSON mode is used when the model supports it; replies are parsed
//   leniently and one "repair" retry is made if they are unusable.
// - Several API keys can be given: a key Groq rejects (expired, revoked,
//   invalid) is dropped and the next one is used, and a rate-limited key
//   rests while another key carries on, so jobs don't stop or wait.
import axios from "axios";

export const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 120 * 1000;
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EPIPE",
  "ENETUNREACH",
]);

export class LlmError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.code = code;
  }
}

export function getGroqModel() {
  return process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
}

export function getMaxOutputTokens() {
  const value = Number.parseInt(process.env.GROQ_MAX_OUTPUT_TOKENS, 10);
  return Number.isFinite(value) && value > 0 ? value : 8192;
}

export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason || new Error("aborted"));
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/** "1m2.5s" | "7.5s" | "450ms" -> milliseconds */
function parseDuration(text) {
  const match = String(text).match(
    /try again in\s+((?:\d+h)?(?:\d+m(?!s))?(?:[\d.]+s)?(?:[\d.]+ms)?)/i,
  );
  if (!match || !match[1]) return null;
  let ms = 0;
  const part = (re) => {
    const m = match[1].match(re);
    return m ? Number.parseFloat(m[1]) : 0;
  };
  ms += part(/(\d+)h/) * 3600 * 1000;
  ms += part(/(\d+)m(?!s)/) * 60 * 1000;
  ms += part(/([\d.]+)s/) * 1000;
  ms += part(/([\d.]+)ms/);
  return ms > 0 ? Math.ceil(ms) : null;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    if (value !== undefined && value !== null) return value;
  }
  return headers[name] ?? headers[name.toLowerCase()];
}

/** Classify an axios error from the Groq API. */
export function describeGroqError(err) {
  const response = err?.response;
  const status = response?.status ?? null;
  const data = response?.data;
  const apiError = (data && typeof data === "object" && data.error) || {};
  const message =
    apiError.message ||
    (typeof data === "string" ? data.slice(0, 500) : "") ||
    err?.message ||
    "Unknown error";
  const code = apiError.code || apiError.type || err?.code || null;

  let retryAfterMs = null;
  const retryAfterMsHeader = Number(headerValue(response?.headers, "retry-after-ms"));
  const retryAfterHeader = Number(headerValue(response?.headers, "retry-after"));
  if (Number.isFinite(retryAfterMsHeader) && retryAfterMsHeader > 0) {
    retryAfterMs = retryAfterMsHeader;
  } else if (Number.isFinite(retryAfterHeader) && retryAfterHeader >= 0) {
    retryAfterMs = Math.ceil(retryAfterHeader * 1000);
  } else {
    retryAfterMs = parseDuration(message);
  }

  const limitMatch = message.match(/Limit\s+(\d+)/i);
  const requestedMatch = message.match(/Requested\s+(\d+)/i);
  const limit = limitMatch ? Number(limitMatch[1]) : null;
  const requested = requestedMatch ? Number(requestedMatch[1]) : null;

  const tooLarge =
    status === 413 ||
    code === "context_length_exceeded" ||
    /request too large|reduce your message size|context[ _]length|maximum context|reduce the length|too many tokens/i.test(
      message,
    ) ||
    (status === 429 && limit !== null && requested !== null && requested > limit);

  const jsonValidateFailed = code === "json_validate_failed";
  const responseFormatUnsupported =
    status === 400 &&
    !jsonValidateFailed &&
    /response_format|json mode|json_object/i.test(message);

  // The key itself is unusable (expired, revoked, invalid, or its
  // organization is blocked): another key may still work.
  const keyRejected =
    status === 401 ||
    code === "invalid_api_key" ||
    ((status === 400 || status === 403) &&
      /invalid api key|api key.*(expired|revoked|invalid|disabled)|organization.*(restricted|disabled|suspended)/i.test(
        message,
      ));

  const networkCode = !response && err?.code ? err.code : null;
  const retryable =
    !tooLarge &&
    (status === 429 ||
      (status !== null && status >= 500) ||
      (networkCode !== null && RETRYABLE_NETWORK_CODES.has(networkCode)));

  return {
    status,
    code,
    message,
    retryAfterMs,
    limit,
    requested,
    tooLarge,
    jsonValidateFailed,
    failedGeneration:
      typeof apiError.failed_generation === "string" ? apiError.failed_generation : null,
    responseFormatUnsupported,
    retryable,
    keyRejected,
    networkCode,
  };
}

function formatWait(ms) {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 120) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)} min`;
}

/** Friendly, actionable error for the job's errorMessage. */
export function toLlmError(info, model, { keyCount = 1 } = {}) {
  const { status, message } = info;
  if (info.keyRejected) {
    return new LlmError(
      keyCount > 1
        ? `Groq rejected all ${keyCount} API keys — they may be expired or revoked. Add a working Groq key in Settings.`
        : `Groq rejected the API key (${status}) — it may be expired or revoked. Update your Groq key in Settings.`,
      { status },
    );
  }
  if (status === 404 || info.code === "model_not_found") {
    return new LlmError(
      `Groq model "${model}" is not available (${message}). Check GROQ_MODEL.`,
      { status },
    );
  }
  if (status === 429) {
    const when = info.retryAfterMs ? ` Try again in ${formatWait(info.retryAfterMs)}` : " Try again later";
    const scope = keyCount > 1 ? ` on all ${keyCount} API keys` : "";
    return new LlmError(
      `Groq rate limit reached for ${model}${scope}.${when}, add another Groq key in Settings, use a different model, or upgrade your Groq plan. (${message})`,
      { status },
    );
  }
  if (info.tooLarge) {
    return new LlmError(
      `The request is too large for ${model}'s limits even after shrinking the repository context. Try a more specific instruction, lower PR_CONTEXT_CHARS / GROQ_MAX_OUTPUT_TOKENS, or use a model/plan with higher limits. (${message})`,
      { status },
    );
  }
  if (status !== null && status >= 500) {
    return new LlmError(`Groq is unavailable right now (HTTP ${status}). Try again later.`, {
      status,
    });
  }
  if (status === null) {
    return new LlmError(`Couldn't reach Groq: ${info.networkCode || message}`);
  }
  return new LlmError(`Groq request failed (HTTP ${status}): ${message}`, { status });
}

/**
 * Lenient JSON object extraction: plain JSON, ```json fences, or the first
 * balanced {...} block in surrounding prose (string-aware, so braces and
 * code fences inside JSON strings don't confuse it).
 */
export function extractJson(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("the reply was empty");
  }
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) candidates.push(fenced[1]);

  for (let start = trimmed.indexOf("{"), tries = 0; start !== -1 && tries < 5; tries += 1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(trimmed.slice(start, i + 1));
          break;
        }
      }
    }
    start = trimmed.indexOf("{", start + 1);
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // try the next candidate
    }
  }
  throw new Error("it was not valid JSON");
}

export function estimateTokens(messages) {
  const chars = messages.reduce(
    (sum, message) => sum + String(message.content || "").length + 16,
    0,
  );
  return Math.ceil(chars / 3.2);
}

function halveBudget(budget) {
  const out = {};
  for (const [key, value] of Object.entries(budget || {})) {
    out[key] = typeof value === "number" ? Math.max(1000, Math.floor(value / 2)) : value;
  }
  return out;
}

// Health of each API key, shared by every client in this process so
// concurrent jobs skip a key another job just found expired or rate
// limited. Kept in memory only; keys are never logged.
const keyHealth = new Map();
const REJECTED_KEY_MS = 15 * 60 * 1000;

export function resetGroqKeyHealth() {
  keyHealth.clear();
}

/** Split lists of keys (newlines, commas or spaces) into unique keys, in order. */
export function parseApiKeys(...values) {
  const keys = [];
  for (const value of values.flat()) {
    for (const key of String(value || "").split(/[\s,;]+/)) {
      if (key && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

function createKeyPool(keys, now) {
  const tried = new Set();
  const health = (key) => keyHealth.get(key) || { rejectedUntil: 0, restUntil: 0 };
  const update = (key, patch) => keyHealth.set(key, { ...health(key), ...patch });

  return {
    size: keys.length,
    label: (key) => (keys.length > 1 ? `key ${keys.indexOf(key) + 1} of ${keys.length}` : "key"),
    /**
     * The key to use next and how long to wait first: a healthy key right
     * away, else the one whose rate limit ends soonest. Keys rejected
     * recently (by any job) are skipped, but if every key looks rejected
     * each one still gets a single fresh try from this client. Null = none.
     */
    pick() {
      const t = now();
      let usable = keys.filter((key) => health(key).rejectedUntil <= t);
      if (!usable.length) usable = keys.filter((key) => !tried.has(key));
      if (!usable.length) return null;
      let best = null;
      for (const key of usable) {
        const waitMs = Math.max(0, health(key).restUntil - t);
        if (!best || waitMs < best.waitMs) best = { key, waitMs };
      }
      // Round up so a wait doesn't come out a millisecond short.
      best.waitMs = Math.ceil(best.waitMs / 100) * 100;
      return best;
    },
    used(key) {
      tried.add(key);
    },
    reject(key) {
      update(key, { rejectedUntil: now() + REJECTED_KEY_MS });
    },
    rest(key, ms) {
      update(key, { restUntil: Math.max(health(key).restUntil, now() + ms) });
    },
    healthy(key) {
      if (health(key).rejectedUntil) update(key, { rejectedUntil: 0 });
    },
  };
}

export function createGroqClient({
  apiKey,
  // Several keys: used in order, switching when one is rejected or rate limited.
  apiKeys,
  model = getGroqModel(),
  maxOutputTokens = getMaxOutputTokens(),
  http = axios,
  sleep = abortableSleep,
  log = async () => {},
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxRetryWaitMs = MAX_RETRY_WAIT_MS,
  now = Date.now,
} = {}) {
  const keys = createKeyPool(parseApiKeys(apiKeys || [], apiKey || []), now);

  // Tokens-per-minute limit of the account, learned from Groq's
  // x-ratelimit-limit-tokens header (or a "request too large" error).
  // Free-tier plans can be as small as 8000: every request (prompt +
  // reasoning + reply) must then fit inside it.
  let tokenLimit = null;

  function learnLimit(value) {
    const limit = Number(value);
    if (Number.isFinite(limit) && limit > 0) tokenLimit = limit;
  }

  async function send({ messages, maxTokens, jsonMode, reasoningEffort, temperature = 0.2, signal }) {
    const body = {
      model,
      messages,
      temperature,
      max_completion_tokens: maxTokens,
    };
    if (jsonMode) body.response_format = { type: "json_object" };
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;

    let attempt = 0;
    let lastInfo = null;
    const giveUp = (info) => toLlmError(info, model, { keyCount: keys.size });
    // Switching keys doesn't use up retries; every switch rejects or rests a
    // key, so the loop stays bounded.
    for (let round = 0; round < 40; round += 1) {
      const pick = keys.pick();
      if (!pick) throw giveUp(lastInfo || { status: 401, keyRejected: true, message: "no usable API key" });
      if (pick.waitMs > 0) {
        if (pick.waitMs > maxRetryWaitMs || attempt >= MAX_RETRIES) throw giveUp(lastInfo);
        attempt += 1;
        await log(
          "warn",
          `Groq rate limit hit${keys.size > 1 ? " on every key" : ""} — retrying in ${formatWait(pick.waitMs)} (${attempt}/${MAX_RETRIES})`,
        );
        await sleep(pick.waitMs, signal);
      }
      keys.used(pick.key);
      try {
        const res = await http.post(GROQ_CHAT_URL, body, {
          headers: {
            Authorization: `Bearer ${pick.key}`,
            "Content-Type": "application/json",
          },
          timeout: timeoutMs,
          signal,
        });
        keys.healthy(pick.key);
        learnLimit(res?.headers?.["x-ratelimit-limit-tokens"]);
        const choice = res?.data?.choices?.[0];
        return {
          content: choice?.message?.content ?? "",
          finishReason: choice?.finish_reason ?? null,
        };
      } catch (err) {
        if (signal?.aborted) throw signal.reason || err;
        const info = describeGroqError(err);
        lastInfo = info;
        if (info.keyRejected) {
          keys.reject(pick.key);
          const next = keys.pick();
          if (!next) throw giveUp(info);
          await log(
            "warn",
            `Groq rejected API ${keys.label(pick.key)} (expired or invalid) — switching to ${keys.label(next.key)}`,
          );
          continue;
        }
        if (info.status === 429 && !info.tooLarge) {
          // Rest this key and carry on at once with another one, if any.
          keys.rest(pick.key, info.retryAfterMs ?? Math.min(2000 * 2 ** attempt, 20000));
          const next = keys.pick();
          if (next && next.waitMs === 0 && next.key !== pick.key) {
            await log("warn", `Groq rate limit hit on ${keys.label(pick.key)} — switching to ${keys.label(next.key)}`);
          }
          continue;
        }
        if (!info.retryable || attempt >= MAX_RETRIES) {
          const wrapped = new LlmError(info.message, { status: info.status, code: info.code });
          wrapped.info = info;
          throw wrapped;
        }
        const wait = info.retryAfterMs ?? Math.min(2000 * 2 ** attempt, 20000);
        if (wait > maxRetryWaitMs) throw giveUp(info);
        attempt += 1;
        await log(
          "warn",
          `Groq error (${info.status ?? info.networkCode}) — retrying in ${formatWait(wait)} (${attempt}/${MAX_RETRIES})`,
        );
        await sleep(wait, signal);
      }
    }
    throw giveUp(lastInfo);
  }

  /** Plain-text reply (no JSON mode), with the same retries and key switching. */
  async function completeText({ messages, maxTokens = maxOutputTokens, temperature = 0.3, signal }) {
    try {
      const reply = await send({ messages, maxTokens, jsonMode: false, temperature, signal });
      return String(reply.content || "").trim();
    } catch (err) {
      if (err.info) throw toLlmError(err.info, model, { keyCount: keys.size });
      throw err;
    }
  }

  /**
   * Ask for a JSON object. `buildMessages(budget)` must be pure: it is called
   * again with a smaller budget after a too-large error. `validate(value)`
   * returns { ok: true, value } or { ok: false, error }.
   */
  async function completeJson({
    step,
    buildMessages,
    budget,
    validate = (value) => ({ ok: true, value }),
    signal,
    // Optional per-call tuning: a bigger output budget for steps that write
    // whole files, deeper reasoning (gpt-oss models only) and temperature.
    maxTokens: requestedMaxTokens,
    reasoningEffort: requestedEffort,
    temperature,
  }) {
    let currentBudget = { ...budget };
    const wantedTokens = requestedMaxTokens || maxOutputTokens;
    let maxTokens = wantedTokens;
    let reasoningEffort = /gpt-oss/i.test(model) ? requestedEffort : undefined;
    let jsonMode = true;
    let shrunk = false;
    let repairNote = null;
    let reasoningLowered = false;

    for (let round = 0; round < 8; round += 1) {
      // On a small tokens-per-minute plan, deep reasoning eats the whole
      // allowance: keep it light so the tokens go into the reply.
      if (tokenLimit && tokenLimit < 30000 && reasoningEffort && reasoningEffort !== "low") {
        reasoningEffort = "low";
      }
      let base = buildMessages(currentBudget);
      // Fit the request inside the plan's limit before sending it: shrink the
      // repository context until the reply keeps a useful share of the tokens.
      if (tokenLimit) {
        const wantedReply = Math.min(wantedTokens, Math.floor(tokenLimit * 0.55));
        for (let i = 0; i < 4; i += 1) {
          const room = tokenLimit - estimateTokens(base) - 300;
          if (room >= wantedReply || currentBudget.contextChars <= 1500) break;
          currentBudget = halveBudget(currentBudget);
          base = buildMessages(currentBudget);
        }
        maxTokens = Math.max(512, Math.min(wantedTokens, tokenLimit - estimateTokens(base) - 300));
      }
      const messages = repairNote ? [...base, { role: "user", content: repairNote }] : base;

      let reply;
      try {
        reply = await send({ messages, maxTokens, jsonMode, reasoningEffort, temperature, signal });
      } catch (err) {
        if (signal?.aborted) throw signal.reason || err;
        const info = err.info;
        if (!info) throw err;
        if (reasoningEffort && info.status === 400 && /reasoning/i.test(`${info.message} ${info.code}`)) {
          reasoningEffort = undefined;
          await log("warn", `${model} rejected reasoning_effort — retrying without it`);
          continue;
        }
        if (info.jsonValidateFailed) {
          reply = { content: info.failedGeneration || "", finishReason: "json_validate_failed" };
        } else if (jsonMode && info.responseFormatUnsupported) {
          jsonMode = false;
          await log("warn", `${model} rejected JSON mode — retrying without it`);
          continue;
        } else if (info.tooLarge && info.limit && !tokenLimit) {
          // First time we learn the plan's limit: refit and try again.
          learnLimit(info.limit);
          await log(
            "warn",
            `Your Groq plan allows ${info.limit} tokens per request for ${model} — fitting the request into it`,
          );
          continue;
        } else if (info.tooLarge && !shrunk) {
          shrunk = true;
          currentBudget = halveBudget(currentBudget);
          let note = "";
          if (info.limit) {
            const promptTokens = estimateTokens(buildMessages(currentBudget));
            const room = info.limit - promptTokens - 300;
            const adjusted = Math.max(512, Math.min(maxTokens, room));
            if (adjusted !== maxTokens) {
              maxTokens = adjusted;
              note = ` and at most ${maxTokens} output tokens`;
            }
          }
          await log(
            "warn",
            `Request too large for ${model}${info.limit ? ` (limit ${info.limit} tokens)` : ""} — retrying with half the repository context${note}`,
          );
          continue;
        } else {
          throw toLlmError(info, model, { keyCount: keys.size });
        }
      }

      let problem;
      let parsed;
      try {
        parsed = extractJson(reply.content);
      } catch (parseError) {
        problem = parseError.message;
      }
      if (parsed !== undefined) {
        const verdict = validate(parsed);
        if (verdict.ok) return verdict.value;
        problem = verdict.error;
      }
      const cutOff = reply.finishReason === "length";
      // An empty reply cut off by the limit means the model spent the whole
      // budget reasoning: ask again with lighter reasoning, same request.
      if (cutOff && !String(reply.content || "").trim() && reasoningEffort && reasoningEffort !== "low" && !reasoningLowered) {
        reasoningLowered = true;
        reasoningEffort = "low";
        await log("warn", `The AI used its whole ${step} budget thinking — retrying with lighter reasoning`);
        continue;
      }
      if (cutOff) problem += " (the reply was cut off by the output token limit)";
      if (repairNote) {
        throw new LlmError(`The AI returned an unusable ${step} response: ${problem}.`);
      }
      repairNote =
        `Your previous reply could not be used: ${problem}. ` +
        "Reply again with ONLY one valid JSON object in exactly the requested format — no markdown, no code fences, no commentary." +
        (cutOff ? ' Keep it shorter: prefer small "edit" actions over full-file content.' : "");
      await log("warn", `The AI's ${step} reply was unusable (${problem}) — asking it to fix the format`);
    }
    throw new LlmError(`The AI ${step} step failed after several attempts.`);
  }

  return {
    model,
    completeJson,
    completeText,
    /** How many API keys this client can switch between. */
    keyCount: () => keys.size,
    /** The plan's tokens-per-minute limit, once Groq has reported it (else null). */
    tokenLimit: () => tokenLimit,
  };
}
