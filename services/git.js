// Thin, shell-free wrappers around the git CLI used by the PR pipeline.
//
// Security notes:
// - Every command runs through execFile with an argv array (never a shell).
// - The GitHub token is never placed in a URL, in argv or in .git/config: it
//   travels only in the child's environment as an `http.<url>.extraheader`
//   set through GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n.
// - Credential helpers, askpass programs and terminal prompts are disabled so
//   git can never block waiting for input or pick up another identity.
import { execFile } from "node:child_process";
import { branchNameProblem } from "./branchName.js";

export const GIT_TIMEOUTS = {
  clone: 5 * 60 * 1000,
  push: 3 * 60 * 1000,
  network: 90 * 1000,
  local: 60 * 1000,
};

const BIG_OUTPUT = 64 * 1024 * 1024;

export class GitError extends Error {
  constructor(
    message,
    {
      command = "",
      stderr = "",
      exitCode = null,
      timedOut = false,
      aborted = false,
      tooMuchOutput = false,
    } = {},
  ) {
    super(message);
    this.name = "GitError";
    this.command = command;
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.timedOut = timedOut;
    this.aborted = aborted;
    this.tooMuchOutput = tooMuchOutput;
  }
}

// Environment variables that could redirect git to another repository, run
// other programs, change the commit identity or leak secrets into stderr.
const STRIP_ENV = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INDEX_VERSION",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_TEMPLATE_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_PAGER",
  "GIT_EXTERNAL_DIFF",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "GIT_ALLOW_PROTOCOL",
  "GIT_PROTOCOL_FROM_USER",
  "GIT_REPLACE_REF_BASE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
  "GIT_QUARANTINE_PATH",
  "GIT_REFLOG_ACTION",
  "GIT_PUSH_OPTION_COUNT",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
  "GIT_TRACE",
  "GIT_TRACE2",
  "GIT_TRACE2_EVENT",
  "GIT_TRACE2_PERF",
  "GIT_TRACE_CURL",
  "GIT_TRACE_CURL_NO_DATA",
  "GIT_TRACE_PACKET",
  "GIT_TRACE_PACK_ACCESS",
  "GIT_TRACE_PERFORMANCE",
  "GIT_TRACE_SETUP",
  "GIT_TRACE_REDACT",
  "GIT_CURL_VERBOSE",
]);

// Server secrets (JWT_SECRET, MONGO_URI, GROQ_API_KEY, ...) never need to
// reach a child process.
const SECRET_ENV_NAME =
  /(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ENCRYPTION_KEY|MONGO_URI|DATABASE_URL)/;

/** process.env minus anything a child process must not inherit. */
export function sanitizedEnv(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (STRIP_ENV.has(upper)) continue;
    if (
      upper.startsWith("GIT_CONFIG_KEY_") ||
      upper.startsWith("GIT_CONFIG_VALUE_")
    ) {
      continue;
    }
    if (SECRET_ENV_NAME.test(upper)) continue;
    env[key] = value;
  }
  return env;
}

export function gitAuthHeader(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return `AUTHORIZATION: basic ${basic}`;
}

/**
 * Environment for every git child process of a job. Config entries passed via
 * GIT_CONFIG_COUNT override the system/global/repo config files.
 */
export function buildGitEnv({ token, hooksPath, base = process.env } = {}) {
  const env = sanitizedEnv(base);
  const config = [
    // No credential helpers: auth comes only from the header below.
    ["credential.helper", ""],
    ["credential.https://github.com.helper", ""],
    // Never sign, never run hooks or fsmonitor daemons from the host config.
    ["commit.gpgSign", "false"],
    ["tag.gpgSign", "false"],
    ["core.fsmonitor", "false"],
    // Work on the exact bytes stored in the repository.
    ["core.autocrlf", "false"],
    ["core.quotePath", "false"],
    // No background gc/maintenance holding files while we delete the clone.
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ["advice.detachedHead", "false"],
    // Abort stalled transfers instead of hanging until the job timeout.
    ["http.lowSpeedLimit", "1000"],
    ["http.lowSpeedTime", "60"],
  ];
  if (hooksPath) config.push(["core.hooksPath", hooksPath]);
  if (token) {
    // An empty value resets extraheaders inherited from other config files.
    config.push(["http.https://github.com/.extraheader", ""]);
    config.push(["http.https://github.com/.extraheader", gitAuthHeader(token)]);
  }
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  env.GIT_LFS_SKIP_SMUDGE = "1";
  // English messages so failures can be recognised below.
  env.LC_ALL = "C";
  return env;
}

