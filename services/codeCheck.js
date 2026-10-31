// Automatic checks on the files the AI wrote, run before committing:
// - .js / .cjs / .mjs: `node --check` (syntax only — the code is never run)
// - .json: JSON.parse (config files that allow comments are skipped)
// Files that look like JSX are skipped, since `node --check` can't parse JSX.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveSafePath } from "./applyChanges.js";
import { sanitizedEnv } from "./git.js";

const NODE_CHECK_TIMEOUT_MS = 20 * 1000;
const MAX_CHECK_BYTES = 512 * 1024;
const MAX_ERROR_CHARS = 1200;

const JS_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
// JSON files that conventionally allow comments or trailing commas.
const JSONC_NAMES = /^(tsconfig|jsconfig)(\..*)?\.json$|^\.?eslintrc\.json$/i;
const JSONC_DIRS = /(^|\/)(\.vscode|\.devcontainer)\//;

/** Rough JSX detection: closing tags or self-closing tags in the code. */
export function looksLikeJsx(content) {
  return /<\/[A-Za-z][\w.]*\s*>|<[A-Z][\w.]*[^<>]*\/>/.test(content);
}

function nodeCheck(abs, signal) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--check", abs],
      {
        env: sanitizedEnv(),
        timeout: NODE_CHECK_TIMEOUT_MS,
        signal,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, _stdout, stderr) => {
        if (!error) return resolve(null);
        if (error.name === "AbortError" || error.code === "ABORT_ERR") return reject(error);
        if (error.killed) return resolve(null); // a slow check is not a syntax error
        resolve(String(stderr || error.message));
      },
    );
  });
}

/** Keep the useful part of node's report, with the server path replaced by `rel`. */
function cleanNodeError(stderr, abs, rel) {
  const text = stderr
    .split(abs)
    .join(rel)
    .split(abs.replace(/\\/g, "/"))
    .join(rel)
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^\s+at |^Node\.js v\d/.test(line))
    .join("\n");
  return text.slice(0, MAX_ERROR_CHARS);
}

/**
 * Check `paths` (relative, inside `root`). Returns [{ path, error, content }]
 * for every file with a problem.
 */
export async function checkFiles(root, paths, { signal } = {}) {
  const problems = [];
  for (const rel of paths) {
    signal?.throwIfAborted();
    const ext = path.extname(rel).toLowerCase();
    const isJson = ext === ".json" && !JSONC_NAMES.test(path.basename(rel)) && !JSONC_DIRS.test(rel);
    if (!JS_EXTENSIONS.has(ext) && !isJson) continue;
    let abs;
    let content;
    try {
      ({ abs } = await resolveSafePath(root, rel));
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > MAX_CHECK_BYTES) continue;
      content = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (isJson) {
      try {
        // Drop a UTF-8 byte order mark before parsing.
        JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
      } catch (err) {
        problems.push({ path: rel, error: `Invalid JSON: ${err.message}`, content });
      }
      continue;
    }
    if (looksLikeJsx(content)) continue;
    const stderr = await nodeCheck(abs, signal);
    if (stderr) problems.push({ path: rel, error: cleanNodeError(stderr, abs, rel), content });
  }
  return problems;
}
