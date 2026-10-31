// Applies AI-proposed file changes inside a cloned repository.
//
// Security: every path goes through resolveSafePath, which only accepts
// relative paths that stay inside the clone, never touch .git, and never pass
// through a symbolic link (the clone uses core.symlinks=false, this is
// defence in depth).
import fs from "node:fs/promises";
import path from "node:path";
import { isUtf8 } from "node:buffer";

export class UnsafePathError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsafePathError";
  }
}

const BOM = String.fromCharCode(0xfeff);
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Normalise an AI/DB-supplied path to a clean relative posix path, or throw
 * UnsafePathError. Rejects absolute paths, drive letters, UNC paths, "..",
 * anything inside .git (any case, NTFS aliases), NUL/control characters and
 * ':' (NTFS alternate data streams).
 */
export function normalizeRepoPath(input) {
  if (typeof input !== "string") {
    throw new UnsafePathError("path must be a string");
  }
  if (input.includes("\0")) throw new UnsafePathError("path contains a NUL byte");
  const trimmed = input.trim();
  if (!trimmed) throw new UnsafePathError("path is empty");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new UnsafePathError("path contains control characters");
  }
  const slashed = trimmed.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(slashed)) {
    throw new UnsafePathError("absolute paths (drive letters) are not allowed");
  }
  if (slashed.startsWith("/")) {
    throw new UnsafePathError("absolute and UNC paths are not allowed");
  }
  if (slashed.includes(":")) throw new UnsafePathError("':' is not allowed in paths");

  const segments = [];
  for (const segment of slashed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw new UnsafePathError("'..' is not allowed in paths");
    // Windows ignores trailing dots/spaces: ".git. " is ".git".
    const bare = segment.replace(/[. ]+$/, "").toLowerCase();
    if (bare === ".git" || /^git~\d+$/i.test(segment)) {
      throw new UnsafePathError("paths inside .git are not allowed");
    }
    if (process.platform === "win32" && WINDOWS_DEVICE.test(bare)) {
      throw new UnsafePathError(`"${segment}" is a reserved device name on Windows`);
    }
    segments.push(segment);
  }
  if (!segments.length) throw new UnsafePathError("path is empty");
  return segments.join("/");
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

/**
 * Resolve `input` inside `root`. Returns { rel, abs }. Throws UnsafePathError
 * if the path is unsafe, escapes the root, or crosses a symbolic link.
 */
export async function resolveSafePath(root, input) {
  const rel = normalizeRepoPath(input);
  const rootReal = await fs.realpath(root);
  const parts = rel.split("/");
  const abs = path.resolve(rootReal, ...parts);
  if (!isInside(rootReal, abs)) {
    throw new UnsafePathError("path escapes the repository");
  }
  let current = rootReal;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") break;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new UnsafePathError("path goes through a symbolic link");
    }
  }
  return { rel, abs };
}

export function dominantEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FIND_KEYS = ["find", "search", "old", "old_text", "oldText", "original", "before"];
const REPLACE_KEYS = ["replace", "replacement", "replace_with", "replaceWith", "new", "new_text", "newText", "with", "after"];

/** Coerce LLM edit variations ({search, replacement}, {old, new}, ...) into {find, replace}. */
export function normalizeEdit(edit) {
  if (!edit || typeof edit !== "object") return { find: undefined, replace: undefined };
  const pick = (keys) => keys.find((key) => key in edit);
  const findKey = pick(FIND_KEYS);
  const replaceKey = pick(REPLACE_KEYS);
  let replace = replaceKey ? edit[replaceKey] : undefined;
  // An explicit null replacement means "delete the found text".
  if (replaceKey && replace === null) replace = "";
  return { find: findKey ? edit[findKey] : undefined, replace };
}

/**
 * Whitespace-tolerant fallback: match `find` line by line, ignoring leading
 * and trailing whitespace on each line. Returns every match as
 * { index, length } over whole lines of `text`.
 */