function subcommandOf(args) {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i] || "git";
}

export function tailLines(text, maxLines = 12, maxChars = 1500) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  let out = lines.slice(-maxLines).join("\n");
  if (out.length > maxChars) out = out.slice(-maxChars);
  return out;
}

/**
 * Run git with an argv array. Resolves { stdout, stderr }; rejects with a
 * GitError carrying stderr plus timeout/abort flags.
 */
export function runGit(
  args,
  {
    cwd,
    env,
    timeout = GIT_TIMEOUTS.local,
    signal,
    maxBuffer = 16 * 1024 * 1024,
  } = {},
) {
  const command = subcommandOf(args);
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: env || buildGitEnv(),
        timeout,
        signal,
        maxBuffer,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }
        const details = { command, stderr: String(stderr || "") };
        if (error.name === "AbortError" || error.code === "ABORT_ERR") {
          reject(
            new GitError(`git ${command} was cancelled`, {
              ...details,
              aborted: true,
            }),
          );
          return;
        }
        if (error.code === "ENOENT") {
          reject(
            new GitError("git is not installed or not on the server's PATH", {
              ...details,
            }),
          );
          return;
        }
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(
            new GitError(`git ${command} produced too much output`, {
              ...details,
              tooMuchOutput: true,
            }),
          );
          return;
        }
        if (error.killed) {
          reject(
            new GitError(
              `git ${command} timed out after ${Math.round(timeout / 1000)}s`,
              { ...details, timedOut: true },
            ),
          );
          return;
        }
        const tail = tailLines(stderr) || error.message;
        reject(
          new GitError(`git ${command} failed: ${tail}`, {
            ...details,
            exitCode: typeof error.code === "number" ? error.code : null,
          }),
        );
      },
    );
  });
}

/** Validate with our rules and `git check-ref-format --branch`. */
export async function checkBranchName(name, options = {}) {
  const problem = branchNameProblem(name);
  if (problem) throw new GitError(`Invalid branch name "${name}": ${problem}`);
  try {
    const { stdout } = await runGit(
      ["check-ref-format", "--branch", name],
      options,
    );
    return stdout.trim() || name;
  } catch (err) {
    if (err.aborted || err.timedOut) throw err;
    throw new GitError(`Invalid branch name "${name}"`, {
      command: "check-ref-format",
      stderr: err.stderr,
    });
  }
}

export async function cloneRepo({ url, branch, dir, cwd, env, signal }) {
  const problem = branchNameProblem(branch);
  if (problem) throw new GitError(`Invalid branch name "${branch}": ${problem}`);
  await runGit(
    [
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      `--branch=${branch}`,
      "-c",
      "core.symlinks=false",
      "-c",
      "core.longpaths=true",
      "--",
      url,
      dir,
    ],
    { cwd, env, signal, timeout: GIT_TIMEOUTS.clone },
  );
}

export async function headSha(cwd, options = {}) {
  const { stdout } = await runGit(["rev-parse", "HEAD"], { cwd, ...options });
  return stdout.trim();
}

