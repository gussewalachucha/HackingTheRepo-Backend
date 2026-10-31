import { describe, expect, it, vi } from "vitest";
import {
  GitHubError,
  createGitHubClient,
  isRealPrUrl,
  parseRepoUrl,
} from "../services/github.js";

function apiError(status, data, headers = {}) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data, headers };
  return error;
}

function fakeHttp(handler) {
  return { request: vi.fn(handler) };
}

describe("parseRepoUrl", () => {
  it.each([
    ["https://github.com/acme/demo", "acme", "demo"],
    ["https://github.com/acme/demo.git", "acme", "demo"],
    ["https://github.com/acme/demo/", "acme", "demo"],
    ["https://github.com/acme/demo/tree/main/src", "acme", "demo"],
    ["https://www.github.com/Acme-Org/my.repo_name/pull/3", "Acme-Org", "my.repo_name"],
    ["  https://github.com/acme/demo?tab=readme  ", "acme", "demo"],
  ])("parses %s", (url, owner, repo) => {
    const parsed = parseRepoUrl(url);
    expect(parsed).toMatchObject({ owner, repo, fullName: `${owner}/${repo}` });
    expect(parsed.cloneUrl).toBe(`https://github.com/${owner}/${repo}.git`);
  });

  it.each([
    ["https://gitlab.com/acme/demo", /Only github\.com/],
    ["https://github.com.evil.com/acme/demo", /Only github\.com/],
    ["https://api.github.com/repos/acme/demo", /Only github\.com/],
    ["https://github.com/acme", /owner\/repo/],
    ["ftp://github.com/acme/demo", /Invalid repository URL/],
    ["not a url", /Invalid repository URL/],
    ["https://github.com/-bad/demo", /owner\/repo/],
    ["https://github.com/acme/..", /owner\/repo/],
  ])("rejects %s", (url, message) => {
    expect(() => parseRepoUrl(url)).toThrow(message);
  });
});

describe("isRealPrUrl", () => {
  it("accepts only github.com pull request URLs", () => {
    expect(isRealPrUrl("https://github.com/acme/demo/pull/7")).toBe(true);
    expect(isRealPrUrl("https://github.com/acme/demo/pull/7/files")).toBe(false);
    expect(isRealPrUrl("https://evil.com/acme/demo/pull/7")).toBe(false);
    expect(isRealPrUrl(null)).toBe(false);
  });
});