function findLinesLoosely(text, find) {
  const wanted = find
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim());
  while (wanted.length && wanted[0] === "") wanted.shift();
  while (wanted.length && wanted[wanted.length - 1] === "") wanted.pop();
  if (!wanted.length) return [];

  const lines = [];
  const lineRe = /[^\n]*(?:\n|$)/g;
  let m;
  while ((m = lineRe.exec(text)) && m[0] !== "") {
    lines.push({ start: m.index, raw: m[0], trimmed: m[0].replace(/\r?\n$/, "").trim() });
  }
  const matches = [];
  for (let i = 0; i + wanted.length <= lines.length; i += 1) {
    if (wanted.every((line, k) => lines[i + k].trimmed === line)) {
      const last = lines[i + wanted.length - 1];
      const end = last.start + last.raw.replace(/\r?\n$/, "").length;
      matches.push({ index: lines[i].start, length: end - lines[i].start });
    }
  }
  return matches;
}

/**
 * Apply find/replace edits. Matching ignores CRLF vs LF differences (each
 * "\n" in `find` matches "\r?\n"); when the exact text is not found, a match
 * that differs only in indentation/trailing whitespace is accepted. Every find
 * must match exactly one place. Replacement text is written with the file's
 * dominant line ending so the rest of the file keeps its line endings byte for
 * byte.
 */
export function applyEditsToText(original, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: 'an "edit" action needs a non-empty "edits" list' };
  }
  const eol = dominantEol(original);
  let text = original;
  for (let index = 0; index < edits.length; index += 1) {
    const { find, replace } = normalizeEdit(edits[index]);
    if (typeof find !== "string" || find === "") {
      return { ok: false, index, error: `edit #${index + 1} has an empty "find"` };
    }
    if (typeof replace !== "string") {
      return { ok: false, index, error: `edit #${index + 1} has no "replace" text` };
    }
    const pattern = new RegExp(
      escapeRegExp(find.replace(/\r\n/g, "\n")).replace(/\n/g, "\\r?\\n"),
      "g",
    );
    let matches = [...text.matchAll(pattern)].map((match) => ({
      index: match.index,
      length: match[0].length,
    }));
    if (matches.length === 0) matches = findLinesLoosely(text, find);
    if (matches.length === 0) {
      return {
        ok: false,
        index,
        error: `edit #${index + 1}: the "find" text was not found in the file`,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        index,
        error: `edit #${index + 1}: the "find" text matches ${matches.length} places`,
      };
    }
    const [match] = matches;
    const replacement = replace.replace(/\r\n/g, "\n").replace(/\n/g, eol);
    text =
      text.slice(0, match.index) +
      replacement +
      text.slice(match.index + match.length);
  }
  return { ok: true, text };
}

/** Full new content, adapted to the existing file's EOL/BOM/final newline. */
export function conformContent(content, original) {
  let out = String(content).replace(/\r\n/g, "\n");
  if (out.startsWith(BOM)) out = out.slice(1);
  if (original === null || original === undefined) {
    if (out.length && !out.endsWith("\n")) out += "\n";
    return out;
  }
  const eol = dominantEol(original);
  if (/\n$/.test(original) && out.length && !out.endsWith("\n")) out += "\n";
  if (eol === "\r\n") out = out.replace(/\n/g, "\r\n");
  if (original.startsWith(BOM)) out = `${BOM}${out}`;
  return out;
}

async function readTextFile(abs) {
  const buffer = await fs.readFile(abs);
  if (buffer.includes(0) || !isUtf8(buffer)) return null;
  return buffer.toString("utf8");
}

