// Repository context for the LLM.
//
// The folder structure comes from `make-folder-txt --folder-structure`
// (make-folder-txt >= 2.3.1): it prints the tree to stdout and writes no file.
// Because flags are always passed, a .txtconfig committed to the cloned repo
// is never auto-applied (it could enable --copy or output splitting). File
// contents are read straight from the clone, using the same ignore rules.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveSafePath } from "./applyChanges.js";
import { sanitizedEnv } from "./git.js";

const require = createRequire(import.meta.url);

const MAKE_FOLDER_TXT_TIMEOUT_MS = 2 * 60 * 1000;
// Per-file and total limits for the contents kept in memory. Anything else
// is still listed in the structure and can be read on demand.
const MAX_FILE_BYTES = 100 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

// make-folder-txt's own ignore lists (its tree never shows these)...
const TOOL_IGNORED_DIRS = ["node_modules", ".git", ".next", "dist", "build", ".cache"];
const TOOL_IGNORED_FILES = [".DS_Store", "Thumbs.db", "desktop.ini", ".txtignore"];
// ...plus large or irrelevant directories it doesn't skip on its own.
const EXTRA_IGNORED_DIRS = [
  "coverage",
  "vendor",
  "bower_components",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  "target",
  ".gradle",
  ".terraform",
  ".yarn",
  ".pnpm-store",
];
// Secrets and huge generated lock files never go to the LLM.
const EXTRA_IGNORED_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
];

export const MAKE_FOLDER_TXT_FLAGS = [
  "--folder-structure",
  "--ignore-folder",
  ...EXTRA_IGNORED_DIRS,
  "--ignore-file",
  ...EXTRA_IGNORED_FILES,
];

const IGNORED_DIRS = new Set([...TOOL_IGNORED_DIRS, ...EXTRA_IGNORED_DIRS]);
const IGNORED_FILES = new Set([...TOOL_IGNORED_FILES, ...EXTRA_IGNORED_FILES]);

// Same list make-folder-txt uses to mark files as binary (it also skips
// .lock files such as yarn.lock).
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".svg",
  ".webp",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".lock",
]);

let cachedBinPath = null;

/** Absolute path of make-folder-txt's bin script (no npx, no shell). */
export function resolveMakeFolderTxtBin() {
  if (cachedBinPath) return cachedBinPath;
  let packageJsonPath = null;
  try {
    packageJsonPath = require.resolve("make-folder-txt/package.json");
  } catch {
    // An "exports" map can block the subpath: walk up from the main entry.
    let dir = path.dirname(require.resolve("make-folder-txt"));
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, "package.json");
      if (fs.existsSync(candidate)) {
        packageJsonPath = candidate;
        break;
      }
      dir = path.dirname(dir);
    }
  }
  if (!packageJsonPath) throw new Error("make-folder-txt is not installed");
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const binRel =
    typeof pkg.bin === "string"
      ? pkg.bin
      : pkg.bin?.["make-folder-txt"] || pkg.main;
  if (!binRel) throw new Error("make-folder-txt has no bin entry");
  cachedBinPath = path.join(path.dirname(packageJsonPath), binRel);
  return cachedBinPath;
}

