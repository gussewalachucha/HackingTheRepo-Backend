import { describe, expect, it } from "vitest";
import {
  branchNameProblem,
  isValidBranchName,
  slugBranchName,
} from "../services/branchName.js";
import {
  buildGitEnv,
  checkBranchName,
  describeCloneFailure,
  describePushFailure,
  gitAuthHeader,
  sanitizedEnv,
} from "../services/git.js";

describe("branch names", () => {
  it.each([
    ["repomind/add-tests"],
    ["feature/x_1.2"],
    ["main"],
    ["a-b-c"],
  ])("accepts %s", (name) => {
    expect(branchNameProblem(name)).toBeNull();
  });

  it.each([
    ["-leading-dash"],
    ["has space"],
    ["tab\tname"],
    ["a..b"],
    ["/leading"],
    ["trailing/"],
    ["double//slash"],
    ["ends."],
    ["seg/.hidden"],
    ["x.lock"],
    ["seg.lock/x"],
    ["HEAD"],
    ["bad~1"],
    ["bad^"],
    ["bad:x"],
    ["bad?"],
    ["bad*"],
    ["bad[x"],
    ["bad@{1}"],
    ["back\\slash"],
    [""],
    ["x".repeat(121)],
  ])("rejects %j", (name) => {
    expect(isValidBranchName(name)).toBe(false);
  });

  it("slugs instructions like the old toBranchName", () => {
    expect(slugBranchName("Add unit tests!")).toBe("repomind/add-unit-tests");
    expect(slugBranchName("  Fix   the   bug ")).toBe("repomind/fix-the-bug");
    expect(slugBranchName("¿¿¿")).toBe("");
    expect(slugBranchName("x".repeat(80))).toBe(`repomind/${"x".repeat(50)}`);
  });

  it("double-checks with git check-ref-format", async () => {
    await expect(checkBranchName("repomind/ok-name")).resolves.toBe("repomind/ok-name");
    await expect(checkBranchName("-nope")).rejects.toThrow(/Invalid branch name/);
    await expect(checkBranchName("a..b")).rejects.toThrow(/Invalid branch name/);
  });
});

describe("git environment", () => {
  const token = "ghp_envTokenValue1234567890";

  it("authenticates with an extraheader and never exposes the raw token", () => {
    const env = buildGitEnv({ token, hooksPath: "/tmp/no-hooks", base: { PATH: "/usr/bin" } });
    const count = Number(env.GIT_CONFIG_COUNT);
    const config = [];
    for (let i = 0; i < count; i += 1) {
      config.push([env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
    }
    expect(config).toContainEqual(["credential.helper", ""]);
    expect(config).toContainEqual(["core.hooksPath", "/tmp/no-hooks"]);
    expect(config).toContainEqual(["core.autocrlf", "false"]);
    expect(config).toContainEqual(["commit.gpgSign", "false"]);
    expect(config).toContainEqual(["http.https://github.com/.extraheader", ""]);
    expect(config).toContainEqual(["http.https://github.com/.extraheader", gitAuthHeader(token)]);
    expect(gitAuthHeader(token)).toBe(
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    );
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GCM_INTERACTIVE).toBe("never");
    expect(env.GIT_LFS_SKIP_SMUDGE).toBe("1");
    for (const value of Object.values(env)) {
      expect(value).not.toContain(token);
    }
  });

  it("drops variables that redirect git or carry server secrets", () => {
    const env = sanitizedEnv({
      PATH: "/usr/bin",
      HOME: "/home/app",
      GIT_DIR: "/somewhere/else/.git",
      git_work_tree: "/x",
      GIT_ASKPASS: "/usr/bin/askpass",
      SSH_ASKPASS: "/usr/bin/askpass",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/evil",
      GIT_AUTHOR_NAME: "Someone",
      JWT_SECRET: "s",
      GROQ_API_KEY: "k",
      REPOMIND_GITHUB_TOKEN: "t",
      MONGO_URI: "mongodb://u:p@h/db",
      ENCRYPTION_KEY: "e",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/app" });
  });
});

describe("git error messages", () => {
  const ctx = { fullName: "acme/demo", branch: "repomind/x" };
  const failure = (stderr) => ({ stderr, message: "git failed" });

  it.each([
    ["remote: Permission to acme/demo.git denied to octocat.\nfatal: unable to access 'https://github.com/acme/demo.git/': The requested URL returned error: 403", /can't push to acme\/demo.*"repo" scope.*Contents: Read and write/],
    [" ! [remote rejected] repomind/x -> repomind/x (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)", /"workflow" scope/],
    [" ! [rejected]        repomind/x -> repomind/x (non-fast-forward)", /non-fast-forward/],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", /authentication failed/],
    ["remote: error: GH006: Protected branch update failed", /branch protection/],
  ])("maps push failure %#", (stderr, expected) => {
    expect(describePushFailure(failure(stderr), ctx)).toMatch(expected);
  });

  it("maps clone failures", () => {
    expect(describeCloneFailure(failure("fatal: Remote branch nope not found in upstream origin"), { ...ctx, branch: "nope" })).toMatch(/Branch "nope" was not found/);
    expect(describeCloneFailure(failure("remote: Repository not found."), ctx)).toMatch(/refused access/);
    expect(describeCloneFailure({ timedOut: true }, ctx)).toMatch(/timed out/);
  });
});
