import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  UnsafePathError,
  applyChanges,
  applyEditsToText,
  conformContent,
  normalizeRepoPath,
  replayChanges,
  resolveSafePath,
} from "../services/applyChanges.js";

const NUL = String.fromCharCode(0);
let outer;
let root;

beforeEach(() => {
  outer = fs.mkdtempSync(path.join(os.tmpdir(), "repomind-apply-"));
  root = path.join(outer, "repo");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n");
});

afterEach(() => {
  fs.rmSync(outer, { recursive: true, force: true });
});

const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const write = (rel, content) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};

describe("safe path resolver", () => {
  it.each([
    ["../outside.txt"],
    ["src/../../outside.txt"],
    ["..\\outside.txt"],
    ["src\\..\\..\\outside.txt"],
    ["/etc/passwd"],
    ["\\etc\\passwd"],
    ["\\\\server\\share\\file.txt"],
    ["//server/share/file.txt"],
    ["C:\\Windows\\win.ini"],
    ["c:/Windows/win.ini"],
    ["C:relative.txt"],
    [".git/config"],
    [".GIT/HEAD"],
    [".Git/hooks/pre-commit"],
    ["sub/.git/config"],
    [".git./config"],
    [".git /config"],
    ["git~1/config"],
    ["src\\.git\\config"],
    [`src/a${NUL}.js`],
    ["file.txt:stream"],
    [""],
    ["   "],
    ["./"],
  ])("rejects %j", async (input) => {
    await expect(resolveSafePath(root, input)).rejects.toBeInstanceOf(UnsafePathError);
  });

  it("rejects non-string paths", async () => {
    await expect(resolveSafePath(root, undefined)).rejects.toBeInstanceOf(UnsafePathError);
    await expect(resolveSafePath(root, 42)).rejects.toBeInstanceOf(UnsafePathError);
  });

  it.each([
    ["src/a.js", "src/a.js"],
    ["./src//a.js", "src/a.js"],
    ["src\\nested\\a.js", "src/nested/a.js"],
    [" README.md ", "README.md"],
    [".github/workflows/ci.yml", ".github/workflows/ci.yml"],
    [".gitignore", ".gitignore"],
    ["..foo/bar", "..foo/bar"],
  ])("accepts %j as %j", async (input, rel) => {
    const resolved = await resolveSafePath(root, input);
    expect(resolved.rel).toBe(rel);
    const relative = path.relative(fs.realpathSync.native(root), resolved.abs);
    expect(relative.split(path.sep).join("/")).toBe(rel);
  });

  it("rejects paths that go through a symbolic link", async () => {
    const target = path.join(outer, "elsewhere");
    fs.mkdirSync(target);
    try {
      fs.symlinkSync(target, path.join(root, "link"), "junction");
    } catch {
      return; // no symlink permission on this machine
    }
    await expect(resolveSafePath(root, "link/file.txt")).rejects.toThrow(/symbolic link/);
    const result = await applyChanges(root, [{ path: "link/file.txt", action: "create", content: "x" }]);
    expect(result.appliedCount).toBe(0);
    expect(fs.existsSync(path.join(target, "file.txt"))).toBe(false);
  });

  it.runIf(process.platform === "win32")("rejects Windows device names", () => {
    expect(() => normalizeRepoPath("src/con.js")).toThrow(UnsafePathError);
    expect(() => normalizeRepoPath("NUL")).toThrow(UnsafePathError);
  });
});

describe("applyEditsToText", () => {
  it("matches LF finds against CRLF files and keeps CRLF", () => {
    const original = "a\r\nb\r\nc\r\n";
    const out = applyEditsToText(original, [{ find: "a\nb", replace: "A\nB\nB2" }]);
    expect(out).toEqual({ ok: true, text: "A\r\nB\r\nB2\r\nc\r\n" });
  });

  it("fails when the find text is missing or ambiguous", () => {
    expect(applyEditsToText("x\n", [{ find: "nope", replace: "y" }])).toMatchObject({ ok: false });
    const ambiguous = applyEditsToText("x\nx\n", [{ find: "x", replace: "y" }]);
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error).toMatch(/2 places/);
    expect(applyEditsToText("x", [{ find: "", replace: "y" }]).ok).toBe(false);
    expect(applyEditsToText("x", [{ find: "x" }]).ok).toBe(false);
    expect(applyEditsToText("x", []).ok).toBe(false);
  });

  it("accepts a find that differs only in indentation or trailing whitespace", () => {
    const original = '<ul>\n    <li class="a">A</li>  \n    <li>B</li>\n</ul>\n';
    const out = applyEditsToText(original, [{ find: '<li class="a">A</li>\n<li>B</li>', replace: "    <li>Z</li>" }]);
    expect(out).toEqual({ ok: true, text: "<ul>\n    <li>Z</li>\n</ul>\n" });
  });

  it("accepts common edit field names and a null replacement as a deletion", () => {
    expect(applyEditsToText("a b c", [{ search: "b ", replacement: "" }]).text).toBe("a c");
    expect(applyEditsToText("a b c", [{ old: "b", new: "B" }]).text).toBe("a B c");
    expect(applyEditsToText("a b c", [{ find: " b", replace: null }]).text).toBe("a c");
  });

  it("treats regex characters literally and $ patterns in replacements literally", () => {
    const out = applyEditsToText("price = (a+b)*2;\n", [{ find: "(a+b)*2", replace: "$& $1" }]);
    expect(out.text).toBe("price = $& $1;\n");
  });
});

