import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAKE_FOLDER_TXT_FLAGS,
  buildRepoContext,
  isIgnoredPath,
  normalizeStructure,
  renderTree,
  resolveMakeFolderTxtBin,
} from "../services/repoContext.js";

let outer;

beforeAll(() => {
  outer = fs.mkdtempSync(path.join(os.tmpdir(), "repomind-ctx-"));
});

afterAll(() => {
  fs.rmSync(outer, { recursive: true, force: true });
});

function makeRepo(name) {
  const dir = path.join(outer, name);
  fs.mkdirSync(path.join(dir, "src", "deep"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# Demo\n\nHello\n");
  fs.writeFileSync(path.join(dir, "src", "index.js"), "const a = 1;\r\nmodule.exports = a;\r\n");
  fs.writeFileSync(path.join(dir, "src", "deep", "empty.txt"), "");
  fs.writeFileSync(path.join(dir, "src", "deep", "no-newline.js"), "x()");
  fs.writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  fs.writeFileSync(path.join(dir, "data.dat"), Buffer.from([1, 0, 2, 0, 3]));
  fs.writeFileSync(path.join(dir, "big.js"), "x".repeat(150 * 1024));
  fs.writeFileSync(path.join(dir, ".env"), "SECRET=hunter2\n");
  // A hostile saved config: must not be auto-applied (no clipboard, no split).
  fs.writeFileSync(
    path.join(dir, ".txtconfig"),
    JSON.stringify({ maxFileSize: "1KB", splitMethod: "file", splitSize: "5MB", copyToClipboard: true }),
  );
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  return dir;
}

const listAll = (dir) => async () =>
  execFileSync("git", ["ls-files", "-z", "--cached", "--others"], { cwd: dir, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);

describe("make-folder-txt --folder-structure", () => {
  it("resolves the installed bin script (>= 2.3.1)", () => {
    const bin = resolveMakeFolderTxtBin();
    expect(fs.existsSync(bin)).toBe(true);
    expect(path.basename(bin)).toBe("make-folder-txt.js");
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(bin), "..", "package.json"), "utf8"));
    const [major, minor, patch] = pkg.version.split(".").map(Number);
    expect(major * 10000 + minor * 100 + patch).toBeGreaterThanOrEqual(20301);
  });

  it("asks only for the structure and always passes flags (no saved .txtconfig, no clipboard)", () => {
    expect(MAKE_FOLDER_TXT_FLAGS[0]).toBe("--folder-structure");
    expect(MAKE_FOLDER_TXT_FLAGS).not.toContain("--copy");
  });

  it(
    "builds the structure from a real run and reads file contents from disk, writing nothing",
    async () => {
      const dir = makeRepo("acme-demo-abc123");
      const before = fs.readdirSync(dir).sort();
      const context = await buildRepoContext(dir, { listPaths: listAll(dir) });

      expect(context.source).toBe("make-folder-txt --folder-structure");
      expect(context.error).toBeNull();
      const lines = context.structure.split("\n");
      expect(lines[0]).toBe(".");
      expect(context.structure).toMatch(/├── src\//);
      expect(context.structure).toMatch(/node_modules\/ {2}\[skipped\]/);
      expect(context.structure).toContain("README.md");
      expect(context.structure).not.toContain("acme-demo-abc123");
      expect(context.structure).not.toContain(outer);
      expect(context.structure).not.toContain(".env");
      expect(context.structure).not.toContain("Copied");

      expect(context.files.get("src/index.js")).toBe("const a = 1;\r\nmodule.exports = a;\r\n");
      expect(context.files.get("README.md")).toBe("# Demo\n\nHello\n");
      expect(context.files.get("src/deep/empty.txt")).toBe("");
      expect(context.files.get("src/deep/no-newline.js")).toBe("x()");
      expect(context.files.has(".env")).toBe(false);
      expect(context.files.has("node_modules/dep/index.js")).toBe(false);
      expect(context.skipped.get("logo.png")).toBe("binary");
      expect(context.skipped.get("data.dat")).toBe("binary");
      expect(context.skipped.get("big.js")).toBe("too large");

      // --folder-structure writes no file at all.
      expect(fs.readdirSync(dir).sort()).toEqual(before);
    },
    60000,
  );

  it("handles an empty repository", async () => {
    const dir = path.join(outer, "empty-repo");
    fs.mkdirSync(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    const context = await buildRepoContext(dir, { listPaths: listAll(dir) });
    expect(context.error).toBeNull();
    expect(context.structure).toBe(".");
    expect(context.files.size).toBe(0);
    expect(context.totalFiles).toBe(0);
  });

  it("falls back to a git ls-files tree when make-folder-txt can't run", async () => {
    const context = await buildRepoContext(path.join(outer, "does-not-exist"), {
      listPaths: async () => ["src/a.js", "README.md", "src/lib/b.js", "node_modules/x/i.js"],
    });
    expect(context.source).toBe("git ls-files");
    expect(context.error).toMatch(/make-folder-txt failed|ENOENT|spawn/);
    expect(context.structure).toBe(
      [".", "├── src/", "│   ├── lib/", "│   │   └── b.js", "│   └── a.js", "└── README.md"].join("\n"),
    );
  });
});

describe("helpers", () => {
  it("normalizes the printed tree", () => {
    expect(normalizeStructure("\nmy-clone-1a2b3c/\r\n├── a.txt\r\n└── b/  [skipped]  \r\n\r\n")).toBe(
      ".\n├── a.txt\n└── b/  [skipped]",
    );
    expect(normalizeStructure("clone/\n├── .git/  [skipped]\n└── a.txt\n")).toBe(".\n└── a.txt");
    expect(normalizeStructure("clone/\n└── .git/  [skipped]\n")).toBe(".");
    expect(normalizeStructure("")).toBe("");
  });

  it("ignores the same paths as make-folder-txt", () => {
    expect(isIgnoredPath("node_modules/a/b.js")).toBe(true);
    expect(isIgnoredPath("packages/web/dist/app.js")).toBe(true);
    expect(isIgnoredPath(".env")).toBe(true);
    expect(isIgnoredPath("api/package-lock.json")).toBe(true);
    expect(isIgnoredPath("src/env.js")).toBe(false);
    expect(isIgnoredPath("distribution/notes.md")).toBe(false);
  });

  it("renders trees", () => {
    expect(renderTree(["b.txt", "a/x.js"])).toBe(".\n├── a/\n│   └── x.js\n└── b.txt");
  });
});