/** Tip commit of `branch` on `remote` (a remote name or URL), or null. */
export async function remoteBranchSha(cwd, remote, branch, options = {}) {
  const ref = `refs/heads/${branch}`;
  const { stdout } = await runGit(["ls-remote", "--heads", remote, ref], {
    cwd,
    timeout: GIT_TIMEOUTS.network,
    ...options,
  });
  for (const line of stdout.split("\n")) {
    const [sha, name] = line.split("\t");
    if ((name || "").trim() === ref) return sha.trim();
  }
  return null;
}

export async function remoteBranchExists(cwd, branch, options = {}) {
  return (await remoteBranchSha(cwd, "origin", branch, options)) !== null;
}

export async function checkoutNewBranch(cwd, branch, options = {}) {
  await runGit(["checkout", "-b", branch], { cwd, ...options });
}

/** Tracked plus untracked (non-ignored) files, relative posix paths. */
export async function listFiles(cwd, options = {}) {
  const { stdout } = await runGit(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd, maxBuffer: BIG_OUTPUT, ...options },
  );
  return [...new Set(stdout.split("\0").filter(Boolean))];
}

export async function addAll(cwd, options = {}) {
  await runGit(["add", "-A"], { cwd, ...options });
}

export async function statusPorcelain(cwd, options = {}) {
  const { stdout } = await runGit(["status", "--porcelain"], {
    cwd,
    maxBuffer: BIG_OUTPUT,
    ...options,
  });
  return stdout;
}

/** Unified diff of the staged changes, or null if it is unreasonably large. */
export async function diffCached(cwd, options = {}) {
  try {
    const { stdout } = await runGit(
      ["diff", "--cached", "--no-color", "--no-ext-diff", "-M"],
      { cwd, maxBuffer: BIG_OUTPUT, ...options },
    );
    return stdout;
  } catch (err) {
    if (err.tooMuchOutput) return null;
    throw err;
  }
}

export async function diffStat(cwd, options = {}) {
  const { stdout } = await runGit(
    ["diff", "--cached", "--stat=100", "--no-color", "-M"],
    { cwd, maxBuffer: BIG_OUTPUT, ...options },
  );
  return stdout.trimEnd();
}

/** [{ status: "A"|"M"|"D"|"T", path }] for the staged changes. */
export async function stagedChanges(cwd, options = {}) {
  const { stdout } = await runGit(
    ["diff", "--cached", "--name-status", "-z", "--no-renames"],
    { cwd, maxBuffer: BIG_OUTPUT, ...options },
  );
  const parts = stdout.split("\0");
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i];
    const filePath = parts[i + 1];
    if (!status || !filePath) continue;
    out.push({ status: status[0], path: filePath });
  }
  return out;
}

export async function commit(cwd, { message, name, email, allowEmpty = false }, options = {}) {
  await runGit(
    [
      "-c",
      `user.name=${name}`,
      "-c",
      `user.email=${email}`,
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      ...(allowEmpty ? ["--allow-empty"] : []),
      `--message=${message}`,
    ],
    { cwd, ...options },
  );
}

/** Branch names on `remote` (a remote name or URL); [] for an empty repository. */
export async function listRemoteHeads(cwd, remote, options = {}) {
  const { stdout } = await runGit(["ls-remote", "--heads", remote], {
    cwd,
    timeout: GIT_TIMEOUTS.network,
    ...options,
  });
  return stdout
    .split("\n")
    .map((line) => (line.split("\t")[1] || "").trim())
    .filter((ref) => ref.startsWith("refs/heads/"))
    .map((ref) => ref.slice("refs/heads/".length));
}

/**
 * Start a local repository for a remote that has no commits yet: `git init`,
 * HEAD on `branch`, `origin` pointing at `url`. Same safety settings as a
 * clone (core.symlinks=false).
 */
export async function initRepo({ dir, branch, url, cwd, env, signal }) {
  const problem = branchNameProblem(branch);
  if (problem) throw new GitError(`Invalid branch name "${branch}": ${problem}`);
  const options = { env, signal };
  await runGit(["init", "--quiet", "--", dir], { cwd, ...options });
  await runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], { cwd: dir, ...options });
  await runGit(["config", "core.symlinks", "false"], { cwd: dir, ...options });
  await runGit(["config", "core.longpaths", "true"], { cwd: dir, ...options });
  await runGit(["remote", "add", "origin", url], { cwd: dir, ...options });
}