describe("conformContent", () => {
  it("keeps CRLF, BOM and the final newline of the original", () => {
    const bom = String.fromCharCode(0xfeff);
    expect(conformContent("x\ny", `${bom}a\r\nb\r\n`)).toBe(`${bom}x\r\ny\r\n`);
    expect(conformContent("x\ny", "a\nb")).toBe("x\ny");
    expect(conformContent("new", null)).toBe("new\n");
  });
});

describe("applyChanges", () => {
  it("creates, replaces, edits and deletes files", async () => {
    write("README.md", "# Old\n");
    write("src/a.js", "const a = 1;\nconst b = 2;\n");
    write("src/gone.js", "bye\n");

    const result = await applyChanges(root, [
      { path: "docs/new/guide.md", action: "create", content: "Guide" },
      { path: "README.md", action: "replace", content: "# New\n" },
      { path: "src/a.js", action: "edit", edits: [{ find: "const b = 2;", replace: "const b = 3;" }] },
      { path: "src/gone.js", action: "delete" },
    ]);

    expect(result.appliedCount).toBe(4);
    expect(result.failedEdits).toEqual([]);
    expect(read("docs/new/guide.md")).toBe("Guide\n");
    expect(read("README.md")).toBe("# New\n");
    expect(read("src/a.js")).toBe("const a = 1;\nconst b = 3;\n");
    expect(fs.existsSync(path.join(root, "src/gone.js"))).toBe(false);
  });

  it("preserves CRLF line endings on edit and replace", async () => {
    write("win.txt", "one\r\ntwo\r\nthree\r\n");
    write("win2.txt", "x\r\ny\r\n");
    await applyChanges(root, [
      { path: "win.txt", action: "edit", edits: [{ find: "two\nthree", replace: "TWO\nTHREE\nFOUR" }] },
      { path: "win2.txt", action: "replace", content: "a\nb" },
    ]);
    expect(read("win.txt")).toBe("one\r\nTWO\r\nTHREE\r\nFOUR\r\n");
    expect(read("win2.txt")).toBe("a\r\nb\r\n");
  });

  it("reports failing edits without touching the file", async () => {
    write("src/a.js", "const a = 1;\n");
    const result = await applyChanges(root, [
      { path: "src/a.js", action: "edit", edits: [{ find: "const z = 9;", replace: "x" }] },
    ]);
    expect(result.appliedCount).toBe(0);
    expect(result.failedEdits).toHaveLength(1);
    expect(result.failedEdits[0].path).toBe("src/a.js");
    expect(result.results[0]).toMatchObject({ ok: false });
    expect(read("src/a.js")).toBe("const a = 1;\n");
  });

  it("refuses unsafe paths and writes nothing outside the repository", async () => {
    const result = await applyChanges(root, [
      { path: "../escape.txt", action: "create", content: "x" },
      { path: ".git/config", action: "replace", content: "x" },
      { path: path.join(outer, "abs.txt"), action: "create", content: "x" },
    ]);
    expect(result.appliedCount).toBe(0);
    expect(result.results.every((r) => /unsafe path/.test(r.error))).toBe(true);
    expect(fs.existsSync(path.join(outer, "escape.txt"))).toBe(false);
    expect(fs.existsSync(path.join(outer, "abs.txt"))).toBe(false);
    expect(read(".git/config")).toBe("[core]\n");
  });

  it("refuses binary files, truncated full replaces and unknown actions", async () => {
    fs.writeFileSync(path.join(root, "img.bin"), Buffer.from([0, 1, 2, 3]));
    write("big.js", "line\n".repeat(10));
    const result = await applyChanges(
      root,
      [
        { path: "img.bin", action: "replace", content: "text" },
        { path: "big.js", action: "replace", content: "short" },
        { path: "x.js", action: "rename" },
        { path: "missing.js", action: "delete" },
        { path: "src", action: "replace", content: "x" },
      ],
      { truncatedPaths: new Set(["big.js"]) },
    );
    expect(result.appliedCount).toBe(0);
    expect(result.results.map((r) => r.error)).toEqual([
      expect.stringMatching(/binary/),
      expect.stringMatching(/truncated/),
      expect.stringMatching(/unknown action/),
      expect.stringMatching(/does not exist/),
      expect.stringMatching(/directory/),
    ]);
    expect(read("big.js")).toBe("line\n".repeat(10));
  });

  it("accepts common LLM field variations", async () => {
    write("a.txt", "hello\n");
    const result = await applyChanges(root, [
      { file: "a.txt", type: "modify", find: "hello", replace: "hi" },
      { filename: "b.txt", op: "add", new_content: "new" },
    ]);
    expect(result.appliedCount).toBe(2);
    expect(read("a.txt")).toBe("hi\n");
    expect(read("b.txt")).toBe("new\n");
  });
});

describe("replayChanges", () => {
  it("writes stored contents exactly and deletes files", async () => {
    write("old.txt", "old\n");
    const count = await replayChanges(root, [
      { path: "src/x.js", action: "write", content: "a\r\nb" },
      { path: "old.txt", action: "delete" },
    ]);
    expect(count).toBe(2);
    expect(read("src/x.js")).toBe("a\r\nb");
    expect(fs.existsSync(path.join(root, "old.txt"))).toBe(false);
  });

  it("throws on unsafe stored paths", async () => {
    await expect(
      replayChanges(root, [{ path: "../x", action: "write", content: "x" }]),
    ).rejects.toBeInstanceOf(UnsafePathError);
  });
});