describe("GitHub client", () => {
  it("reads repository info with the right headers", async () => {
    const http = fakeHttp(async () => ({
      data: {
        full_name: "Acme/Demo",
        default_branch: "develop",
        permissions: { push: true },
        archived: false,
      },
    }));
    const repo = await createGitHubClient("ghp_token", { http }).getRepo("acme", "demo");
    expect(repo).toMatchObject({
      owner: "Acme",
      name: "Demo",
      fullName: "Acme/Demo",
      defaultBranch: "develop",
      canPush: true,
    });
    const config = http.request.mock.calls[0][0];
    expect(config).toMatchObject({ method: "get", url: "/repos/acme/demo" });
    expect(config.headers).toMatchObject({
      Authorization: "Bearer ghp_token",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(config.headers["User-Agent"]).toBeTruthy();
  });

  it("reads a pull request's state and reopens a closed one", async () => {
    const http = fakeHttp(async (config) =>
      config.method === "get"
        ? { data: { html_url: "https://github.com/a/b/pull/7", number: 7, state: "closed", merged: false } }
        : { data: { html_url: "https://github.com/a/b/pull/7", number: 7, state: "open" } },
    );
    const gh = createGitHubClient("t", { http });
    expect(await gh.getPull("a", "b", 7)).toEqual({
      url: "https://github.com/a/b/pull/7",
      number: 7,
      state: "closed",
      merged: false,
    });
    expect(await gh.reopenPull("a", "b", 7)).toMatchObject({ url: "https://github.com/a/b/pull/7" });
    expect(http.request.mock.calls[0][0]).toMatchObject({ method: "get", url: "/repos/a/b/pulls/7" });
    expect(http.request.mock.calls[1][0]).toMatchObject({
      method: "patch",
      url: "/repos/a/b/pulls/7",
      data: { state: "open" },
    });
  });

  it("reports missing push permission and unknown permissions", async () => {
    const noPush = fakeHttp(async () => ({ data: { full_name: "a/b", default_branch: "main", permissions: { push: false } } }));
    expect((await createGitHubClient("t", { http: noPush }).getRepo("a", "b")).canPush).toBe(false);
    const unknown = fakeHttp(async () => ({ data: { full_name: "a/b", default_branch: "main" } }));
    expect((await createGitHubClient("t", { http: unknown }).getRepo("a", "b")).canPush).toBeNull();
  });

  it("maps 404 and 401 to clear messages", async () => {
    const missing = fakeHttp(async () => {
      throw apiError(404, { message: "Not Found" });
    });
    await expect(createGitHubClient("t", { http: missing }).getRepo("a", "b")).rejects.toThrow(
      "Repository not found, or your GitHub token can't access it",
    );
    const badToken = fakeHttp(async () => {
      throw apiError(401, { message: "Bad credentials" });
    });
    await expect(createGitHubClient("t", { http: badToken }).getUser()).rejects.toThrow(/Bad credentials.*Settings/);
  });

  it("maps rate limiting", async () => {
    const limited = fakeHttp(async () => {
      throw apiError(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" });
    });
    await expect(createGitHubClient("t", { http: limited }).getUser()).rejects.toThrow(/rate limit exceeded/);
  });

  it("creates a pull request", async () => {
    const http = fakeHttp(async () => ({ data: { html_url: "https://github.com/a/b/pull/5", number: 5 } }));
    const pr = await createGitHubClient("t", { http }).createPull("a", "b", {
      title: "T",
      head: "feature",
      base: "main",
      body: "B",
    });
    expect(pr).toEqual({ url: "https://github.com/a/b/pull/5", number: 5, existing: false });
    expect(http.request.mock.calls[0][0]).toMatchObject({
      method: "post",
      url: "/repos/a/b/pulls",
      data: { title: "T", head: "feature", base: "main", body: "B" },
    });
  });

  it("reuses the open pull request when one already exists", async () => {
    const http = fakeHttp(async (config) => {
      if (config.method === "post") {
        throw apiError(422, {
          message: "Validation Failed",
          errors: [{ resource: "PullRequest", code: "custom", message: "A pull request already exists for a:feature." }],
        });
      }
      expect(config.params).toMatchObject({ head: "a:feature", state: "open" });
      return { data: [{ html_url: "https://github.com/a/b/pull/9", number: 9 }] };
    });
    const pr = await createGitHubClient("t", { http }).createPull("a", "b", {
      title: "T",
      head: "feature",
      base: "main",
      body: "",
    });
    expect(pr).toEqual({ url: "https://github.com/a/b/pull/9", number: 9, existing: true });
  });

  it("explains 'no commits between' errors", async () => {
    const http = fakeHttp(async () => {
      throw apiError(422, { message: "Validation Failed", errors: [{ message: "No commits between main and feature" }] });
    });
    const error = await createGitHubClient("t", { http })
      .createPull("a", "b", { title: "T", head: "feature", base: "main", body: "" })
      .catch((err) => err);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.message).toMatch(/no commits between main and feature/);
  });

  it("reports network failures", async () => {
    const http = fakeHttp(async () => {
      const error = new Error("getaddrinfo ENOTFOUND api.github.com");
      error.code = "ENOTFOUND";
      throw error;
    });
    await expect(createGitHubClient("t", { http }).getUser()).rejects.toThrow(/Couldn't reach GitHub: ENOTFOUND/);
  });
});