/** `git push [-u] origin <branch>`; pass setUpstream: false to skip -u. */
export async function pushBranch(cwd, branch, options = {}) {
  const { setUpstream = true, ...runOptions } = options;
  await runGit(
    [
      "push",
      "--no-verify",
      ...(setUpstream ? ["-u"] : []),
      "origin",
      `refs/heads/${branch}:refs/heads/${branch}`,
    ],
    { cwd, timeout: GIT_TIMEOUTS.push, ...runOptions },
  );
}

export function describeCloneFailure(err, { fullName, branch }) {
  if (err.timedOut) return `Cloning ${fullName} timed out.`;
  const text = `${err.stderr || ""}\n${err.message || ""}`;
  if (/Remote branch .* not found|couldn't find remote ref/i.test(text)) {
    return `Branch "${branch}" was not found in ${fullName}.`;
  }
  if (
    /Repository not found|could not read Username|terminal prompts disabled|Authentication failed|returned error: 40[13]|Permission denied/i.test(
      text,
    )
  ) {
    return `Couldn't clone ${fullName}: GitHub refused access. Check the repository URL and that your GitHub token can read it.`;
  }
  if (
    /Could not resolve host|Failed to connect|Connection timed out|Operation too slow|unable to access/i.test(
      text,
    )
  ) {
    return `Couldn't reach GitHub to clone ${fullName}: ${tailLines(err.stderr, 2) || err.message}`;
  }
  return `git clone failed: ${tailLines(err.stderr, 4) || err.message}`;
}

export function describePushFailure(err, { fullName, branch }) {
  if (err.timedOut) return `Pushing ${branch} to GitHub timed out.`;
  const text = `${err.stderr || ""}\n${err.message || ""}`;
  if (/workflow.{0,40}scope|create or update workflow/i.test(text)) {
    return 'GitHub refused the push because the change touches .github/workflows. That needs a token with the "workflow" scope (classic token) or "Workflows: Read and write" (fine-grained token).';
  }
  if (/GH006|protected branch/i.test(text)) {
    return `GitHub's branch protection rules rejected the push to ${branch}.`;
  }
  if (/GH013|push protection|repository rule violations/i.test(text)) {
    return `GitHub rejected the push (repository rules or secret scanning push protection): ${tailLines(err.stderr, 4)}`;
  }
  if (
    /non-fast-forward|fetch first|\[rejected\]|stale info|Updates were rejected/i.test(
      text,
    )
  ) {
    return `The branch ${branch} changed on GitHub while the job was running (non-fast-forward). Click Retry to run it again.`;
  }
  if (
    /Permission to .* denied|returned error: 403|403 Forbidden|denied to /i.test(
      text,
    )
  ) {
    return `Your GitHub token can't push to ${fullName}. It needs push access: the "repo" scope for a classic token, or "Contents: Read and write" for a fine-grained token.`;
  }
  if (
    /could not read Username|terminal prompts disabled|Authentication failed|returned error: 401|Invalid username or password/i.test(
      text,
    )
  ) {
    return "GitHub authentication failed while pushing — update your GitHub token in Settings.";
  }
  if (/Repository not found/i.test(text)) {
    return `Repository ${fullName} was not found while pushing, or your token can't access it.`;
  }
  if (/cannot lock ref|directory file conflict/i.test(text)) {
    return `GitHub couldn't create ${branch} because a branch with a conflicting name exists. Use a different branch name.`;
  }
  if (/pre-receive hook declined/i.test(text)) {
    return `GitHub's pre-receive hook declined the push: ${tailLines(err.stderr, 4)}`;
  }
  return `git push failed: ${tailLines(err.stderr, 4) || err.message}`;
}
