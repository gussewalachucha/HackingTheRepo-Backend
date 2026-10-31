import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decryptSecret } from "../utils/crypto.js";
import { parseApiKeys } from "./groq.js";

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function safeDecrypt(value) {
  try {
    return decryptSecret(value) || "";
  } catch {
    // Wrong ENCRYPTION_KEY or corrupted value: treat as "not configured".
    return "";
  }
}

/**
 * Groq keys from a JSON file (GROQ_KEYS_FILE, default backend/groq.json,
 * which is gitignored). Any shape works: ["gsk_..."], {"0": "gsk_..."},
 * {"keys": [...]}. Read on every job, so edits apply without a restart.
 */
export function fileGroqKeys(file = process.env.GROQ_KEYS_FILE || "groq.json") {
  const fullPath = path.resolve(BACKEND_DIR, file);
  let text;
  try {
    text = fs.readFileSync(fullPath, "utf8");
  } catch {
    return []; // no file: nothing to add
  }
  const keys = [];
  const collect = (value) => {
    if (typeof value === "string") keys.push(value.trim());
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  try {
    collect(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
  } catch {
    console.warn(`[groq] ${file} is not valid JSON — ignoring it`);
    return [];
  }
  return parseApiKeys(keys.filter((key) => key.startsWith("gsk_")));
}

/** The user's saved Groq keys (stored encrypted, one per line). */
export function userGroqKeys(user) {
  return parseApiKeys(safeDecrypt(user?.groqKey));
}

/**
 * Credentials for a user's PR jobs: their own saved secrets first, then the
 * server-wide fallbacks (REPOMIND_GITHUB_TOKEN / GROQ_API_KEYS / GROQ_API_KEY /
 * the keys file).
 * groqKeys lists every usable Groq key in order: when one is expired or rate
 * limited the Groq client switches to the next. groqKey is the first one.
 */
export function resolveCredentials(user) {
  const groqKeys = parseApiKeys(
    userGroqKeys(user),
    process.env.GROQ_API_KEYS,
    process.env.GROQ_API_KEY,
    fileGroqKeys(),
  );
  return {
    githubToken:
      safeDecrypt(user?.githubToken) || process.env.REPOMIND_GITHUB_TOKEN || "",
    groqKey: groqKeys[0] || "",
    groqKeys,
  };
}