async function statOrNull(abs) {
  try {
    return await fs.stat(abs);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

const ACTION_ALIASES = {
  create: "create",
  add: "create",
  new: "create",
  replace: "replace",
  rewrite: "replace",
  overwrite: "replace",
  edit: "edit",
  patch: "edit",
  modify: "edit",
  update: "edit",
  delete: "delete",
  remove: "delete",
};

/** Coerce common LLM variations ({file, type, new_content, ...}) into our shape. */
export function normalizeChange(raw) {
  if (!raw || typeof raw !== "object") return { path: undefined, action: undefined };
  const filePath = raw.path ?? raw.file ?? raw.filename ?? raw.file_path;
  let action = String(raw.action ?? raw.type ?? raw.op ?? "")
    .trim()
    .toLowerCase();
  action = ACTION_ALIASES[action] || action;
  const content = raw.content ?? raw.new_content ?? raw.newContent;
  let edits = raw.edits ?? raw.replacements;
  if (!Array.isArray(edits) && typeof normalizeEdit(raw).find === "string") {
    edits = [normalizeEdit(raw)];
  }
  // "edit"/"update" carrying full content means a full replacement.
  if (action === "edit" && !Array.isArray(edits) && typeof content === "string") {
    action = "replace";
  }
  return { path: filePath, action, content, edits };
}

/**
 * Apply changes in order. Never throws for a bad change: each problem is
 * reported in `results`. Failed "edit" changes are also listed in
 * `failedEdits` so the caller can ask the AI for full content instead.
 * Options: truncatedPaths (Set of rel paths shown truncated to the AI — a
 * "replace" of those is refused), maxChanges.
 */
export async function applyChanges(root, changes, options = {}) {
  const { truncatedPaths = new Set(), maxChanges = 60 } = options;
  const results = [];
  const failedEdits = [];
  const list = Array.isArray(changes) ? changes.slice(0, maxChanges) : [];

  for (const raw of list) {
    const change = normalizeChange(raw);
    const label = typeof change.path === "string" ? change.path : "(no path)";
    const fail = (error) => {
      results.push({ path: label, action: change.action || "?", ok: false, error });
    };
    if (!["create", "replace", "edit", "delete"].includes(change.action)) {
      fail(`unknown action "${change.action || ""}"`);
      continue;
    }
    let target;
    try {
      target = await resolveSafePath(root, change.path);
    } catch (err) {
      fail(err instanceof UnsafePathError ? `unsafe path: ${err.message}` : err.message);
      continue;
    }
    const { rel, abs } = target;
    try {
      const stat = await statOrNull(abs);
      if (stat && !stat.isFile()) {
        fail("path is a directory, not a file");
        continue;
      }

      if (change.action === "delete") {
        if (!stat) {
          fail("file does not exist");
          continue;
        }
        await fs.rm(abs, { force: true });
        results.push({ path: rel, action: "delete", ok: true });
        continue;
      }

      const original = stat ? await readTextFile(abs) : null;
      if (stat && original === null) {
        fail("binary or non-UTF-8 file can't be edited");
        continue;
      }

      if (change.action === "edit") {
        if (!stat) {
          fail("can't edit a file that does not exist");
          failedEdits.push({ path: rel, edits: change.edits, error: "file does not exist" });
          continue;
        }
        const outcome = applyEditsToText(original, change.edits);
        if (!outcome.ok) {
          fail(outcome.error);
          failedEdits.push({ path: rel, edits: change.edits, error: outcome.error });
          continue;
        }
        if (outcome.text !== original) await fs.writeFile(abs, outcome.text, "utf8");
        results.push({ path: rel, action: "edit", ok: true });
        continue;
      }

      // create / replace
      if (typeof change.content !== "string") {
        fail(`"${change.action}" needs the full file "content"`);
        continue;
      }
      if (stat && change.action === "replace" && truncatedPaths.has(rel)) {
        fail("refusing a full replace of a file that was only shown truncated");
        continue;
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, conformContent(change.content, original), "utf8");
      results.push({
        path: rel,
        action: stat ? "replace" : "create",
        ok: true,
        note:
          stat && change.action === "create"
            ? "file already existed; replaced it"
            : undefined,
      });
    } catch (err) {
      fail(err.code ? `${err.code}: could not write the file` : err.message);
    }
  }

  if (Array.isArray(changes) && changes.length > list.length) {
    results.push({
      path: "(more)",
      action: "?",
      ok: false,
      error: `only the first ${maxChanges} changes were applied`,
    });
  }

  return {
    results,
    failedEdits,
    appliedCount: results.filter((r) => r.ok).length,
  };
}

/**
 * Replay stored final file states ([{ path, action: "write"|"delete", content }]).
 * Used to rebuild a preview on a fresh clone. Throws on the first problem —
 * a partial replay must never be committed.
 */
export async function replayChanges(root, stored) {
  let count = 0;
  for (const change of Array.isArray(stored) ? stored : []) {
    const { rel, abs } = await resolveSafePath(root, change?.path);
    if (change.action === "delete") {
      await fs.rm(abs, { force: true });
      count += 1;
      continue;
    }
    if (change.action !== "write" || typeof change.content !== "string") {
      throw new Error(`Stored change for ${rel} is invalid`);
    }
    const stat = await statOrNull(abs);
    if (stat && !stat.isFile()) throw new Error(`${rel} is a directory in the base branch`);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, change.content, "utf8");
    count += 1;
  }
  return count;
}