/** Runs `make-folder-txt --folder-structure` in `dir`; resolves what it prints. */
export function runFolderStructure(
  dir,
  { signal, timeout = MAKE_FOLDER_TXT_TIMEOUT_MS } = {},
) {
  const bin = resolveMakeFolderTxtBin();
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [bin, ...MAKE_FOLDER_TXT_FLAGS],
      {
        cwd: dir,
        env: sanitizedEnv(),
        timeout,
        signal,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          if (error.name === "AbortError" || error.code === "ABORT_ERR") {
            reject(error);
            return;
          }
          // Spawn errors embed the node binary's path: report only the code.
          const reason = error.killed
            ? "timed out"
            : String(stderr || "")
                .split(/\r?\n/)
                .filter(Boolean)
                .slice(-2)
                .join(" ") || String(error.code || "unknown error");
          reject(new Error(`make-folder-txt failed: ${reason}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Clean up the printed tree. Its first line is the clone folder's name
 * ("<folder>/"); it becomes "." so no server-side name reaches the LLM. The
 * root ".git/  [skipped]" entry is dropped: it is never part of a change.
 */
export function normalizeStructure(output) {
  const lines = String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => !/^[├└]── \.git\/\s+\[skipped\]$/.test(line));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length && /\/$/.test(lines[0]) && !/^[│├└ ]/.test(lines[0])) {
    lines[0] = ".";
  }
  return lines.join("\n");
}

/** True for paths make-folder-txt (with our flags) leaves out of the tree. */
export function isIgnoredPath(rel) {
  const parts = rel.split("/");
  if (parts.slice(0, -1).some((part) => IGNORED_DIRS.has(part))) return true;
  return IGNORED_FILES.has(parts[parts.length - 1]);
}

const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

function looksBinary(content) {
  const sample = content.slice(0, 8000);
  if (!sample) return false;
  const replacements = sample.split(REPLACEMENT_CHAR).length - 1;
  return replacements > 8 && replacements / sample.length > 0.01;
}

/** Plain `tree`-style rendering of a list of posix paths. */
export function renderTree(paths) {
  const root = new Map();
  for (const filePath of paths) {
    let node = root;
    const parts = filePath.split("/").filter(Boolean);
    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1;
      const key = isFile ? part : `${part}/`;
      if (!node.has(key)) node.set(key, isFile ? null : new Map());
      if (!isFile) node = node.get(key);
    });
  }
  const out = ["."];
  const walk = (node, indent) => {
    const entries = [...node.entries()].sort(([a, av], [b, bv]) => {
      if ((av === null) !== (bv === null)) return av === null ? 1 : -1;
      return a.localeCompare(b);
    });
    entries.forEach(([name, child], index) => {
      const last = index === entries.length - 1;
      out.push(`${indent}${last ? "└── " : "├── "}${name}`);
      if (child) walk(child, indent + (last ? "    " : "│   "));
    });
  };
  walk(root, "");
  return out.join("\n");
}

/**
 * Read the text files among `paths` (relative, posix). Returns
 * { files: Map<path, content>, skipped: Map<path, reason> }.
 */
export async function readTextFiles(dir, paths, { signal } = {}) {
  const files = new Map();
  const skipped = new Map();
  let total = 0;
  for (const rel of [...paths].sort()) {
    signal?.throwIfAborted();
    if (isIgnoredPath(rel)) continue;
    if (BINARY_EXTENSIONS.has(path.extname(rel).toLowerCase())) {
      skipped.set(rel, "binary");
      continue;
    }
    let abs;
    let stat;
    try {
      ({ abs } = await resolveSafePath(dir, rel));
      stat = await fsp.lstat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_FILE_BYTES) {
      skipped.set(rel, "too large");
      continue;
    }
    if (total + stat.size > MAX_TOTAL_BYTES) {
      skipped.set(rel, "not loaded");
      continue;
    }
    const buffer = await fsp.readFile(abs);
    if (buffer.includes(0)) {
      skipped.set(rel, "binary");
      continue;
    }
    const content = buffer.toString("utf8");
    if (looksBinary(content)) {
      skipped.set(rel, "binary");
      continue;
    }
    files.set(rel, content);
    total += stat.size;
  }
  return { files, skipped };
}

/**
 * Structure (make-folder-txt --folder-structure) plus file contents for the
 * clone in `dir`. `listPaths` (async () => string[]) lists the repository's
 * files; if make-folder-txt fails, the tree is drawn from that list instead,
 * so a tool failure never blocks the job.
 */
export async function buildRepoContext(dir, { signal, listPaths } = {}) {
  let paths = [];
  try {
    paths = listPaths ? await listPaths() : [];
  } catch (err) {
    if (signal?.aborted) throw err;
    paths = [];
  }
  const { files, skipped } = await readTextFiles(dir, paths, { signal });
  try {
    const structure = normalizeStructure(await runFolderStructure(dir, { signal }));
    return {
      structure,
      files,
      skipped,
      totalFiles: paths.length,
      source: "make-folder-txt --folder-structure",
      error: null,
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    return {
      structure: renderTree(paths.filter((rel) => !isIgnoredPath(rel))),
      files,
      skipped,
      totalFiles: paths.length,
      source: "git ls-files",
      error: err.message,
    };
  }
}
