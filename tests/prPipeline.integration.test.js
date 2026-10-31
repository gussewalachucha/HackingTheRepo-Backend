// End-to-end pipeline runs against a local bare repository with real git.
// GitHub and Groq are stubbed: nothing here talks to api.github.com or
// api.groq.com, and the "remote" is a file:// URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Job from "../models/Job.js";
import User from "../models/User.js";
import { GROQ_CHAT_URL, createGroqClient } from "../services/groq.js";
import { runPipeline } from "../services/prPipeline.js";
import { clearDb, connectTestDb, createUserAndToken, disconnectTestDb } from "./helpers.js";

const TIMEOUT = 180000;
const GITHUB_TOKEN = "ghp_integrationSecretToken123";
const CRLF_SOURCE = [
  "function greet(name) {",
  '  return "Hello " + name;',
  "}",
  "",
  "module.exports = { greet };",
  "",
].join("\r\n");
const README = "# Demo\n\nA demo repository.\n";

let tmpRoot;
let repoCounter = 0;

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function seedGit(cwd, args) {
  return git(cwd, [
    "-c",
    "core.autocrlf=false",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Seed",
    "-c",
    "user.email=seed@example.com",
    ...args,
  ]);
}

/** Bare repo (HEAD -> main) seeded with README.md and a CRLF src/index.js. */
function createRemote({ extraBranches = [] } = {}) {
  repoCounter += 1;
  const bare = path.join(tmpRoot, `remote-${repoCounter}.git`);
  const seed = path.join(tmpRoot, `seed-${repoCounter}`);
  git(tmpRoot, ["init", "--bare", bare]);
  git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(tmpRoot, ["init", seed]);
  git(seed, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  fs.mkdirSync(path.join(seed, "src"), { recursive: true });
  fs.writeFileSync(path.join(seed, "README.md"), README);
  fs.writeFileSync(path.join(seed, "src", "index.js"), CRLF_SOURCE);
  seedGit(seed, ["add", "-A"]);
  seedGit(seed, ["commit", "--no-verify", "-m", "Initial commit"]);
  seedGit(seed, ["push", bare, "main:refs/heads/main"]);
  for (const branch of extraBranches) {
    seedGit(seed, ["push", bare, `main:refs/heads/${branch}`]);
  }
  return { bare, url: pathToFileURL(bare).href };
}

/** A bare repo with no commits at all, like a brand-new GitHub repository. */
function createEmptyRemote() {
  repoCounter += 1;
  const bare = path.join(tmpRoot, `empty-${repoCounter}.git`);
  git(tmpRoot, ["init", "--bare", bare]);
  git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { bare, url: pathToFileURL(bare).href };
}

/** Branch refs on the remote, as `git ls-remote --heads` reports them. */
function remoteHeads(bare) {
  return git(tmpRoot, ["ls-remote", "--heads", pathToFileURL(bare).href])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1].trim())
    .sort();
}

function showFile(bare, ref, file) {
  return git(bare, ["cat-file", "blob", `${ref}:${file}`]);
}

function stubGitHub(overrides = {}) {
  return {
    getRepo: vi.fn(async () => ({
      owner: "acme",
      name: "demo",
      fullName: "acme/demo",
      defaultBranch: "main",
      canPush: true,
      archived: false,
    })),
    getUser: vi.fn(async () => ({ login: "octocat", id: 583231, name: "The Octocat" })),
    createPull: vi.fn(async () => ({ url: "https://github.com/acme/demo/pull/7", number: 7 })),
    findOpenPull: vi.fn(async () => ({ url: "https://github.com/acme/demo/pull/7", number: 7 })),
    ...overrides,
  };
}

/** LLM stub: `script[step]` is a value or ({ messages, calls }) => value. */
function stubLlm(script) {
  const calls = [];
  const client = {
    model: "stub-model",
    async completeJson({ step, buildMessages, budget }) {
      const messages = buildMessages(budget);
      calls.push({ step, messages });
      const handler = script[step];
      if (handler === undefined) throw new Error(`unexpected LLM step ${step}`);
      return typeof handler === "function" ? handler({ messages, calls }) : handler;
    },
  };
  return { calls, factory: vi.fn(() => client) };
}

const ANALYSIS = {
  analysis: "A tiny Node.js module exporting greet().",
  plan: ["Make greet friendlier", "Document the change"],
  files_to_read: ["src/index.js", "README.md"],
};

const FRIENDLY_EDIT = {
  summary: "greet() now says Hi and the README documents it.",
  commit_message: "Make greet friendlier",
  pr_body: "Updates greet() and the docs.",
  changes: [
    {
      path: "src/index.js",
      action: "edit",
      edits: [{ find: 'return "Hello " + name;', replace: 'return "Hi " + name + "!";' }],
    },
    { path: "README.md", action: "replace", content: "# Demo\n\nNow with friendlier greetings.\n" },
    { path: "docs/usage.md", action: "create", content: "Call greet(name)." },
  ],
};

function workRoot() {
  return path.join(tmpRoot, "work");
}

/** Clone folders left in the work root (".no-hooks" is shared, not a clone). */
function leftoverWorkdirs() {
  if (!fs.existsSync(workRoot())) return [];
  return fs.readdirSync(workRoot()).filter((name) => !name.startsWith("."));
}

/** The folder a job is cloned into: <owner>-<repo>-<last 6 of the id>. */
function cloneDirOf(job) {
  return path.join(workRoot(), `acme-demo-${String(job._id).slice(-6)}`);
}

async function newJob(userId, overrides = {}) {
  return Job.create({
    userId,
    repoUrl: "https://github.com/acme/demo",
    instruction: "Make greet friendlier and document it",
    branchName: "repomind/friendly-greet",
    prTitle: "Friendlier greeting",
    previewBeforePush: false,
    status: "queued",
    ...overrides,
  });
}

function run(jobId, mode, { url, gh, llm }) {
  return runPipeline(jobId, mode, {
    remoteUrl: url,
    createGitHubClient: () => gh,
    createLlmClient: llm.factory,
    workdirRoot: workRoot(),
  });
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repomind-it-"));
  await connectTestDb();
}, TIMEOUT);

afterAll(async () => {
  await disconnectTestDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
  delete process.env.PR_CLEANUP_WORKDIR;
}, TIMEOUT);

