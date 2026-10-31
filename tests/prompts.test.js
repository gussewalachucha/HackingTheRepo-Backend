import { describe, expect, it } from "vitest";
import {
  buildRepairMessages,
  editExcerpts,
  normalizeAnalysis,
  styledClasses,
  usedClasses,
  validateCssAdditions,
  validateFile,
} from "../services/prompts.js";

describe("class consistency helpers", () => {
  it("collects classes from HTML and from JS classList calls", () => {
    const html = '<header class="site-header is-sticky"><div class="hero  hero--dark"></div></header>';
    const js = "menu.classList.toggle('open'); el.classList.add(\"visible\");";
    expect([...usedClasses(html, js)].sort()).toEqual(
      ["hero", "hero--dark", "is-sticky", "open", "site-header", "visible"].sort(),
    );
  });

  it("collects classes used in CSS selectors, ignoring comments", () => {
    const css = "/* .ghost */ .hero, .card:hover > .title { color: red; } @media (min-width: 640px) { .grid { gap: 1rem } }";
    expect([...styledClasses(css)].sort()).toEqual(["card", "grid", "hero", "title"]);
  });
});

describe("analysis and reply validation", () => {
  it("normalizes files_to_change and the design brief", () => {
    const analysis = normalizeAnalysis({
      analysis: "x",
      plan: ["a"],
      files_to_change: [
        { path: "./site/index.html", action: "create", purpose: "Home" },
        { path: "site\\style.css", action: "weird" },
        "README.md",
        { path: "./site/index.html", action: "modify" },
      ],
      design_brief: "Teal",
      commit_message: "Add site",
    });
    expect(analysis.filesToChange).toEqual([
      { path: "site/index.html", action: "create", purpose: "Home" },
      { path: "site/style.css", action: "modify", purpose: "Implement the request" },
      { path: "README.md", action: "modify", purpose: "Implement the request" },
    ]);
    expect(analysis.designBrief).toBe("Teal");
    expect(analysis.commitMessage).toBe("Add site");
  });

  it("validates file and css replies", () => {
    expect(validateFile({ content: "" }).ok).toBe(true);
    expect(validateFile({ edits: [{ find: "a", replace: "b" }] }).ok).toBe(true);
    expect(validateFile({}).ok).toBe(false);
    // Only part of the file was shown: a full rewrite would drop the rest.
    const partial = validateFile({ content: "whole file" }, { truncated: true });
    expect(partial.ok).toBe(false);
    expect(partial.error).toMatch(/edits/);
    expect(validateFile({ edits: [{ find: "a", replace: "b" }] }, { truncated: true }).ok).toBe(true);
    expect(validateCssAdditions({ css: ".a{}" }).ok).toBe(true);
    expect(validateCssAdditions({ css: "  " }).ok).toBe(false);
  });
});

describe("repair round", () => {
  const ctx = { repoFullName: "a/b", baseBranch: "main", request: "## Change request\nfix the slider" };
  const big = Array.from({ length: 400 }, (_, i) => `<div class="item item-${i}">${"x".repeat(80)}</div>`).join("\n");

  it("shows numbered excerpts around the lines an edit refers to", () => {
    const text = editExcerpts(big, [{ find: '<div class="item item-200">', replace: "" }], { radius: 2 });
    expect(text).toContain("  201| <div class=\"item item-200\">");
    expect(text).toContain("  199|");
    expect(text).not.toContain("  150|");
  });

  it("shows small files in full and asks for edits on large ones", () => {
    const meta = {};
    const messages = buildRepairMessages(
      ctx,
      [
        { rel: "small.css", content: ".a { color: red; }\n", edits: [{ find: ".b" }], error: "not found" },
        { rel: "index.html", content: big, edits: [{ find: '<div class="item item-7">' }], error: "matches 3 places" },
      ],
      { structureChars: 1000, contextChars: 8000, fileChars: 10000 },
      meta,
    );
    const user = messages[1].content;
    expect(meta.included).toEqual(["small.css", "index.html"]);
    expect([...meta.excerpted]).toEqual(["index.html"]);
    expect(user).toContain('<file path="small.css">');
    expect(user).toContain("excerpts only");
    expect(user).toContain("    8| <div class=\"item item-7\">");
  });
});
