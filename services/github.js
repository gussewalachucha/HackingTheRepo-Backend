// Minimal GitHub REST client for the PR pipeline. Tests inject a fake `http`
// (anything with axios' `request(config)` signature) or stub the whole client.
import axios from "axios";

export const GITHUB_API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message, { status = null, detail = "" } = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.detail = detail;
  }
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Accepts https://github.com/owner/repo with an optional ".git", trailing
 * slash or extra path (/tree/main/src, /pull/3, ...). Throws a clear error
 * for anything that is not a github.com repository.
 */
export function parseRepoUrl(input) {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    throw new GitHubError(
      "Invalid repository URL — use https://github.com/owner/repo",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new GitHubError(
      "Invalid repository URL — use https://github.com/owner/repo",
    );
  }
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    throw new GitHubError(
      `Only github.com repositories are supported (got "${host}")`,
    );
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new GitHubError(
      "Repository URL must look like https://github.com/owner/repo",
    );
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (
    !OWNER_RE.test(owner) ||
    !REPO_RE.test(repo) ||
    repo === "." ||
    repo === ".."
  ) {
    throw new GitHubError(
      "Repository URL must look like https://github.com/owner/repo",
    );
  }
  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
    htmlUrl: `https://github.com/${owner}/${repo}`,
  };
}

export function isRealPrUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return false;
    const prPattern = /^\/[^/]+\/[^/]+\/pull\/\d+$/;
    return prPattern.test(parsed.pathname);
  } catch {
    return false;
  }
}

function errorDetail(data) {
  if (!data || typeof data !== "object") {
    return typeof data === "string" ? data.slice(0, 300) : "";
  }
  const parts = [];
  if (data.message) parts.push(String(data.message));
  if (Array.isArray(data.errors)) {
    for (const entry of data.errors) {
      const text =
        typeof entry === "string" ? entry : entry?.message || entry?.code;
      if (text) parts.push(String(text));
    }
  }
  return parts.join(": ");
}

export function toGitHubError(err) {
  if (err instanceof GitHubError) return err;
  const response = err?.response;
  if (!response) {
    const reason = err?.code || err?.message || "network error";
    return new GitHubError(`Couldn't reach GitHub: ${reason}`);
  }
  const { status } = response;
  const headers = response.headers || {};
  const detail = errorDetail(response.data);
  if (status === 401) {
    return new GitHubError(
      "GitHub rejected the token (401 Bad credentials). Update your GitHub token in Settings.",
      { status, detail },
    );
  }
  const rateLimited =
    String(headers["x-ratelimit-remaining"]) === "0" ||
    /rate limit/i.test(detail);
  if ((status === 403 || status === 429) && rateLimited) {
    const reset = Number(headers["x-ratelimit-reset"]);
    const when = Number.isFinite(reset)
      ? ` (resets at ${new Date(reset * 1000).toISOString()})`
      : "";
    return new GitHubError(
      `GitHub API rate limit exceeded${when}. Try again later.`,
      { status, detail },
    );
  }
  if (status === 403) {
    return new GitHubError(
      `GitHub denied the request (403): ${detail || "forbidden"}. Check that your token has access to this repository.`,
      { status, detail },
    );
  }
  return new GitHubError(
    `GitHub API error ${status}: ${detail || err.message}`,
    { status, detail },
  );
}

function defaultHttp() {
  return axios.create({
    baseURL: GITHUB_API,
    timeout: 30000,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "RepoMind-PR-Bot",
    },
  });
}

const seg = (value) => encodeURIComponent(value);

export function createGitHubClient(token, { http } = {}) {
  const client = http || defaultHttp();
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "RepoMind-PR-Bot",
  };

  async function request(method, url, { data, params, signal } = {}) {
    try {
      const res = await client.request({
        method,
        url,
        data,
        params,
        signal,
        headers: authHeaders,
      });
      return res.data;
    } catch (err) {
      if (err?.name === "CanceledError" || err?.code === "ERR_CANCELED") {
        throw err;
      }
      throw toGitHubError(err);
    }
  }

  async function findOpenPull(owner, repo, branch, { signal } = {}) {
    const data = await request("get", `/repos/${seg(owner)}/${seg(repo)}/pulls`, {
      params: { head: `${owner}:${branch}`, state: "open", per_page: 5 },
      signal,
    });
    const pr = Array.isArray(data) ? data[0] : null;
    return pr ? { url: pr.html_url, number: pr.number } : null;
  }

  return {
    async getRepo(owner, repo, { signal } = {}) {
      let data;
      try {
        data = await request("get", `/repos/${seg(owner)}/${seg(repo)}`, {
          signal,
        });
      } catch (err) {
        if (err.status === 404) {
          throw new GitHubError(
            "Repository not found, or your GitHub token can't access it",
            { status: 404, detail: err.detail },
          );
        }
        throw err;
      }
      const fullName = data?.full_name || `${owner}/${repo}`;
      const [canonicalOwner, canonicalRepo] = fullName.split("/");
      return {
        owner: canonicalOwner || owner,
        name: canonicalRepo || repo,
        fullName,
        defaultBranch: data?.default_branch || "main",
        // null when GitHub doesn't report permissions for this token type
        canPush:
          data?.permissions && typeof data.permissions.push === "boolean"
            ? data.permissions.push
            : null,
        archived: Boolean(data?.archived),
        private: Boolean(data?.private),
      };
    },

    async getUser({ signal } = {}) {
      const data = await request("get", "/user", { signal });
      return {
        login: data?.login || "",
        id: data?.id ?? null,
        name: data?.name || "",
      };
    },

    async createPull(owner, repo, { title, head, base, body }, { signal } = {}) {
      try {
        const data = await request(
          "post",
          `/repos/${seg(owner)}/${seg(repo)}/pulls`,
          { data: { title, head, base, body }, signal },
        );
        return { url: data?.html_url, number: data?.number, existing: false };
      } catch (err) {
        if (
          err.status === 422 &&
          /pull request already exists/i.test(`${err.detail} ${err.message}`)
        ) {
          const existing = await findOpenPull(owner, repo, head, { signal });
          if (existing) return { ...existing, existing: true };
        }
        if (err.status === 422 && /no commits between/i.test(err.detail)) {
          throw new GitHubError(
            `GitHub says there are no commits between ${base} and ${head}.`,
            { status: 422, detail: err.detail },
          );
        }
        throw err;
      }
    },

    findOpenPull,

    /** { url, number, state: "open"|"closed", merged } of pull request `number`. */
    async getPull(owner, repo, number, { signal } = {}) {
      const data = await request("get", `/repos/${seg(owner)}/${seg(repo)}/pulls/${Number(number)}`, {
        signal,
      });
      return {
        url: data?.html_url,
        number: data?.number,
        state: data?.state,
        merged: Boolean(data?.merged || data?.merged_at),
      };
    },

    /** Reopen a closed (not merged) pull request. */
    async reopenPull(owner, repo, number, { signal } = {}) {
      const data = await request("patch", `/repos/${seg(owner)}/${seg(repo)}/pulls/${Number(number)}`, {
        data: { state: "open" },
        signal,
      });
      return { url: data?.html_url, number: data?.number, existing: true };
    },
  };
}