beforeEach(async () => {
  await clearDb();
  // Most tests check that nothing is left behind; the "keeps the clone"
  // tests switch this off to exercise the default.
  process.env.PR_CLEANUP_WORKDIR = "true";
  // Clones kept by earlier tests would show up as leftovers.
  for (const name of leftoverWorkdirs()) {
    fs.rmSync(path.join(workRoot(), name), { recursive: true, force: true, maxRetries: 5 });
  }
});

describe("PR pipeline with real git", () => {
  it(
    "clones, branches, edits, commits, pushes and opens a PR",
    async () => {
      const { bare, url } = createRemote();
      const { user } = await createUserAndToken({ username: "e2e", githubToken: GITHUB_TOKEN });
      const job = await newJob(user._id);
      const gh = stubGitHub();
      const llm = stubLlm({ analyze: ANALYSIS, edit: FRIENDLY_EDIT });

      const result = await run(job._id, "create", { url, gh, llm });
      expect(result.ok).toBe(true);

      const done = await Job.findById(job._id).select("+changes");
      expect(done.status).toBe("completed");
      expect(done.errorMessage).toBeNull();
      expect(done.prUrl).toBe("https://github.com/acme/demo/pull/7");
      expect(done.baseBranch).toBe("main");
      expect(done.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(done.diff).toContain('return "Hi " + name + "!";');
      expect(done.diff).toContain("docs/usage.md");
      expect(done.diffSummary).toContain("greet() now says Hi");
      expect(done.diffSummary).toMatch(/3 files changed/);
      expect(done.finishedAt).toBeTruthy();

      const steps = done.logs.map((entry) => entry.step);
      for (const step of ["clone", "branch", "structure", "analyze", "edit", "apply", "commit", "push", "pr", "done"]) {
        expect(steps).toContain(step);
      }
      expect(done.logs.some((entry) => entry.level === "error")).toBe(false);

      // The branch exists on the remote with the expected content.
      expect(remoteHeads(bare)).toContain("refs/heads/repomind/friendly-greet");
      const source = showFile(bare, "repomind/friendly-greet", "src/index.js");
      expect(source).toBe(CRLF_SOURCE.replace('return "Hello " + name;', 'return "Hi " + name + "!";'));
      expect(source.split("\n").length - 1).toBe(source.split("\r\n").length - 1);
      expect(showFile(bare, "repomind/friendly-greet", "README.md")).toBe(
        "# Demo\n\nNow with friendlier greetings.\n",
      );
      expect(showFile(bare, "repomind/friendly-greet", "docs/usage.md")).toBe("Call greet(name).\n");
      expect(showFile(bare, "main", "src/index.js")).toBe(CRLF_SOURCE);

      // Nothing but the AI's changes was committed (no make-folder-txt output).
      const tree = git(bare, ["ls-tree", "-r", "--name-only", "repomind/friendly-greet"]);
      expect(tree).not.toMatch(/\.txt\b/);
      expect(tree.trim().split("\n").sort()).toEqual(["README.md", "docs/usage.md", "src/index.js"]);

      // One commit on top of main, authored as the token's GitHub user.
      expect(git(bare, ["rev-list", "--count", "main..repomind/friendly-greet"]).trim()).toBe("1");
      expect(git(bare, ["log", "-1", "--format=%an <%ae>|%s", "repomind/friendly-greet"]).trim()).toBe(
        "The Octocat <583231+octocat@users.noreply.github.com>|Make greet friendlier",
      );

      // GitHub calls.
      expect(gh.createPull).toHaveBeenCalledTimes(1);
      const [owner, repo, pull] = gh.createPull.mock.calls[0];
      expect([owner, repo]).toEqual(["acme", "demo"]);
      expect(pull).toMatchObject({ title: "Friendlier greeting", head: "repomind/friendly-greet", base: "main" });
      expect(pull.body).toContain("Updates greet() and the docs.");
      expect(pull.body).toContain("Make greet friendlier and document it");

      // Prompts carry the structure and file contents but no server paths or secrets.
      const analyzePrompt = llm.calls.find((c) => c.step === "analyze").messages.map((m) => m.content).join("\n");
      expect(analyzePrompt).toContain("make-folder-txt --folder-structure");
      expect(analyzePrompt).toMatch(/\n\.\n(├|└)── /);
      expect(analyzePrompt).toContain("index.js");
      expect(analyzePrompt).not.toContain("The repository is empty");
      expect(analyzePrompt).toContain("Make greet friendlier and document it");
      const editPrompt = llm.calls.find((c) => c.step === "edit").messages.map((m) => m.content).join("\n");
      expect(editPrompt).toContain('<file path="src/index.js">');
      expect(editPrompt).toContain('return "Hello " + name;');
      const longTmpRoot = fs.realpathSync.native(tmpRoot);
      for (const prompt of [analyzePrompt, editPrompt]) {
        expect(prompt).not.toContain("Root:");
        expect(prompt).not.toContain(tmpRoot);
        expect(prompt).not.toContain(longTmpRoot);
        expect(prompt).not.toContain(tmpRoot.replace(/\\/g, "/"));
        expect(prompt).not.toContain(GITHUB_TOKEN);
        expect(prompt).not.toContain(path.basename(cloneDirOf(job)));
      }

      // Stored final file states, counters, cleanup.
      const changed = new Map(done.changes.map((c) => [c.path, c]));
      expect([...changed.keys()].sort()).toEqual(["README.md", "docs/usage.md", "src/index.js"]);
      expect(changed.get("src/index.js").content).toContain("\r\n");
      expect(JSON.stringify(done.toJSON())).not.toContain('"changes"');
      expect((await User.findById(user._id)).successfulPRs).toBe(1);
      expect(leftoverWorkdirs()).toEqual([]);
      const logText = done.logs.map((entry) => entry.message).join("\n");
      expect(logText).not.toContain(GITHUB_TOKEN);
      expect(logText).not.toContain(tmpRoot);
      expect(logText).not.toContain(longTmpRoot);
    },
    TIMEOUT,
  );

  it(
    "preview mode pushes nothing, then publish pushes the previewed changes and opens the PR",
    async () => {
      const { bare, url } = createRemote();
      const { user } = await createUserAndToken({ username: "previewer" });
      const job = await newJob(user._id, { previewBeforePush: true, branchName: "repomind/preview" });
      const gh = stubGitHub();
      const llm = stubLlm({ analyze: ANALYSIS, edit: FRIENDLY_EDIT });

      await run(job._id, "create", { url, gh, llm });
      const preview = await Job.findById(job._id).select("+changes");
      expect(preview.status).toBe("completed");
      expect(preview.prUrl).toBeNull();
      expect(preview.diff).toContain('return "Hi " + name + "!";');
      expect(preview.logs.at(-1).message).toMatch(/Preview ready/);
      expect(preview.changes).toHaveLength(3);
      expect(remoteHeads(bare)).toEqual(["refs/heads/main"]);
      expect(gh.createPull).not.toHaveBeenCalled();
      expect((await User.findById(user._id)).successfulPRs).toBe(0);

      // Publishing must not call the LLM again.
      const noLlm = stubLlm({});
      const result = await run(job._id, "publish", { url, gh, llm: noLlm });
      expect(result.ok).toBe(true);
      expect(noLlm.calls).toHaveLength(0);

      const published = await Job.findById(job._id);
      expect(published.status).toBe("completed");
      expect(published.prUrl).toBe("https://github.com/acme/demo/pull/7");
      expect(remoteHeads(bare)).toContain("refs/heads/repomind/preview");
      expect(showFile(bare, "repomind/preview", "src/index.js")).toBe(
        CRLF_SOURCE.replace('return "Hello " + name;', 'return "Hi " + name + "!";'),
      );
      expect(git(bare, ["log", "-1", "--format=%s", "repomind/preview"]).trim()).toBe("Make greet friendlier");
      expect(gh.createPull).toHaveBeenCalledTimes(1);
      expect(gh.createPull.mock.calls[0][2].body).toContain("Updates greet() and the docs.");
      expect((await User.findById(user._id)).successfulPRs).toBe(1);
      expect(leftoverWorkdirs()).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "refine on a PR job adds a second commit to the same branch",
    async () => {
      const { bare, url } = createRemote();
      const { user } = await createUserAndToken({ username: "refiner2" });
      const job = await newJob(user._id, { branchName: "repomind/refine-me" });
      const gh = stubGitHub();
      await run(job._id, "create", { url, gh, llm: stubLlm({ analyze: ANALYSIS, edit: FRIENDLY_EDIT }) });
      expect((await Job.findById(job._id)).prUrl).toBe("https://github.com/acme/demo/pull/7");

      await Job.updateOne(
        { _id: job._id },
        { $push: { refinements: { instruction: "Also export a farewell function" } } },
      );
      const refineLlm = stubLlm({
        analyze: { analysis: "Add farewell", plan: ["Add farewell()"], files_to_read: ["src/index.js"] },
        edit: {
          summary: "Added farewell()",
          commit_message: "Add farewell",
          pr_body: "",
          changes: [
            {
              path: "src/index.js",
              action: "edit",
              edits: [
                {
                  find: "module.exports = { greet };",
                  replace: 'function farewell(name) {\n  return "Bye " + name;\n}\n\nmodule.exports = { greet, farewell };',
                },
              ],
            },
          ],
        },
      });

      const result = await run(job._id, "refine", { url, gh, llm: refineLlm });
      expect(result.ok).toBe(true);

      const refined = await Job.findById(job._id);
      expect(refined.status).toBe("completed");
      expect(refined.refinements[0].applied).toBe(true);
      expect(refined.diffSummary).toMatch(/Refinement/);
      expect(git(bare, ["rev-list", "--count", "main..repomind/refine-me"]).trim()).toBe("2");
      const source = showFile(bare, "repomind/refine-me", "src/index.js");
      expect(source).toContain('function farewell(name) {\r\n  return "Bye " + name;\r\n}');
      expect(source).toContain('return "Hi " + name + "!";');
      expect(source.split("\n").length - 1).toBe(source.split("\r\n").length - 1);
      expect(gh.createPull).toHaveBeenCalledTimes(1);

      const prompt = refineLlm.calls[0].messages.map((m) => m.content).join("\n");
      expect(prompt).toMatch(/ALREADY implemented/);
      expect(prompt).toMatch(/NEW REQUEST[^\n]*\nAlso export a farewell function/);
      expect((await User.findById(user._id)).successfulPRs).toBe(1);
    },
    TIMEOUT,
  );

  it(
    "appends the job-id suffix when the branch already exists on the remote",
    async () => {
      const { bare, url } = createRemote({ extraBranches: ["repomind/collide"] });
      const { user } = await createUserAndToken({ username: "collider" });
      const job = await newJob(user._id, { branchName: "repomind/collide" });
      const gh = stubGitHub();

      await run(job._id, "create", { url, gh, llm: stubLlm({ analyze: ANALYSIS, edit: FRIENDLY_EDIT }) });

      const done = await Job.findById(job._id);
      const expected = `repomind/collide-${String(job._id).slice(-6)}`;
      expect(done.status).toBe("completed");
      expect(done.branchName).toBe(expected);
      expect(remoteHeads(bare)).toContain(`refs/heads/${expected}`);
      // The pre-existing branch was left untouched.
      expect(git(bare, ["rev-parse", "repomind/collide"]).trim()).toBe(git(bare, ["rev-parse", "main"]).trim());
      expect(gh.createPull.mock.calls[0][2].head).toBe(expected);
      expect(done.logs.some((entry) => entry.step === "branch" && /already exists/.test(entry.message))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "asks the AI for full content when an edit doesn't match, then applies it",
    async () => {
      const { bare, url } = createRemote();
      const { user } = await createUserAndToken({ username: "repairer" });
      const job = await newJob(user._id, { branchName: "repomind/repair" });
      const gh = stubGitHub();
      const llm = stubLlm({
        analyze: ANALYSIS,
        edit: {
          summary: "Rename",
          commit_message: "Rename greeting",
          changes: [
            { path: "src/index.js", action: "edit", edits: [{ find: "this text is not in the file", replace: "x" }] },
          ],
        },
        repair: {
          changes: [
            {
              path: "src/index.js",
              action: "replace",
              content: 'function greet(name) {\n  return "Howdy " + name;\n}\n\nmodule.exports = { greet };\n',
            },
          ],
        },
      });

      await run(job._id, "create", { url, gh, llm });

      const done = await Job.findById(job._id);
      expect(done.status).toBe("completed");
      expect(llm.calls.map((c) => c.step)).toEqual(["analyze", "edit", "repair"]);
      const repairPrompt = llm.calls[2].messages.map((m) => m.content).join("\n");
      expect(repairPrompt).toContain("this text is not in the file");
      expect(repairPrompt).toContain('return "Hello " + name;');
      const source = showFile(bare, "repomind/repair", "src/index.js");
      expect(source).toBe(CRLF_SOURCE.replace('"Hello "', '"Howdy "'));
    },
    TIMEOUT,
  );

  it(
    "fails clearly when the AI changes nothing, without pushing",
    async () => {
      const { bare, url } = createRemote();
      const { user } = await createUserAndToken({ username: "nochange" });
      const job = await newJob(user._id, { branchName: "repomind/nothing" });
      const gh = stubGitHub();
      const llm = stubLlm({
        analyze: ANALYSIS,
        edit: { summary: "", commit_message: "noop", changes: [{ path: "README.md", action: "replace", content: README }] },
      });

      const result = await run(job._id, "create", { url, gh, llm });
      expect(result.ok).toBe(false);
      const failed = await Job.findById(job._id);
      expect(failed.status).toBe("failed");
      expect(failed.errorMessage).toBe("The AI didn't change any files — try a more specific instruction.");
      expect(failed.logs.at(-1)).toMatchObject({ step: "error", level: "error" });
      expect(remoteHeads(bare)).toEqual(["refs/heads/main"]);
      expect(gh.createPull).not.toHaveBeenCalled();
      expect(leftoverWorkdirs()).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "rejects unsafe paths from the AI and never writes outside the clone",
    async () => {
      const { bare, url } = createRemote();
      const { user } = await createUserAndToken({ username: "unsafe", githubToken: GITHUB_TOKEN });
      const job = await newJob(user._id, { branchName: "repomind/unsafe" });
      const gh = stubGitHub();
      const llm = stubLlm({
        analyze: ANALYSIS,
        edit: {
          summary: "evil",
          commit_message: "evil",
          changes: [
            { path: "../escape.txt", action: "create", content: "pwned" },
            { path: "..\\..\\escape2.txt", action: "create", content: "pwned" },
            { path: ".git/config", action: "replace", content: "pwned" },
            { path: path.join(tmpRoot, "absolute.txt"), action: "create", content: "pwned" },
          ],
        },
      });

      await run(job._id, "create", { url, gh, llm });

      const failed = await Job.findById(job._id);
      expect(failed.status).toBe("failed");
      expect(failed.errorMessage).toMatch(/None of the AI's changes could be applied/);
      expect(failed.errorMessage).not.toContain(tmpRoot);
      expect(failed.errorMessage).not.toContain(GITHUB_TOKEN);
      expect(fs.existsSync(path.join(workRoot(), "escape.txt"))).toBe(false);
      expect(fs.existsSync(path.join(tmpRoot, "escape2.txt"))).toBe(false);
      expect(fs.existsSync(path.join(tmpRoot, "absolute.txt"))).toBe(false);
      expect(remoteHeads(bare)).toEqual(["refs/heads/main"]);
    },
    TIMEOUT,
  );

  it(
    "fails before cloning without push access, and redacts secrets from errors",
    async () => {
      const { url } = createRemote();
      const { user } = await createUserAndToken({ username: "nopush", githubToken: GITHUB_TOKEN });

      const job = await newJob(user._id);
      const noPush = stubGitHub({
        getRepo: vi.fn(async () => ({
          owner: "acme",
          name: "demo",
          fullName: "acme/demo",
          defaultBranch: "main",
          canPush: false,
        })),
      });
      await run(job._id, "create", { url, gh: noPush, llm: stubLlm({}) });
      const failed = await Job.findById(job._id);
      expect(failed.status).toBe("failed");
      expect(failed.errorMessage).toMatch(/push access/);
      expect(failed.errorMessage).toMatch(/Fork/);
      expect(failed.logs.some((entry) => entry.step === "clone" && /Cloning/.test(entry.message))).toBe(false);

      const leaky = await newJob(user._id);
      const exploding = stubGitHub({
        getRepo: vi.fn(async () => {
          throw new Error(`boom with ${GITHUB_TOKEN} and ${Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString("base64")}`);
        }),
      });
      await run(leaky._id, "create", { url, gh: exploding, llm: stubLlm({}) });
      const redacted = await Job.findById(leaky._id);
      expect(redacted.status).toBe("failed");
      expect(redacted.errorMessage).toContain("boom with ***");
      expect(redacted.errorMessage).not.toContain(GITHUB_TOKEN);
      expect(JSON.stringify(redacted.logs)).not.toContain(GITHUB_TOKEN);
    },
    TIMEOUT,
  );

  it(
    "works with the real Groq client over a fake transport (no network)",
    async () => {
      const { bare, url } = createRemote();
      const { user } = await createUserAndToken({ username: "realclient", groqKey: "gsk_userOwnGroqKey" });
      const job = await newJob(user._id, { branchName: "repomind/real-client" });
      const gh = stubGitHub();
      const replies = [
        // Fenced JSON with prose: must still parse.
        "Here is my analysis:\n```json\n" + JSON.stringify(ANALYSIS) + "\n```",
        JSON.stringify(FRIENDLY_EDIT),
      ];
      const http = {
        post: vi.fn(async () => ({
          data: { choices: [{ message: { content: replies.shift() }, finish_reason: "stop" }] },
        })),
      };
      const createLlmClient = vi.fn((options) => createGroqClient({ ...options, http }));

      const result = await runPipeline(job._id, "create", {
        remoteUrl: url,
        createGitHubClient: () => gh,
        createLlmClient,
        workdirRoot: workRoot(),
      });

      expect(result.ok).toBe(true);
      const done = await Job.findById(job._id);
      expect(done.status).toBe("completed");
      expect(showFile(bare, "repomind/real-client", "docs/usage.md")).toBe("Call greet(name).\n");
      expect(createLlmClient.mock.calls[0][0].apiKey).toBe("gsk_userOwnGroqKey");
      expect(http.post).toHaveBeenCalledTimes(2);
      for (const [endpoint, body, config] of http.post.mock.calls) {
        expect(endpoint).toBe(GROQ_CHAT_URL);
        expect(body.model).toBe(process.env.GROQ_MODEL || "openai/gpt-oss-120b");
        expect(body.response_format).toEqual({ type: "json_object" });
        expect(config.headers.Authorization).toBe("Bearer gsk_userOwnGroqKey");
      }
      const editUser = http.post.mock.calls[1][1].messages[1].content;
      expect(editUser).toContain("## Your plan\n1. Make greet friendlier");
      expect(editUser).toContain('<file path="src/index.js">');
    },
    TIMEOUT,
  );

  it(
    "retry after a failed publish re-runs the publish step",
    async () => {
      const { bare, url } = createRemote();
      const { user } = await createUserAndToken({ username: "retrypub" });
      const job = await newJob(user._id, { previewBeforePush: true, branchName: "repomind/retry-pub" });
      const gh = stubGitHub();
      await run(job._id, "create", { url, gh, llm: stubLlm({ analyze: ANALYSIS, edit: FRIENDLY_EDIT }) });

      const flaky = stubGitHub({
        createPull: vi.fn(async () => {
          const error = new Error("GitHub API error 502: Bad gateway");
          error.name = "GitHubError";
          throw error;
        }),
      });
      await run(job._id, "publish", { url, gh: flaky, llm: stubLlm({}) });
      const failed = await Job.findById(job._id);
      expect(failed.status).toBe("failed");
      expect(failed.errorMessage).toMatch(/502/);
      expect(remoteHeads(bare)).toContain("refs/heads/repomind/retry-pub");

      // The branch is already on the remote at our commit: retry only opens the PR.
      const pushedSha = git(bare, ["rev-parse", "repomind/retry-pub"]).trim();
      expect(failed.commitSha).toBe(pushedSha);
      const result = await run(job._id, "retry", { url, gh, llm: stubLlm({}) });
      expect(result.ok).toBe(true);
      const done = await Job.findById(job._id);
      expect(done.status).toBe("completed");
      expect(done.prUrl).toBe("https://github.com/acme/demo/pull/7");
      expect(done.branchName).toBe("repomind/retry-pub");
      expect(remoteHeads(bare).sort()).toEqual(["refs/heads/main", "refs/heads/repomind/retry-pub"]);
      expect(git(bare, ["rev-parse", "repomind/retry-pub"]).trim()).toBe(pushedSha);
      expect(gh.createPull).toHaveBeenCalledTimes(1);
      expect(gh.createPull.mock.calls[0][2]).toMatchObject({ head: "repomind/retry-pub", base: "main" });
    },
    TIMEOUT,
  );

  it(
    "a message sent while the job runs is applied by a follow-up pass on the same PR",
    async () => {
      const { bare, url } = createRemote();
      const { user } = await createUserAndToken({ username: "chatty" });
      const job = await newJob(user._id, { branchName: "repomind/chatty" });
      const gh = stubGitHub();
      // The user sends a message while Groq is analyzing.
      const llm = stubLlm({
        analyze: async () => {
          await Job.updateOne({ _id: job._id }, { $push: { refinements: { instruction: "Also add a CHANGELOG" } } });
          return ANALYSIS;
        },
        edit: FRIENDLY_EDIT,
      });

      const first = await run(job._id, "create", { url, gh, llm });
      expect(first).toMatchObject({ ok: true, followUp: true });
      const between = await Job.findById(job._id);
      expect(between.status).toBe("queued");
      expect(between.prUrl).toBe("https://github.com/acme/demo/pull/7");
      expect(between.refinements[0].applied).toBe(false);
      expect(between.logs.at(-1).message).toMatch(/new message is next/);

      const followLlm = stubLlm({
        analyze: { analysis: "Add changelog", plan: ["Create CHANGELOG.md"], files_to_read: [] },
        edit: {
          summary: "Added a changelog",
          commit_message: "Add CHANGELOG",
          changes: [{ path: "CHANGELOG.md", action: "create", content: "# Changelog\n" }],
        },
      });
      const second = await run(job._id, "refine", { url, gh, llm: followLlm });
      expect(second).toMatchObject({ ok: true, followUp: false });
      const done = await Job.findById(job._id);
      expect(done.status).toBe("completed");
      expect(done.refinements[0].applied).toBe(true);
      expect(showFile(bare, "repomind/chatty", "CHANGELOG.md")).toBe("# Changelog\n");
      expect(git(bare, ["rev-list", "--count", "main..repomind/chatty"]).trim()).toBe("2");
      expect(followLlm.calls[0].messages.map((m) => m.content).join("\n")).toMatch(/NEW REQUEST[^\n]*\nAlso add a CHANGELOG/);
      expect(gh.createPull).toHaveBeenCalledTimes(1);
    },
    TIMEOUT,
  );

  it(
    "checks the AI's code before committing and lets the AI fix a syntax error",
    async () => {
      const { bare, url } = createRemote();
      const { user } = await createUserAndToken({ username: "checker" });
      const job = await newJob(user._id, { branchName: "repomind/checked" });
      const gh = stubGitHub();
      const broken = "const path = require('path');\nconsole.log(path.join('a', 'b')));\n";
      const fixed = "const path = require('path');\nconsole.log(path.join('a', 'b'));\n";
      const llm = stubLlm({
        analyze: ANALYSIS,
        edit: {
          summary: "Add server",
          commit_message: "Add server",
          changes: [{ path: "server.js", action: "create", content: broken }],
        },
        fix: ({ messages }) => {
          expect(messages[1].content).toMatch(/SyntaxError/);
          expect(messages[1].content).toContain("server.js");
          return { changes: [{ path: "server.js", action: "replace", content: fixed }] };
        },
      });

      await run(job._id, "create", { url, gh, llm });

      const done = await Job.findById(job._id);
      expect(done.status).toBe("completed");
      expect(llm.calls.map((c) => c.step)).toEqual(["analyze", "edit", "fix"]);
      expect(showFile(bare, "repomind/checked", "server.js")).toBe(fixed);
      const messages = done.logs.map((entry) => entry.message).join("\n");
      expect(messages).toMatch(/Found 1 problem\(s\)/);
      expect(messages).toMatch(/all checks pass now/);
    },
    TIMEOUT,
  );

  it(
    "writes the files the AI picked one at a time, giving each call the files already written",
    async () => {
      const { bare, url } = createRemote();
      const { user } = await createUserAndToken({ username: "onebyone" });
      const job = await newJob(user._id, { branchName: "repomind/site" });
      const gh = stubGitHub();
      const llm = stubLlm({
        analyze: {
          analysis: "A small Node module; add a landing page.",
          plan: ["Add index.html", "Style it", "Mention it in the README"],
          files_to_read: ["README.md"],
          files_to_change: [
            { path: "site/index.html", action: "create", purpose: "Landing page with a .hero section" },
            { path: "site/style.css", action: "create", purpose: "Styles for .hero" },
            { path: "README.md", action: "modify", purpose: "Link to the site" },
            { path: "../evil.txt", action: "create", purpose: "escape" },
          ],
          commit_message: "Add landing page",
          design_brief: "Teal palette #0f766e, Inter font",
        },
        file: ({ messages, calls }) => {
          const prompt = messages[1].content;
          const n = calls.filter((c) => c.step === "file").length;
          if (n === 1) {
            expect(prompt).toMatch(/Write site\/index\.html \(create\)/);
            expect(prompt).toMatch(/site\/style\.css \(create\): Styles for \.hero/);
            return { content: '<section class="hero">Hi</section>\n' };
          }
          if (n === 2) {
            expect(prompt).toContain("Files already written in this change");
            expect(prompt).toContain('<section class="hero">Hi</section>');
            return { content: ".hero { color: teal; }\n" };
          }
          if (n === 3) {
            expect(prompt).toContain("## Current content of README.md");
            expect(prompt).toContain("A demo repository.");
            expect(prompt).toContain("## Design system (follow it exactly)\nTeal palette");
            return { content: "# Demo\n\nSee site/index.html.\n" };
          }
          // The rewrite after the review gets the feedback and its first version.
          expect(prompt).toMatch(/Review feedback — fix ALL of these in your new version of site\/style\.css/);
          expect(prompt).toContain("Fix: Add a hover state");
          expect(prompt).toContain(".hero { color: teal; }");
          return { content: ".hero { color: teal; }\n.hero:hover { color: navy; }\n" };
        },
        review: ({ messages }) => {
          expect(messages[1].content).toContain('<file path="site/index.html">');
          return {
            issues: [
              { path: "site/style.css", problem: "No hover state", fix: "Add a hover state" },
              { path: "not/written.js", problem: "ignored", fix: "ignored" },
            ],
          };
        },
      });

      await run(job._id, "create", { url, gh, llm });

      const done = await Job.findById(job._id);
      expect(done.status).toBe("completed");
      expect(llm.calls.map((c) => c.step)).toEqual(["analyze", "file", "file", "file", "review", "file"]);
      expect(showFile(bare, "repomind/site", "site/index.html")).toBe('<section class="hero">Hi</section>\n');
      expect(showFile(bare, "repomind/site", "site/style.css")).toBe(
        ".hero { color: teal; }\n.hero:hover { color: navy; }\n",
      );
      expect(done.logs.map((e) => e.message).join("\n")).toMatch(/Design system: Teal palette/);
      expect(showFile(bare, "repomind/site", "README.md")).toBe("# Demo\n\nSee site/index.html.\n");
      expect(git(bare, ["log", "-1", "--format=%s", "repomind/site"]).trim()).toBe("Add landing page");
      const messages = done.logs.map((e) => e.message).join("\n");
      expect(messages).toMatch(/\(1\/3\) Writing site\/index\.html/);
      expect(messages).toMatch(/Skipped \.\.\/evil\.txt/);
      expect(gh.createPull.mock.calls[0][2].body).toContain("`site/style.css` (create): Styles for .hero");
    },
    TIMEOUT,
  );

  const README_UPDATE = (content) =>
    stubLlm({
      analyze: { analysis: "Update docs", plan: ["Edit README"], files_to_read: ["README.md"] },
      edit: {
        summary: "Updated the README",
        commit_message: "Update README",
        changes: [{ path: "README.md", action: "replace", content }],
      },
    });

  it(
    "an update on a PR job continues in the existing clone instead of cloning again",
    async () => {
      delete process.env.PR_CLEANUP_WORKDIR;
      const { bare, url } = createRemote();
      const { user } = await createUserAndToken({ username: "reuser" });
      const job = await newJob(user._id, { branchName: "repomind/reuse" });
      const gh = stubGitHub();
      await run(job._id, "create", { url, gh, llm: stubLlm({ analyze: ANALYSIS, edit: FRIENDLY_EDIT }) });
      const marker = path.join(cloneDirOf(job), ".git", "reuse-marker");
      fs.writeFileSync(marker, "same clone");

      await Job.updateOne({ _id: job._id }, { $push: { refinements: { instruction: "Shorter README" } } });
      const result = await run(job._id, "refine", { url, gh, llm: README_UPDATE("# Demo\n") });
      expect(result.ok).toBe(true);

      const done = await Job.findById(job._id);
      expect(done.status).toBe("completed");
      expect(fs.existsSync(marker)).toBe(true); // the same folder was used
      const runLogs = done.logs.slice(done.logs.findLastIndex((e) => /refinement pass/.test(e.message)));
      const messages = runLogs.map((e) => e.message).join("\n");
      expect(messages).toMatch(/Reusing the copy already in acme-demo-/);
      expect(messages).toMatch(/Continuing on branch repomind\/reuse/);
      expect(messages).not.toMatch(/Cloning acme\/demo/);
      expect(git(bare, ["rev-list", "--count", "main..repomind/reuse"]).trim()).toBe("2");
      expect(showFile(bare, "repomind/reuse", "README.md")).toBe("# Demo\n");
    },
    TIMEOUT,
  );

  it(
    "reopens the pull request if it was closed, and opens a new one if it was merged",
    async () => {
      const { url } = createRemote();
      const { user } = await createUserAndToken({ username: "reopener" });
      const job = await newJob(user._id, { branchName: "repomind/reopen" });
      const created = stubGitHub();
      await run(job._id, "create", { url, gh: created, llm: stubLlm({ analyze: ANALYSIS, edit: FRIENDLY_EDIT }) });
      expect((await Job.findById(job._id)).prUrl).toBe("https://github.com/acme/demo/pull/7");

      // Closed without merging: reopened, same link.
      const closed = stubGitHub({
        findOpenPull: vi.fn(async () => null),
        getPull: vi.fn(async () => ({ url: "https://github.com/acme/demo/pull/7", number: 7, state: "closed", merged: false })),
        reopenPull: vi.fn(async () => ({ url: "https://github.com/acme/demo/pull/7", number: 7 })),
      });
      await Job.updateOne({ _id: job._id }, { $push: { refinements: { instruction: "Shorter README" } } });
      await run(job._id, "refine", { url, gh: closed, llm: README_UPDATE("# Demo\n") });
      let done = await Job.findById(job._id);
      expect(done.status).toBe("completed");
      expect(closed.getPull).toHaveBeenCalledWith("acme", "demo", 7, expect.anything());
      expect(closed.reopenPull).toHaveBeenCalledTimes(1);
      expect(closed.createPull).not.toHaveBeenCalled();
      expect(done.prUrl).toBe("https://github.com/acme/demo/pull/7");
      expect(done.logs.at(-1).message).toBe(
        "Update pushed to repomind/reopen — pull request: https://github.com/acme/demo/pull/7",
      );

      // Already merged: a new pull request, and the job points at it.
      const merged = stubGitHub({
        findOpenPull: vi.fn(async () => null),
        getPull: vi.fn(async () => ({ url: "https://github.com/acme/demo/pull/7", number: 7, state: "closed", merged: true })),
        reopenPull: vi.fn(),
        createPull: vi.fn(async () => ({ url: "https://github.com/acme/demo/pull/8", number: 8 })),
      });
      await Job.updateOne({ _id: job._id }, { $push: { refinements: { instruction: "Even shorter README" } } });
      await run(job._id, "refine", { url, gh: merged, llm: README_UPDATE("# D\n") });
      done = await Job.findById(job._id);
      expect(done.status).toBe("completed");
      expect(merged.reopenPull).not.toHaveBeenCalled();
      expect(merged.createPull.mock.calls[0][2]).toMatchObject({
        title: "Friendlier greeting (update)",
        head: "repomind/reopen",
        base: "main",
      });
      expect(done.prUrl).toBe("https://github.com/acme/demo/pull/8");
      expect(done.logs.map((e) => e.message).join("\n")).toMatch(/already merged/);
      expect((await User.findById(user._id)).successfulPRs).toBe(2);
    },
    TIMEOUT,
  );

  it(
    "clones again when the PR branch was changed on GitHub since the last update",
    async () => {
      delete process.env.PR_CLEANUP_WORKDIR;
      const { bare, url } = createRemote();
      const { user } = await createUserAndToken({ username: "moved" });
      const job = await newJob(user._id, { branchName: "repomind/moved" });
      const gh = stubGitHub();
      await run(job._id, "create", { url, gh, llm: stubLlm({ analyze: ANALYSIS, edit: FRIENDLY_EDIT }) });

      // Someone pushes to the PR branch on GitHub.
      const other = path.join(tmpRoot, `other-${job._id}`);
      git(tmpRoot, ["-c", "core.autocrlf=false", "clone", "-q", "--branch", "repomind/moved", url, other]);
      fs.writeFileSync(path.join(other, "NOTES.md"), "from a teammate\n");
      seedGit(other, ["add", "-A"]);
      seedGit(other, ["commit", "--no-verify", "-m", "Teammate note"]);
      seedGit(other, ["push", "origin", "repomind/moved"]);

      await Job.updateOne({ _id: job._id }, { $push: { refinements: { instruction: "Shorter README" } } });
      await run(job._id, "refine", { url, gh, llm: README_UPDATE("# Demo\n") });

      const done = await Job.findById(job._id);
      expect(done.status).toBe("completed");
      const messages = done.logs.map((e) => e.message).join("\n");
      expect(messages).toMatch(/Not reusing the existing copy \(repomind\/moved was changed on GitHub/);
      expect(showFile(bare, "repomind/moved", "NOTES.md")).toBe("from a teammate\n");
      expect(showFile(bare, "repomind/moved", "README.md")).toBe("# Demo\n");
    },
    TIMEOUT,
  );

  it(
    "an update on a preview continues in the existing clone and keeps the combined changes",
    async () => {
      delete process.env.PR_CLEANUP_WORKDIR;
      const { bare, url } = createRemote();
      const { user } = await createUserAndToken({ username: "previewreuse" });
      const job = await newJob(user._id, { previewBeforePush: true, branchName: "repomind/preview-reuse" });
      const gh = stubGitHub();
      await run(job._id, "create", { url, gh, llm: stubLlm({ analyze: ANALYSIS, edit: FRIENDLY_EDIT }) });

      await Job.updateOne({ _id: job._id }, { $push: { refinements: { instruction: "Add a license" } } });
      const licenseLlm = stubLlm({
        analyze: { analysis: "License", plan: ["Add LICENSE"], files_to_read: [] },
        edit: {
          summary: "Added MIT license",
          commit_message: "Add LICENSE",
          changes: [{ path: "LICENSE", action: "create", content: "MIT\n" }],
        },
      });
      await run(job._id, "refine", { url, gh, llm: licenseLlm });

      const preview = await Job.findById(job._id).select("+changes");
      expect(preview.status).toBe("completed");
      expect(preview.logs.map((e) => e.message).join("\n")).toMatch(/Reusing the copy already in/);
      // The diff and the stored preview cover both rounds.
      expect(preview.diff).toContain("LICENSE");
      expect(preview.diff).toContain("docs/usage.md");
      expect(preview.changes.map((c) => c.path).sort()).toEqual(["LICENSE", "README.md", "docs/usage.md", "src/index.js"]);
      expect(remoteHeads(bare)).toEqual(["refs/heads/main"]);

      await run(job._id, "publish", { url, gh, llm: stubLlm({}) });
      const published = await Job.findById(job._id);
      expect(published.prUrl).toBe("https://github.com/acme/demo/pull/7");
      expect(showFile(bare, "repomind/preview-reuse", "LICENSE")).toBe("MIT\n");
      expect(showFile(bare, "repomind/preview-reuse", "docs/usage.md")).toBe("Call greet(name).\n");
    },
    TIMEOUT,
  );

  const SCRATCH_ANALYSIS = {
    analysis: "The repository is empty; the site has to be created from scratch.",
    plan: ["Create index.html", "Add a README"],
    files_to_read: [],
  };
  const SCRATCH_EDIT = {
    summary: "Created a landing page and a README.",
    commit_message: "Add landing page",
    pr_body: "First version of the site.",
    changes: [
      { path: "index.html", action: "create", content: "<!doctype html>\n<h1>Hello</h1>\n" },
      { path: "README.md", action: "create", content: "# Site\n" },
    ],
  };

  it(
    "starts an empty repository: pushes an initial commit to main, then the branch, then opens the PR",
    async () => {
      const { bare, url } = createEmptyRemote();
      const { user } = await createUserAndToken({ username: "emptyrepo" });
      const job = await newJob(user._id, { branchName: "repomind/scratch" });
      const gh = stubGitHub();
      const llm = stubLlm({ analyze: SCRATCH_ANALYSIS, edit: SCRATCH_EDIT });

      const result = await run(job._id, "create", { url, gh, llm });
      expect(result.ok).toBe(true);

      const done = await Job.findById(job._id).select("+baseSha");
      expect(done.status).toBe("completed");
      expect(done.errorMessage).toBeNull();
      expect(done.prUrl).toBe("https://github.com/acme/demo/pull/7");
      expect(done.baseBranch).toBe("main");
      expect(done.baseSha).toBeNull();
      expect(done.diff).toContain("index.html");

      // main holds only the empty initial commit; the branch adds the files on top.
      expect(remoteHeads(bare)).toEqual(["refs/heads/main", "refs/heads/repomind/scratch"]);
      expect(git(bare, ["ls-tree", "-r", "--name-only", "main"]).trim()).toBe("");
      expect(git(bare, ["log", "-1", "--format=%s|%an", "main"]).trim()).toBe("Initial commit|The Octocat");
      expect(git(bare, ["rev-list", "--count", "main..repomind/scratch"]).trim()).toBe("1");
      expect(showFile(bare, "repomind/scratch", "index.html")).toBe("<!doctype html>\n<h1>Hello</h1>\n");
      expect(gh.createPull.mock.calls[0][2]).toMatchObject({ head: "repomind/scratch", base: "main" });

      const messages = done.logs.map((entry) => entry.message).join("\n");
      expect(messages).toMatch(/acme\/demo is empty \(no commits yet\)/);
      expect(messages).toMatch(/Created main on acme\/demo/);
      expect(done.logs.some((entry) => entry.level === "error")).toBe(false);

      const analyzePrompt = llm.calls[0].messages.map((m) => m.content).join("\n");
      expect(analyzePrompt).toContain("The repository is empty");
      expect(leftoverWorkdirs()).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "previews an empty repository without pushing anything, then publishes it",
    async () => {
      const { bare, url } = createEmptyRemote();
      const { user } = await createUserAndToken({ username: "emptypreview" });
      const job = await newJob(user._id, { previewBeforePush: true, branchName: "repomind/scratch-preview" });
      const gh = stubGitHub();

      await run(job._id, "create", { url, gh, llm: stubLlm({ analyze: SCRATCH_ANALYSIS, edit: SCRATCH_EDIT }) });
      const preview = await Job.findById(job._id).select("+changes +baseSha");
      expect(preview.status).toBe("completed");
      expect(preview.prUrl).toBeNull();
      expect(preview.baseSha).toBeNull();
      expect(preview.changes).toHaveLength(2);
      expect(remoteHeads(bare)).toEqual([]);

      const result = await run(job._id, "publish", { url, gh, llm: stubLlm({}) });
      expect(result.ok).toBe(true);
      const published = await Job.findById(job._id);
      expect(published.status).toBe("completed");
      expect(published.prUrl).toBe("https://github.com/acme/demo/pull/7");
      expect(remoteHeads(bare)).toEqual(["refs/heads/main", "refs/heads/repomind/scratch-preview"]);
      expect(showFile(bare, "repomind/scratch-preview", "README.md")).toBe("# Site\n");
      expect(published.logs.some((entry) => /moved since the preview/.test(entry.message))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "keeps the clone in the workspace folder by default, starts fresh on the next run, and removes it if the job is deleted",
    async () => {
      delete process.env.PR_CLEANUP_WORKDIR;
      const { url } = createRemote();
      const { user } = await createUserAndToken({ username: "keeper" });
      const job = await newJob(user._id, { branchName: "repomind/keep" });
      const gh = stubGitHub();

      await run(job._id, "create", { url, gh, llm: stubLlm({ analyze: ANALYSIS, edit: FRIENDLY_EDIT }) });
      const done = await Job.findById(job._id);
      expect(done.status).toBe("completed");
      const dir = cloneDirOf(job);
      expect(leftoverWorkdirs()).toEqual([path.basename(dir)]);
      expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);
      expect(fs.readFileSync(path.join(dir, "docs", "usage.md"), "utf8")).toBe("Call greet(name).\n");
      expect(done.logs.some((entry) => entry.message.includes(`into ${path.basename(dir)}`))).toBe(true);

      // The next run of the same job re-clones into the same, emptied folder.
      fs.writeFileSync(path.join(dir, "leftover.txt"), "from the previous run");
      await Job.updateOne({ _id: job._id }, { $push: { refinements: { instruction: "Shout the greeting" } } });
      await run(job._id, "refine", {
        url,
        gh,
        llm: stubLlm({
          analyze: { analysis: "Shout", plan: ["Uppercase"], files_to_read: ["src/index.js"] },
          edit: {
            summary: "Shouting",
            commit_message: "Shout",
            changes: [{ path: "README.md", action: "replace", content: "# DEMO\n" }],
          },
        }),
      });
      expect((await Job.findById(job._id)).status).toBe("completed");
      expect(fs.existsSync(path.join(dir, "leftover.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("# DEMO\n");

      // Deleted while running: the folder goes away with the job.
      const doomed = await newJob(user._id, { branchName: "repomind/doomed" });
      const deleting = stubLlm({
        analyze: async () => {
          await Job.deleteOne({ _id: doomed._id });
          return ANALYSIS;
        },
        edit: FRIENDLY_EDIT,
      });
      await run(doomed._id, "create", { url, gh, llm: deleting });
      expect(fs.existsSync(cloneDirOf(doomed))).toBe(false);
      expect(leftoverWorkdirs()).toEqual([path.basename(dir)]);
    },
    TIMEOUT,
  );
});
