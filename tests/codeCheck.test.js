import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkFiles, looksLikeJsx } from "../services/codeCheck.js";

let dir;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "repomind-check-"));
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  write("ok.js", "const a = 1;\nmodule.exports = a;\n");
  write("esm.mjs", "export const a = 1;\n");
  write("server.js", "app.get('/', (req, res) => {\n  res.send(path.join('a', 'b')));\n});\n");
  write("good.json", '{ "name": "x" }\n');
  write("bad.json", '{ "name": "x", }\n');
  write("tsconfig.json", "{ // comments are fine here\n}\n");
  write("App.js", "export default function App() {\n  return <div>Hi</div>;\n}\n");
  write("README.md", "not checked (");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("checkFiles", () => {
  it("reports syntax errors in JS and JSON, with repo-relative paths", async () => {
    const problems = await checkFiles(dir, [
      "ok.js",
      "esm.mjs",
      "server.js",
      "good.json",
      "bad.json",
      "tsconfig.json",
      "App.js",
      "README.md",
      "missing.js",
    ]);
    expect(problems.map((p) => p.path).sort()).toEqual(["bad.json", "server.js"]);
    const server = problems.find((p) => p.path === "server.js");
    expect(server.error).toMatch(/SyntaxError/);
    expect(server.error).not.toContain(dir);
    expect(server.content).toContain("res.send");
    expect(problems.find((p) => p.path === "bad.json").error).toMatch(/^Invalid JSON/);
  }, 60000);

  it("detects JSX", () => {
    expect(looksLikeJsx("return <div>Hi</div>;")).toBe(true);
    expect(looksLikeJsx("return <Button />;")).toBe(true);
    expect(looksLikeJsx("if (a < b && c > d) {}")).toBe(false);
  });
});
