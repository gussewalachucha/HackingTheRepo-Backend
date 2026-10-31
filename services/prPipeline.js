// The PR pipeline: clone -> branch -> make-folder-txt -> Groq analyze ->
// Groq edit -> apply -> commit -> push -> pull request.
//
// runPipeline(jobId, mode, deps) never throws: any failure marks the job
// "failed" with a redacted message. Dependencies (GitHub client, LLM client,
// remote URL, workdir) are injectable for tests.
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Job from "../models/Job.js";
import User from "../models/User.js";
import { resolveCredentials } from "./credentials.js";
import * as git from "./git.js";
import { createGitHubClient, isRealPrUrl, parseRepoUrl } from "./github.js";
import { createGroqClient } from "./groq.js";
import { buildRepoContext } from "./repoContext.js";
import { checkFiles } from "./codeCheck.js";
import {
  applyChanges,
  normalizeChange,
  normalizeRepoPath,
  replayChanges,
  resolveSafePath,
} from "./applyChanges.js";
import { createRedactor, scrubSecrets } from "./redact.js";
import { appendJobLog } from "./jobLog.js";
import * as prompts from "./prompts.js";

export const JOB_MODES = ["create", "publish", "refine", "retry"];
const INTERNAL_FIELDS = "+changes +commitMessage +prBody +baseSha +lastMode";
const MAX_DIFF_CHARS = 200 * 1024;
const MAX_STORED_CHANGES_BYTES = 8 * 1024 * 1024;
const MAX_READ_BYTES = 512 * 1024;
const NO_CHANGES_MESSAGE =
  "The AI didn't change any files — try a more specific instruction.";

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** How hard gpt-oss models think on planning/writing steps (GROQ_REASONING_EFFORT). */
function reasoningEffort() {
  const value = (process.env.GROQ_REASONING_EFFORT || "high").toLowerCase();
  return ["low", "medium", "high"].includes(value) ? value : "high";
}

export class PipelineError extends Error {
  constructor(message) {
    super(message);
    this.name = "PipelineError";
  }
}

class JobGoneError extends Error {
  constructor() {
    super("The job was deleted");
    this.name = "JobGoneError";
  }
}

const BACKEND_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECT_DIR = path.dirname(BACKEND_DIR);
/** Where job clones live unless PR_WORKDIR says otherwise (gitignored, nodemon-ignored). */
export const DEFAULT_WORKDIR = path.join(BACKEND_DIR, "workspace");

function realpathOrSelf(target) {
  try {
    return realpathSync.native(target);
  } catch {
    return target;
  }
}

function slugPart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40);
}

/** Folder name of a job's clone: <owner>-<repo>-<last 6 characters of the job id>. */
export function workspaceName(job) {
  const suffix = String(job._id).slice(-6);
  let stem = "";
  try {
    const { owner, repo } = parseRepoUrl(job.repoUrl);
    stem = [slugPart(owner), slugPart(repo)].filter(Boolean).join("-");
  } catch {
    // unparseable URL: the job id alone still names the folder
  }
  return stem ? `${stem}-${suffix}` : `job-${suffix}`;
}

/**
 * The folder a job is cloned into: <PR_WORKDIR or backend/workspace>/<name>.
 * Each run of a job starts from a fresh clone in the same folder, and the
 * folder is kept afterwards for inspection unless PR_CLEANUP_WORKDIR=true.
 */
export function createWorkspace(job, rootOverride) {
  const base = path.resolve(rootOverride || process.env.PR_WORKDIR || DEFAULT_WORKDIR);
  // Windows paths can come in 8.3 short form (C:\Users\ABCDEF~1\...); tools
  // may print either form, so both are redacted.
  const realBase = path.join(realpathOrSelf(path.dirname(base)), path.basename(base));
  const name = workspaceName(job);
  const dir = path.join(base, name);
  const relative = path.relative(PROJECT_DIR, dir);
  const insideProject = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  return {
    base,
    dir,
    // How logs refer to the clone, e.g. "backend/workspace/acme-demo-1a2b3c".
    displayPath: insideProject ? relative.split(path.sep).join("/") : name,
    hooksDir: path.join(base, ".no-hooks"),
    redactions: [
      { value: dir, replacement: "<workdir>" },
      { value: path.join(realBase, name), replacement: "<workdir>" },
      { value: base, replacement: "<workdir-base>" },
      { value: realBase, replacement: "<workdir-base>" },
    ],
    async prepare({ keepClone = false } = {}) {
      await fs.mkdir(this.hooksDir, { recursive: true });
      // A previous run of this job left its clone here: start fresh, unless
      // the caller is about to reuse it.
      if (!keepClone) {
        await fs.rm(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
    async cleanup({ force = false } = {}) {
      if (!force && process.env.PR_CLEANUP_WORKDIR !== "true") return;
      try {
        await fs.rm(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (err) {
        console.warn(`[jobs] Could not remove a job workdir: ${scrubSecrets(err.message)}`);
      }
    },
  };
}

/** Delete a job's clone folder (used when the job itself is deleted). */
export async function removeJobWorkspace(job) {
  await createWorkspace(job).cleanup({ force: true });
}

export function truncateDiff(diff) {
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  const cut = diff.lastIndexOf("\n", MAX_DIFF_CHARS);
  const kept = diff.slice(0, cut > 0 ? cut + 1 : MAX_DIFF_CHARS);
  const more = Math.ceil((diff.length - kept.length) / 1024);
  return `${kept}\n... [diff truncated: ${more} KB more not shown]\n`;
}

function hasStoredChanges(job) {
  return Array.isArray(job.changes) && job.changes.length > 0;
}

/** Which flow a "retry" re-runs: the step that failed (see README). */
export function resolveRetryMode(job) {
  if (job.prUrl) return "refine";
  if (job.lastMode === "publish" && hasStoredChanges(job)) return "publish";
  if (job.lastMode === "refine") return "refine";
  return "create";
}

function pendingRefinements(job) {
  return (job.refinements || []).filter((refinement) => !refinement.applied);
}

function firstLine(text) {
  return String(text || "").split("\n")[0].slice(0, 120);
}

function sanitizeIdentity(value) {
  return String(value || "")
    // eslint-disable-next-line no-control-regex
    .replace(/[<>\n\r\t\u0000]/g, "")
    .trim()
    .slice(0, 100);
}

function mergeChanges(previous, next) {
  const merged = new Map();
  for (const change of Array.isArray(previous) ? previous : []) merged.set(change.path, change);
  for (const change of next) merged.set(change.path, change);
  return [...merged.values()];
}

/** Map AI-requested paths onto files that exist (prefix/suffix tolerant). */
export function resolveRequestedFiles(requested, known, repoName) {
  const found = [];
  const missing = [];
  const knownList = [...known];
  for (const raw of requested) {
    let rel;
    try {
      rel = normalizeRepoPath(raw);
    } catch {
      continue;
    }
    if (known.has(rel)) {
      found.push(rel);
      continue;
    }
    if (repoName && rel.startsWith(`${repoName}/`) && known.has(rel.slice(repoName.length + 1))) {
      found.push(rel.slice(repoName.length + 1));
      continue;
    }
    const matches = knownList.filter((file) => file.endsWith(`/${rel}`));
    if (matches.length === 1) found.push(matches[0]);
    else missing.push(rel);
  }
  return { found: [...new Set(found)].slice(0, 15), missing: [...new Set(missing)].slice(0, 15) };
}

class JobRun {
  constructor({ job, credentials, workspace, redact, signal, deps, requestedMode }) {
    this.job = job;
    this.id = job._id;
    this.credentials = credentials;
    this.workspace = workspace;
    this.redact = redact;
    this.signal = signal;
    this.requestedMode = requestedMode;
    this.makeGitHubClient = deps.createGitHubClient || createGitHubClient;
    this.makeLlmClient = deps.createLlmClient || ((options) => createGroqClient(options));
    this.remoteUrl = deps.remoteUrl;
    this.includedRefinementIds = [];
    this.step = "queue";
  }

  log(step, message, level = "info") {
    return appendJobLog(this.id, step, message, level, this.redact);
  }

  async set(fields) {
    await Job.updateOne({ _id: this.id }, { $set: fields });
    for (const [key, value] of Object.entries(fields)) this.job[key] = value;
  }

  gitOptions(extra = {}) {
    return { cwd: this.cwd, env: this.env, signal: this.signal, ...extra };
  }

  async ensureStillExists() {
    if (!(await Job.exists({ _id: this.id }))) throw new JobGoneError();
  }

  async execute() {
    let mode = this.requestedMode;
    if (mode === "retry") mode = resolveRetryMode(this.job);
    if (!JOB_MODES.includes(mode) || mode === "retry") {
      throw new PipelineError(`Unknown job mode "${this.requestedMode}"`);
    }
    if (mode === "refine" && !pendingRefinements(this.job).length && !this.job.prUrl && !hasStoredChanges(this.job)) {
      mode = "create";
    }
    this.mode = mode;

    await this.set({
      status: "running",
      startedAt: new Date(),
      finishedAt: null,
      errorMessage: null,
      lastMode: mode,
    });
    const labels = {
      create: "Starting: clone, analyze, edit, commit" + (this.job.previewBeforePush ? " (preview — nothing is pushed yet)" : ", push and open a PR"),
      publish: "Publishing the previewed changes: push the branch and open a PR",
      refine: "Starting a refinement pass",
    };
    await this.log("queue", this.requestedMode === "retry" ? `Retrying (${mode})` : labels[mode]);

    if (!this.credentials.githubToken) {
      throw new PipelineError(
        "No GitHub token available — save one in Settings (or set REPOMIND_GITHUB_TOKEN on the server).",
      );
    }
    if (mode !== "publish" && !this.credentials.groqKey) {
      throw new PipelineError(
        "No Groq API key found. Add your key in Settings → Groq API keys (or set GROQ_API_KEY in backend/.env).",
      );
    }

    if (mode === "refine" && !pendingRefinements(this.job).length) {
      await this.complete({}, "Nothing new to apply — the job is already up to date");
      return;
    }

    if (this.requestedMode === "retry" && mode !== "refine" && (await this.resumeOpenPullRequest())) {
      return;
    }

    if (mode === "create") return this.runCreate();
    if (mode === "publish") return this.runPublish();
    return this.job.prUrl ? this.runRefinePullRequest() : this.runRefineFromBase();
  }

  // ── building blocks ──────────────────────────────────────────────────────

  async prepareRepo() {
    if (this.repo) return this.repo;
    this.step = "clone";
    let parsed;
    try {
      parsed = parseRepoUrl(this.job.repoUrl);
    } catch (err) {
      throw new PipelineError(err.message);
    }
    this.gh = this.makeGitHubClient(this.credentials.githubToken);
    await this.log("clone", `Checking access to ${parsed.fullName} on GitHub…`);
    const info = await this.gh.getRepo(parsed.owner, parsed.repo, { signal: this.signal });
    if (info.archived) {
      throw new PipelineError(`${info.fullName} is archived on GitHub, so nothing can be pushed to it.`);
    }
    if (info.canPush === false) {
      throw new PipelineError(
        `Your GitHub account doesn't have push access to ${info.fullName}. Fork the repository on GitHub and create the job with your fork's URL, or ask the owner for write access.`,
      );
    }
    const override = typeof this.remoteUrl === "function" ? this.remoteUrl(info) : this.remoteUrl;
    this.repo = {
      ...info,
      owner: info.owner || parsed.owner,
      name: info.name || parsed.repo,
      fullName: info.fullName || parsed.fullName,
      cloneUrl: override || `https://github.com/${info.fullName || parsed.fullName}.git`,
    };
    return this.repo;
  }

  async prepareGit({ keepClone = false } = {}) {
    await this.workspace.prepare({ keepClone });
    this.env = git.buildGitEnv({
      token: this.credentials.githubToken,
      hooksPath: this.workspace.hooksDir,
    });
  }

  /**
   * Updates continue in the clone the previous run of this job left behind,
   * instead of downloading the repository again. The clone is reused only if
   * it is exactly where that run left it (same branch, same last commit, same
   * repository, and for a PR the branch on GitHub hasn't moved); otherwise
   * the caller clones fresh. Returns the reused HEAD commit, or null.
   */
  async reuseClone(branch) {
    const { job } = this;
    if (!job.commitSha || job.branchName !== branch) return null;
    const dir = this.workspace.dir;
    try {
      await fs.access(path.join(dir, ".git"));
    } catch {
      return null;
    }
    await this.prepareGit({ keepClone: true });
    const options = { cwd: dir, env: this.env, signal: this.signal };
    let reason = null;
    let head = null;
    try {
      const current = (await git.runGit(["rev-parse", "--abbrev-ref", "HEAD"], options)).stdout.trim();
      head = await git.headSha(dir, options);
      const origin = (await git.runGit(["remote", "get-url", "origin"], options)).stdout.trim();
      if (current !== branch) {
        reason = `it is on ${current}, not ${branch}`;
      } else if (head !== job.commitSha) {
        reason = "it doesn't match this job's last commit";
      } else if (origin !== this.repo.cloneUrl) {
        reason = "it points at a different repository";
      } else if (job.prUrl) {
        const remote = await git.remoteBranchSha(dir, "origin", branch, {
          ...options,
          timeout: git.GIT_TIMEOUTS.network,
        });
        if (remote !== head) {
          reason = remote
            ? `${branch} was changed on GitHub since the last update`
            : `${branch} no longer exists on GitHub`;
        }
      }
    } catch (err) {
      if (err.aborted) throw err;
      reason = "it couldn't be read";
    }
    if (reason) {
      await this.log("clone", `Not reusing the existing copy (${reason}) — cloning again`, "warn");
      return null;
    }
    this.cwd = dir;
    // An interrupted attempt may have left uncommitted edits behind.
    if ((await git.statusPorcelain(dir, this.gitOptions())).trim()) {
      await git.runGit(["reset", "--hard", "HEAD"], options);
      await git.runGit(["clean", "-fd"], options);
      await this.log("clone", "Discarded unfinished changes left by an interrupted attempt");
    }
    await this.log(
      "clone",
      `Reusing the copy already in ${this.workspace.displayPath} — no need to clone again (${branch} at ${head.slice(0, 7)})`,
    );
    await this.log("branch", `Continuing on branch ${branch}`);
    return head;
  }

  /**
   * Retry after "pushed, but opening the PR failed": when the remote branch
   * still points at the commit this job pushed, only the PR step is redone.
   */
  async resumeOpenPullRequest() {
    const { job } = this;
    if (!job.commitSha || job.prUrl || !job.branchName) return false;
    const repo = await this.prepareRepo();
    await this.prepareGit();
    let sha;
    try {
      sha = await git.remoteBranchSha(this.workspace.base, repo.cloneUrl, job.branchName, {
        env: this.env,
        signal: this.signal,
      });
    } catch (err) {
      if (err.aborted) throw err;
      return false;
    }
    if (sha !== job.commitSha) return false;
    this.baseBranch = job.baseBranch || repo.defaultBranch;
    await this.log("push", `${job.branchName} is already on GitHub at ${sha.slice(0, 7)} — opening the pull request`);
    const url = await this.openPullRequest({
      branch: job.branchName,
      base: this.baseBranch,
      body: job.prBody || prompts.buildPrBody("", "", job),
    });
    await this.complete({}, `Done — pull request: ${url}`);
    return true;
  }

  /**
   * Clone `branch` into the job's folder and return its tip commit. With
   * `allowEmpty`, a repository that has no commits at all is started locally
   * instead (see initEmptyRepository).
   */
  async clone(branch, { missingBranchMessage, allowEmpty = false } = {}) {
    await this.prepareGit();
    await this.log(
      "clone",
      `Cloning ${this.repo.fullName} (${branch}, shallow) into ${this.workspace.displayPath}…`,
    );
    try {
      await git.cloneRepo({
        url: this.repo.cloneUrl,
        branch,
        dir: this.workspace.dir,
        cwd: this.workspace.base,
        env: this.env,
        signal: this.signal,
      });
    } catch (err) {
      if (err.aborted) throw err;
      const message = git.describeCloneFailure(err, { fullName: this.repo.fullName, branch });
      const branchMissing = /was not found in/.test(message);
      if (branchMissing && allowEmpty && (await this.remoteIsEmpty())) {
        return this.initEmptyRepository(branch);
      }
      if (missingBranchMessage && branchMissing) {
        throw new PipelineError(missingBranchMessage);
      }
      throw new PipelineError(message);
    }
    this.cwd = this.workspace.dir;
    const sha = await git.headSha(this.cwd, this.gitOptions());
    await this.log("clone", `Cloned ${branch} at ${sha.slice(0, 7)}`);
    return sha;
  }

  /** True when the remote has no branches at all (a brand-new, empty repo). */
  async remoteIsEmpty() {
    try {
      const heads = await git.listRemoteHeads(this.workspace.base, this.repo.cloneUrl, {
        env: this.env,
        signal: this.signal,
      });
      return heads.length === 0;
    } catch (err) {
      if (err.aborted) throw err;
      return false;
    }
  }

  /**
   * GitHub reports a default branch (e.g. "main") even for a repository with
   * no commits, but a pull request needs that branch to exist. Start the
   * repository locally with an empty initial commit on `branch`; push() sends
   * it to GitHub just before the job's own branch.
   */
  async initEmptyRepository(branch) {
    await this.log(
      "clone",
      `${this.repo.fullName} is empty (no commits yet) — starting it in ${this.workspace.displayPath} with an empty initial commit on ${branch}`,
      "warn",
    );
    await fs.rm(this.workspace.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    try {
      await git.initRepo({
        dir: this.workspace.dir,
        branch,
        url: this.repo.cloneUrl,
        cwd: this.workspace.base,
        env: this.env,
        signal: this.signal,
      });
    } catch (err) {
      if (err.aborted) throw err;
      throw new PipelineError(
        `Couldn't start a local repository for the empty ${this.repo.fullName}: ${err.message}`,
      );
    }
    this.cwd = this.workspace.dir;
    const { name, email } = await this.identity();
    await git.commit(
      this.cwd,
      { message: "Initial commit", name, email, allowEmpty: true },
      this.gitOptions(),
    );
    const sha = await git.headSha(this.cwd, this.gitOptions());
    this.emptyRepository = true;
    this.unpublishedBase = branch;
    await this.log(
      "clone",
      `Created the initial commit ${sha.slice(0, 7)} on ${branch}; it goes to GitHub together with your branch, so the pull request has a base to target`,
    );
    return sha;
  }

  /** Validate the branch and pick a name that doesn't exist on GitHub yet. */
  async chooseBranch(desired) {
    try {
      await git.checkBranchName(desired, this.gitOptions());
    } catch (err) {
      if (err.aborted) throw err;
      throw new PipelineError(
        `Invalid branch name "${desired}" — use letters, numbers, ".", "_", "-" and "/".`,
      );
    }
    const suffix = String(this.id).slice(-6);
    const stem = desired.endsWith(`-${suffix}`) ? desired.slice(0, -(suffix.length + 1)) : desired;
    const candidates = [
      ...new Set([desired, `${stem}-${suffix}`, ...[2, 3, 4, 5].map((n) => `${stem}-${suffix}-${n}`)]),
    ];
    for (const candidate of candidates) {
      let exists;
      try {
        exists = await git.remoteBranchExists(this.cwd, candidate, this.gitOptions());
      } catch (err) {
        if (err.aborted) throw err;
        throw new PipelineError(
          `Couldn't check whether ${candidate} exists on GitHub: ${git.tailLines(err.stderr, 2) || err.message}`,
        );
      }
      if (!exists) {
        if (candidate !== desired) {
          await this.log("branch", `Branch ${desired} already exists on GitHub — using ${candidate} instead`, "warn");
          await this.set({ branchName: candidate });
        }
        return candidate;
      }
    }
    throw new PipelineError(
      `Branch ${desired} (and the suffixed alternatives) already exist on GitHub — choose a different branch name.`,
    );
  }

  async checkout(branch) {
    await git.checkoutNewBranch(this.cwd, branch, this.gitOptions());
    await this.log("branch", `Created branch ${branch} from ${this.baseBranch} (git checkout -b ${branch})`);
  }

  async readRepoFile(rel) {
    try {
      const { abs } = await resolveSafePath(this.cwd, rel);
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > MAX_READ_BYTES) return null;
      const buffer = await fs.readFile(abs);
      if (buffer.includes(0)) return null;
      return buffer.toString("utf8");
    } catch {
      return null;
    }
  }

  async replay(stored, label) {
    this.step = "apply";
    await this.log("apply", `${label} (${stored.length} file change(s))…`);
    try {
      await replayChanges(this.cwd, stored);
    } catch (err) {
      throw new PipelineError(`Couldn't re-apply the stored changes: ${err.message}`);
    }
  }

  /** make-folder-txt + analyze + edit + apply (+ one repair round). */
  async generateChanges(request) {
    this.step = "structure";
    await this.log("structure", "Reading the folder structure (make-folder-txt --folder-structure)…");
    const listFiles = () => git.listFiles(this.cwd, this.gitOptions());
    const context = await buildRepoContext(this.cwd, { signal: this.signal, listPaths: listFiles });
    if (context.error) {
      await this.log("structure", `make-folder-txt failed (${context.error}) — using git ls-files instead`, "warn");
    }
    const allFiles = await listFiles();
    await this.log(
      "structure",
      `Mapped ${allFiles.length} files with ${context.source} (${context.files.size} readable text files${context.skipped.size ? `, ${context.skipped.size} binary/large skipped` : ""})`,
    );

    const llm = this.makeLlmClient({
      apiKey: this.credentials.groqKey,
      apiKeys: this.credentials.groqKeys,
      log: (level, message) => this.log(this.step, message, level),
    });
    const budget = prompts.getBudgets();
    const promptContext = {
      repoFullName: this.repo.fullName,
      baseBranch: this.baseBranch,
      emptyRepository: !!this.emptyRepository && allFiles.length === 0,
      request,
      structure: context.structure,
      files: context.files,
      skippedCount: context.skipped.size,
    };

    // Call 1: analyze
    this.step = "analyze";
    await this.log("analyze", `Analyzing the repository with ${llm.model || "Groq"}…`);
    const analysis = prompts.normalizeAnalysis(
      await llm.completeJson({
        step: "analyze",
        buildMessages: (b) => prompts.buildAnalyzeMessages(promptContext, b),
        budget,
        validate: prompts.validateAnalysis,
        signal: this.signal,
        reasoningEffort: reasoningEffort(),
      }),
    );
    if (analysis.designBrief) {
      await this.log("analyze", `Design system: ${analysis.designBrief}`.slice(0, 1200));
    }
    const planText = analysis.plan.length
      ? ` Plan: ${analysis.plan.map((step, i) => `${i + 1}) ${step}`).join(" ")}`
      : "";
    await this.log("analyze", `${analysis.analysis || "Analysis done."}${planText}`.slice(0, 1500));

    // Call 2: edit
    const known = new Set([...allFiles, ...context.files.keys()]);
    const { found, missing } = resolveRequestedFiles(analysis.filesToRead, known, this.repo.name);
    const entries = [];
    for (const rel of found) {
      const content = context.files.has(rel) ? context.files.get(rel) : await this.readRepoFile(rel);
      if (typeof content === "string") entries.push({ rel, content });
    }
    if (prompts.dumpSize(context.files) <= budget.contextChars) {
      for (const [rel, content] of context.files) {
        if (!found.includes(rel)) entries.push({ rel, content });
      }
    }
    this.step = "edit";
    const editMeta = {};
    let edit;
    if (analysis.filesToChange.length && process.env.PR_EDIT_MODE !== "single") {
      edit = await this.writeFilesOneByOne(llm, promptContext, analysis, entries, budget, editMeta);
    } else {
      await this.log("edit", `Generating changes (${found.length} requested file(s) in context)…`);
      edit = prompts.normalizeEdit(
        await llm.completeJson({
          step: "edit",
          buildMessages: (b) =>
            prompts.buildEditMessages(promptContext, analysis, { entries, missing }, b, editMeta),
          budget,
          validate: prompts.validateEdit,
          signal: this.signal,
        }),
      );
    }
    if (!edit.changes.length) throw new PipelineError(NO_CHANGES_MESSAGE);
    await this.log(
      "edit",
      `The AI proposed ${edit.changes.length} change(s)${edit.summary ? ` — ${edit.summary}` : ""}`.slice(0, 1500),
    );

    // Apply
    this.step = "apply";
    const first = await applyChanges(this.cwd, edit.changes, {
      truncatedPaths: editMeta.truncated || new Set(),
    });
    await this.logResults(first.results);
    let results = first.results;
    if (first.failedEdits.length) {
      const repaired = await this.repairEdits(llm, promptContext, first.failedEdits, budget);
      results = results.concat(repaired);
    }
    const appliedPaths = new Set(results.filter((r) => r.ok).map((r) => r.path));
    if (!appliedPaths.size) {
      const reasons = results
        .filter((r) => !r.ok)
        .slice(0, 3)
        .map((r) => `${r.path}: ${r.error}`)
        .join("; ");
      throw new PipelineError(`None of the AI's changes could be applied (${reasons || "no valid changes"}).`);
    }
    // Check every file this job has touched so far (earlier updates included).
    const touched = new Set(appliedPaths);
    for (const change of Array.isArray(this.job.changes) ? this.job.changes : []) {
      if (change.action !== "delete") touched.add(change.path);
    }
    await this.checkAndFix(llm, promptContext, budget, [...touched]);
    return edit;
  }

  /**
   * Write the files the analysis picked one at a time: each file gets its own
   * Groq call (and full output budget) with its current content, the plan,
   * the files already written in this change and other relevant files.
   * Returns an edit object like the single-call path.
   */
  async writeFilesOneByOne(llm, promptContext, analysis, entries, budget, editMeta) {
    const targets = [];
    for (const target of analysis.filesToChange) {
      try {
        targets.push({ ...target, path: normalizeRepoPath(target.path) });
      } catch {
        await this.log("edit", `Skipped ${target.path}: not a safe path inside the repository`, "warn");
      }
    }
    const total = targets.length;
    await this.log(
      "edit",
      `The AI picked ${total} file(s) to work on: ${targets.map((t) => `${t.action} ${t.path}`).join(", ")}`.slice(0, 1500),
    );
    const changes = [];
    const written = [];
    editMeta.truncated = new Set();
    for (const [index, target] of targets.entries()) {
      if (target.action === "delete") {
        changes.push({ path: target.path, action: "delete" });
        await this.log("edit", `(${index + 1}/${total}) Will delete ${target.path}`);
        continue;
      }
      const current = await this.readRepoFile(target.path);
      await this.log("edit", `(${index + 1}/${total}) Writing ${target.path} — ${target.purpose}`.slice(0, 600));
      const reply = await this.writeOneFile(llm, promptContext, analysis, target, budget, {
        current,
        written,
        context: entries.filter((e) => e.rel !== target.path && !written.some((w) => w.rel === e.rel)),
      });
      if (!reply) continue;
      if (typeof reply.content === "string") {
        changes.push({
          path: target.path,
          action: current === null ? "create" : "replace",
          content: reply.content,
        });
        written.push({ rel: target.path, content: reply.content });
      } else {
        changes.push({ path: target.path, action: "edit", edits: reply.edits });
      }
    }
    if (!changes.length) throw new PipelineError("The AI couldn't write any of the files — click Retry.");

    // Review pass: a senior reviewer looks at the written files together and
    // the files with real problems are rewritten with that feedback.
    const limit = llm.tokenLimit?.();
    if (written.length && limit && limit < 20000 && process.env.PR_REVIEW_PASS !== "true") {
      await this.log(
        "edit",
        `Skipped the extra review pass: your Groq plan allows only ${limit} tokens per minute, so it would add several minutes of waiting (a paid Groq plan enables it)`,
      );
    } else if (written.length && process.env.PR_REVIEW_PASS !== "false") {
      await this.reviewAndImprove(llm, promptContext, analysis, targets, entries, written, changes, budget);
    }
    await this.styleUnstyledClasses(llm, promptContext, analysis, written, changes, budget);
    const summary = analysis.plan.length ? analysis.plan.join("; ") : analysis.analysis;
    return {
      summary: `Updated ${changes.length} file(s): ${summary}`.slice(0, 600),
      commitMessage: analysis.commitMessage,
      prBody: [
        analysis.analysis,
        analysis.plan.length ? `### Plan\n${analysis.plan.map((step, i) => `${i + 1}. ${step}`).join("\n")}` : "",
        `### Files\n${targets.map((t) => `- \`${t.path}\` (${t.action}): ${t.purpose}`).join("\n")}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      changes,
    };
  }

  /**
   * One Groq call that writes (or rewrites, with `files.issues`) one file.
   * Returns { content } or { edits }, or null when it couldn't be written.
   */
  async writeOneFile(llm, promptContext, analysis, target, budget, files) {
    const meta = {};
    let reply;
    try {
      reply = await llm.completeJson({
        step: "file",
        buildMessages: (b) => prompts.buildFileMessages(promptContext, analysis, target, files, b, meta),
        budget,
        // meta.truncated is set by the latest buildMessages call (the budget
        // may shrink between rounds), so check it at validation time.
        validate: (value) => prompts.validateFile(value, { truncated: meta.truncated }),
        signal: this.signal,
        maxTokens: envInt("GROQ_FILE_MAX_TOKENS", 16384),
        reasoningEffort: reasoningEffort(),
        temperature: 0.3,
      });
    } catch (err) {
      if (this.signal.aborted) throw err;
      await this.log("edit", `Couldn't write ${target.path}: ${err.message}`, "warn");
      return null;
    }
    if (typeof reply.content === "string" && meta.truncated) {
      await this.log("edit", `Ignored a full rewrite of the large file ${target.path} (only part of it was shown to the AI)`, "warn");
      return null;
    }
    return reply;
  }

  /**
   * Consistency check without guessing: every class the new HTML uses (or the
   * JS toggles) should have CSS. Missing ones get one small Groq call that
   * writes only those rules, appended to the stylesheet.
   */
  async styleUnstyledClasses(llm, promptContext, analysis, written, changes, budget) {
    const html = written.filter((w) => /\.html?$/i.test(w.rel));
    const stylesheet = written.find((w) => /\.css$/i.test(w.rel));
    if (!html.length || !stylesheet) return;
    const js = written.filter((w) => /\.m?js$/i.test(w.rel)).map((w) => w.content).join("\n");
    const allHtml = html.map((w) => w.content).join("\n");
    const styled = prompts.styledClasses(written.filter((w) => /\.css$/i.test(w.rel)).map((w) => w.content).join("\n"));
    const missing = [...prompts.usedClasses(allHtml, js)].filter((name) => !styled.has(name));
    if (!missing.length) {
      await this.log("edit", "Consistency check passed: every class used in the HTML has styles");
      return;
    }
    await this.log(
      "edit",
      `${missing.length} class(es) have no styles yet (${missing.slice(0, 20).join(", ")}) — asking the AI to style them in ${stylesheet.rel}`.slice(0, 900),
      "warn",
    );
    let reply;
    try {
      reply = await llm.completeJson({
        step: "styles",
        buildMessages: (b) =>
          prompts.buildCssAdditionsMessages(promptContext, analysis, { missing, html: allHtml, css: stylesheet.content }, b),
        budget,
        validate: prompts.validateCssAdditions,
        signal: this.signal,
        reasoningEffort: reasoningEffort(),
      });
    } catch (err) {
      if (this.signal.aborted) throw err;
      await this.log("edit", `Couldn't add the missing styles: ${err.message}`, "warn");
      return;
    }
    const content = `${stylesheet.content.replace(/\s*$/, "")}\n\n/* Styles for elements that had none */\n${reply.css.trim()}\n`;
    stylesheet.content = content;
    const change = changes.find((c) => c.path === stylesheet.rel);
    if (change) change.content = content;
    const still = missing.filter((name) => !prompts.styledClasses(reply.css).has(name));
    await this.log(
      "edit",
      still.length
        ? `Added styles for ${missing.length - still.length} of ${missing.length} class(es) (still unstyled: ${still.join(", ")})`
        : `Added styles for all ${missing.length} class(es)`,
    );
  }

  async reviewAndImprove(llm, promptContext, analysis, targets, entries, written, changes, budget) {
    await this.log("edit", `Reviewing the ${written.length} written file(s) like a senior engineer…`);
    let review;
    try {
      review = await llm.completeJson({
        step: "review",
        buildMessages: (b) => prompts.buildReviewMessages(promptContext, analysis, written, b),
        budget,
        validate: prompts.validateReview,
        signal: this.signal,
        reasoningEffort: reasoningEffort(),
      });
    } catch (err) {
      if (this.signal.aborted) throw err;
      await this.log("edit", `The review pass failed (${err.message}) — keeping the first version`, "warn");
      return;
    }
    const byPath = new Map();
    for (const issue of review.issues) {
      if (!written.some((w) => w.rel === issue.path)) continue;
      if (!byPath.has(issue.path)) byPath.set(issue.path, []);
      if (byPath.get(issue.path).length < 4) byPath.get(issue.path).push(issue);
    }
    if (!byPath.size) {
      await this.log("edit", "Review passed: no problems found");
      return;
    }
    await this.log(
      "edit",
      `Review found ${[...byPath.values()].flat().length} thing(s) to improve: ${[...byPath.entries()]
        .map(([rel, issues]) => `${rel}: ${issues.map((i) => i.problem).join("; ")}`)
        .join(" | ")}`.slice(0, 1500),
      "warn",
    );
    for (const [rel, issues] of byPath) {
      const target = targets.find((t) => t.path === rel);
      const previous = written.find((w) => w.rel === rel);
      if (!target || !previous) continue;
      await this.log("edit", `Improving ${rel} (${issues.length} fix(es))…`);
      const reply = await this.writeOneFile(llm, promptContext, analysis, target, budget, {
        current: previous.content,
        written: written.filter((w) => w.rel !== rel),
        context: entries.filter((e) => e.rel !== rel && !written.some((w) => w.rel === e.rel)),
        issues,
      });
      if (typeof reply?.content !== "string") continue;
      previous.content = reply.content;
      const change = changes.find((c) => c.path === rel);
      if (change) change.content = reply.content;
    }
    await this.log("edit", "Applied the review fixes");
  }

  /**
   * Quality gate before committing: syntax-check the changed files and give
   * the AI one round to fix what fails. Never fails the job by itself.
   */
  async checkAndFix(llm, promptContext, budget, paths) {
    this.step = "apply";
    await this.log("apply", "Checking the changed files for errors (node --check, JSON)…");
    let problems = await checkFiles(this.cwd, paths, { signal: this.signal });
    if (!problems.length) {
      await this.log("apply", "Check passed: no syntax errors found");
      return;
    }
    const describe = (list) =>
      list.map((p) => `${p.path}: ${p.error.split("\n").find((line) => /Error|Invalid/.test(line)) || p.error.split("\n")[0]}`).join("; ");
    await this.log("apply", `Found ${problems.length} problem(s) — asking the AI to fix them: ${describe(problems)}`.slice(0, 1500), "warn");

    this.step = "edit";
    const meta = {};
    let reply;
    try {
      reply = await llm.completeJson({
        step: "fix",
        buildMessages: (b) =>
          prompts.buildFixMessages(
            promptContext,
            problems.map((p) => ({ rel: p.path, error: p.error, content: p.content })),
            b,
            meta,
          ),
        budget,
        validate: prompts.validateRepair,
        signal: this.signal,
      });
    } catch (err) {
      if (this.signal.aborted) throw err;
      await this.log("edit", `The fix round failed: ${err.message}`, "warn");
      return;
    }
    const allowed = new Set(meta.included || problems.map((p) => p.path));
    const changes = [];
    for (const raw of prompts.normalizeEdit(reply).changes) {
      const change = normalizeChange(raw);
      let rel;
      try {
        rel = normalizeRepoPath(change.path);
      } catch {
        continue;
      }
      if (!allowed.has(rel) || typeof change.content !== "string") continue;
      changes.push({ path: rel, action: "replace", content: change.content });
    }
    this.step = "apply";
    const outcome = await applyChanges(this.cwd, changes);
    await this.logResults(outcome.results);

    problems = await checkFiles(this.cwd, paths, { signal: this.signal });
    if (problems.length) {
      await this.log("apply", `Still not fixed automatically: ${describe(problems)}`.slice(0, 1500), "warn");
    } else {
      await this.log("apply", "Fixed — all checks pass now");
    }
  }

  async logResults(results) {
    const ok = results.filter((r) => r.ok);
    if (ok.length) {
      const list = ok.map((r) => `${r.action} ${r.path}`).join(", ");
      await this.log("apply", `Applied ${ok.length} change(s): ${list}`.slice(0, 1500));
    }
    for (const failure of results.filter((r) => !r.ok).slice(0, 10)) {
      await this.log("apply", `Skipped ${failure.path}: ${failure.error}`, "warn");
    }
  }

  async repairEdits(llm, promptContext, failedEdits, budget) {
    this.step = "edit";
    const byPath = new Map();
    for (const failure of failedEdits) {
      const entry = byPath.get(failure.path) || { rel: failure.path, edits: [], error: failure.error };
      if (Array.isArray(failure.edits)) entry.edits.push(...failure.edits);
      byPath.set(failure.path, entry);
    }
    const failures = [];
    for (const entry of byPath.values()) {
      failures.push({ ...entry, content: await this.readRepoFile(entry.rel) });
    }
    await this.log(
      "edit",
      `${failures.length} file(s) had edits that didn't match the current code (${failures
        .map((f) => `${f.rel}: ${f.error}`)
        .join("; ")}) — asking the AI to fix them`.slice(0, 1500),
      "warn",
    );
    const meta = {};
    let reply;
    try {
      reply = await llm.completeJson({
        step: "repair",
        buildMessages: (b) => prompts.buildRepairMessages(promptContext, failures, b, meta),
        budget,
        validate: prompts.validateRepair,
        signal: this.signal,
        maxTokens: envInt("GROQ_FILE_MAX_TOKENS", 16384),
      });
    } catch (err) {
      if (this.signal.aborted) throw err;
      await this.log("edit", `Repair round failed: ${err.message}`, "warn");
      return [];
    }
    const allowed = new Set(meta.included || byPath.keys());
    const excerpted = meta.excerpted || new Set();
    const skippedPaths = [...byPath.keys()].filter((rel) => !allowed.has(rel));
    if (skippedPaths.length) {
      await this.log("edit", `Too large to repair in one round: ${skippedPaths.join(", ")}`, "warn");
    }
    const changes = [];
    for (const raw of prompts.normalizeEdit(reply).changes) {
      const change = normalizeChange(raw);
      let rel;
      try {
        rel = normalizeRepoPath(change.path);
      } catch {
        continue;
      }
      if (!allowed.has(rel)) continue;
      if (Array.isArray(change.edits) && change.edits.length) {
        changes.push({ path: rel, action: "edit", edits: change.edits });
      } else if (typeof change.content === "string" && !excerpted.has(rel)) {
        changes.push({ path: rel, action: "replace", content: change.content });
      }
    }
    if (!changes.length) {
      await this.log("edit", "The AI's repair reply had no usable changes", "warn");
      return [];
    }
    this.step = "apply";
    const outcome = await applyChanges(this.cwd, changes, { truncatedPaths: excerpted });
    await this.logResults(outcome.results);
    return outcome.results;
  }

  /** git add -A, refuse an empty change, collect diff/stat/final file states. */
  async snapshot(emptyMessage = NO_CHANGES_MESSAGE) {
    this.step = "commit";
    await git.addAll(this.cwd, this.gitOptions());
    const status = await git.statusPorcelain(this.cwd, this.gitOptions());
    if (!status.trim()) throw new PipelineError(emptyMessage);
    const rawDiff = await git.diffCached(this.cwd, this.gitOptions());
    const diff = rawDiff === null ? "(diff too large to display)" : truncateDiff(rawDiff);
    const stat = await git.diffStat(this.cwd, this.gitOptions());
    const changes = [];
    for (const { status: code, path: rel } of await git.stagedChanges(this.cwd, this.gitOptions())) {
      if (code === "D") {
        changes.push({ path: rel, action: "delete" });
        continue;
      }
      const { abs } = await resolveSafePath(this.cwd, rel);
      changes.push({ path: rel, action: "write", content: await fs.readFile(abs, "utf8") });
    }
    return { diff, stat, changes };
  }

  /** Full diff of the branch against the local base branch, or null if unavailable. */
  async diffAgainstBase() {
    try {
      const { stdout } = await git.runGit(
        ["diff", "--no-color", "--no-ext-diff", "-M", `refs/heads/${this.baseBranch}`, "HEAD"],
        { ...this.gitOptions(), maxBuffer: 64 * 1024 * 1024 },
      );
      return truncateDiff(stdout);
    } catch (err) {
      if (err.aborted) throw err;
      return null;
    }
  }

  async storable(changes, { required }) {
    const bytes = changes.reduce(
      (sum, change) => sum + change.path.length + (change.content ? Buffer.byteLength(change.content) : 0),
      0,
    );
    if (bytes <= MAX_STORED_CHANGES_BYTES) return changes;
    const size = (bytes / (1024 * 1024)).toFixed(1);
    if (required) {
      throw new PipelineError(
        `The changes are too large to keep as a preview (${size} MB). Turn off "preview before push" to push them directly.`,
      );
    }
    await this.log("commit", `The changes (${size} MB) are too large to store with the job; they live on the pushed branch only`, "warn");
    return null;
  }

  async identity() {
    try {
      const user = await this.gh.getUser({ signal: this.signal });
      const login = sanitizeIdentity(user?.login);
      if (login && user?.id !== undefined && user?.id !== null) {
        return {
          name: sanitizeIdentity(user.name) || login,
          email: `${user.id}+${login}@users.noreply.github.com`,
        };
      }
    } catch (err) {
      if (this.signal.aborted) throw err;
      await this.log("commit", `Couldn't read the GitHub user (${err.message}); committing as RepoMind`, "warn");
    }
    return { name: "RepoMind", email: "repomind@users.noreply.github.com" };
  }

  async commitChanges(message) {
    this.step = "commit";
    const { name, email } = await this.identity();
    await git.commit(this.cwd, { message, name, email }, this.gitOptions());
    const sha = await git.headSha(this.cwd, this.gitOptions());
    await this.log("commit", `Committed ${sha.slice(0, 7)} as ${name}: ${firstLine(message)}`);
    return sha;
  }

  async push(branch) {
    await this.ensureStillExists();
    this.step = "push";
    if (this.unpublishedBase) await this.pushBase(this.unpublishedBase);
    await this.log("push", `Pushing ${branch} to GitHub (git push -u origin ${branch})…`);
    try {
      await git.pushBranch(this.cwd, branch, this.gitOptions());
    } catch (err) {
      if (err.aborted) throw err;
      throw new PipelineError(git.describePushFailure(err, { fullName: this.repo.fullName, branch }));
    }
    await this.log("push", `Pushed ${branch} to ${this.repo.fullName}`);
  }

  /** Create the base branch of a repository that was empty (its initial commit). */
  async pushBase(base) {
    await this.log("push", `Creating ${base} on GitHub with the initial commit (git push origin ${base})…`);
    try {
      await git.pushBranch(this.cwd, base, { ...this.gitOptions(), setUpstream: false });
    } catch (err) {
      if (err.aborted) throw err;
      const text = `${err.stderr || ""}\n${err.message || ""}`;
      if (/non-fast-forward|fetch first|\[rejected\]|Updates were rejected/i.test(text)) {
        throw new PipelineError(
          `${base} was created on GitHub while this job was running — click Retry to build on top of it.`,
        );
      }
      throw new PipelineError(git.describePushFailure(err, { fullName: this.repo.fullName, branch: base }));
    }
    this.unpublishedBase = null;
    await this.log("push", `Created ${base} on ${this.repo.fullName}`);
  }

  async openPullRequest({ branch, base, body }) {
    await this.ensureStillExists();
    this.step = "pr";
    await this.log("pr", `Opening a pull request: ${branch} → ${base}…`);
    const pr = await this.gh.createPull(
      this.repo.owner,
      this.repo.name,
      { title: this.job.prTitle, head: branch, base, body },
      { signal: this.signal },
    );
    const url = pr?.url || pr?.html_url;
    if (!isRealPrUrl(url)) {
      throw new PipelineError("GitHub didn't return a valid pull request URL.");
    }
    const result = await Job.updateOne({ _id: this.id, prUrl: null }, { $set: { prUrl: url } });
    if (result.modifiedCount === 1) {
      await User.updateOne({ _id: this.job.userId }, { $inc: { successfulPRs: 1 } });
    }
    this.job.prUrl = url;
    await this.log("pr", pr.existing ? `Reusing the open pull request ${url}` : `Opened pull request ${url}`);
    return url;
  }

  /**
   * True when the user sent a message (refinement) after this run started:
   * the queue then runs another "refine" pass right away (see jobQueue.js).
   */
  async newMessagesWaiting() {
    const fresh = await Job.findById(this.id).select("refinements").lean().catch(() => null);
    const included = new Set(this.includedRefinementIds.map(String));
    this.followUp = (fresh?.refinements || []).some(
      (refinement) => !refinement.applied && !included.has(String(refinement._id)),
    );
    return this.followUp;
  }

  async complete(fields, message) {
    const waiting = await this.newMessagesWaiting();
    const update = {
      $set: {
        ...fields,
        status: waiting ? "queued" : "completed",
        finishedAt: new Date(),
        errorMessage: null,
      },
    };
    const options = {};
    if (this.includedRefinementIds.length) {
      update.$set["refinements.$[included].applied"] = true;
      options.arrayFilters = [{ "included._id": { $in: this.includedRefinementIds } }];
    }
    await Job.updateOne({ _id: this.id }, update, options);
    await this.log("done", message);
    if (waiting) await this.log("queue", "Your new message is next — starting another pass…");
  }

  async fail(err) {
    if (err instanceof JobGoneError) return;
    if (!(await Job.exists({ _id: this.id }).catch(() => true))) return;
    let message;
    const reason = this.signal.aborted ? this.signal.reason : null;
    if (reason?.kind === "timeout" || reason?.kind === "cancelled") {
      message = reason.message;
    } else if (this.signal.aborted) {
      message = "The job was stopped";
    } else if (["PipelineError", "GitHubError", "LlmError", "GitError"].includes(err?.name)) {
      message = err.message;
    } else {
      message = `Unexpected error: ${err?.message || String(err)}`;
    }
    message = this.redact(message);
    const stopped = this.signal.aborted && reason?.kind === "cancelled";
    const waiting = !stopped && (await this.newMessagesWaiting());
    try {
      await Job.updateOne(
        { _id: this.id },
        {
          $set: {
            status: waiting ? "queued" : "failed",
            errorMessage: message,
            finishedAt: new Date(),
          },
        },
      );
    } catch (dbError) {
      console.error(`[jobs] Could not mark job ${this.id} as failed: ${scrubSecrets(dbError.message)}`);
    }
    await this.log("error", message, "error");
    if (waiting) await this.log("queue", "Your new message is next — starting another pass…");
    console.error(`[jobs] Job ${this.id} failed (${this.mode || this.requestedMode}, step ${this.step}): ${message}`);
  }

  // ── flows ────────────────────────────────────────────────────────────────

  async runCreate() {
    const { job } = this;
    const repo = await this.prepareRepo();
    this.baseBranch = repo.defaultBranch;
    await this.set({ baseBranch: this.baseBranch, diff: null, diffSummary: null, commitSha: null });
    const baseSha = await this.clone(this.baseBranch, { allowEmpty: true });
    const branch = await this.chooseBranch(job.branchName);
    await this.checkout(branch);

    const refinements = (job.refinements || []).map((r) => ({
      instruction: r.instruction,
      attachments: r.attachments,
      applied: false,
    }));
    this.includedRefinementIds = (job.refinements || []).map((r) => r._id);
    const request = prompts.buildRequestBlock({
      instruction: job.instruction,
      attachments: job.attachments,
      refinements,
    });
    const edit = await this.generateChanges(request);

    const snap = await this.snapshot();
    const commitMessage = prompts.cleanCommitMessage(edit.commitMessage, job);
    const prBody = prompts.buildPrBody(edit.prBody, edit.summary, job);
    const commitSha = await this.commitChanges(commitMessage);
    const fields = {
      diff: snap.diff,
      diffSummary: prompts.buildDiffSummary(edit.summary, snap.stat),
      baseBranch: this.baseBranch,
      // An empty repo's initial commit exists only locally: nothing to compare later.
      baseSha: this.emptyRepository ? null : baseSha,
      commitSha,
      commitMessage,
      prBody,
      branchName: branch,
      changes: await this.storable(snap.changes, { required: job.previewBeforePush }),
    };
    if (job.previewBeforePush) {
      await this.complete(fields, "Preview ready — review the diff, then click Open PR");
      return;
    }
    await this.set(fields);
    await this.push(branch);
    const url = await this.openPullRequest({ branch, base: this.baseBranch, body: prBody });
    await this.complete({}, `Done — pull request: ${url}`);
  }

  async runPublish() {
    const { job } = this;
    if (!hasStoredChanges(job)) {
      throw new PipelineError(
        "This job has no stored preview to publish — refine it or create a new job.",
      );
    }
    const repo = await this.prepareRepo();
    this.baseBranch = job.baseBranch || repo.defaultBranch;
    const headSha = await this.clone(this.baseBranch, { allowEmpty: true });
    if (job.baseSha && !this.emptyRepository && job.baseSha !== headSha) {
      await this.log(
        "clone",
        `${this.baseBranch} moved since the preview (${job.baseSha.slice(0, 7)} → ${headSha.slice(0, 7)}); the previewed files are applied on top of the latest ${this.baseBranch} — review the PR diff`,
        "warn",
      );
    }
    const branch = await this.chooseBranch(job.branchName);
    await this.checkout(branch);
    await this.replay(job.changes, "Applying the previewed changes");
    const snap = await this.snapshot(
      `Nothing to publish — ${this.baseBranch} already contains these changes.`,
    );
    const message = job.commitMessage || prompts.cleanCommitMessage("", job);
    const commitSha = await this.commitChanges(message);
    await this.set({
      diff: snap.diff,
      commitSha,
      baseSha: this.emptyRepository ? null : headSha,
      baseBranch: this.baseBranch,
    });
    await this.push(branch);
    const url = await this.openPullRequest({
      branch,
      base: this.baseBranch,
      body: job.prBody || prompts.buildPrBody("", "", job),
    });
    await this.complete({}, `Done — pull request: ${url}`);
  }

  /** The PR exists: work on top of its branch, push, the PR updates itself. */
  async runRefinePullRequest() {
    const { job } = this;
    const repo = await this.prepareRepo();
    this.baseBranch = job.baseBranch || repo.defaultBranch;
    const branch = job.branchName;
    if (!(await this.reuseClone(branch))) {
      await this.clone(branch, {
        missingBranchMessage: `The pull request branch ${branch} no longer exists on GitHub (was the PR merged and the branch deleted?). Create a new job instead.`,
      });
    }
    const pending = pendingRefinements(job);
    this.includedRefinementIds = pending.map((r) => r._id);
    const request = prompts.buildRequestBlock({
      instruction: job.instruction,
      attachments: job.attachments,
      refinements: job.refinements,
      originalApplied: true,
    });
    const edit = await this.generateChanges(request);
    const snap = await this.snapshot();
    const commitMessage = prompts.cleanCommitMessage(edit.commitMessage, {
      instruction: pending[pending.length - 1]?.instruction || job.instruction,
    });
    const commitSha = await this.commitChanges(commitMessage);
    await this.set({
      diff: snap.diff,
      diffSummary: prompts.buildDiffSummary(
        edit.summary ? `Refinement: ${edit.summary}` : "Refinement",
        snap.stat,
      ),
      commitSha,
      changes: await this.storable(mergeChanges(job.changes, snap.changes), { required: false }),
    });
    await this.push(branch);
    const url = await this.ensureOpenPullRequest(branch);
    await this.complete({}, `Update pushed to ${branch} — pull request: ${url}`);
  }

  /**
   * After an update is pushed, make sure a pull request is open for it:
   * keep the open one, reopen a closed one, or open a new one when the
   * previous PR was already merged. Returns the PR's URL.
   */
  async ensureOpenPullRequest(branch) {
    await this.ensureStillExists();
    this.step = "pr";
    const { owner, name } = this.repo;
    const options = { signal: this.signal };
    let open;
    try {
      open = await this.gh.findOpenPull(owner, name, branch, options);
    } catch (err) {
      if (this.signal.aborted) throw err;
      await this.log("pr", `Couldn't check the pull request on GitHub (${err.message})`, "warn");
      return this.job.prUrl;
    }
    if (open) {
      if (open.url && open.url !== this.job.prUrl) await this.set({ prUrl: open.url });
      await this.log("pr", `The pull request is open and now includes this update: ${open.url || this.job.prUrl}`);
      return open.url || this.job.prUrl;
    }

    const number = Number(String(this.job.prUrl || "").match(/\/pull\/(\d+)/)?.[1]);
    let previous = null;
    if (number && this.gh.getPull) {
      try {
        previous = await this.gh.getPull(owner, name, number, options);
      } catch (err) {
        if (this.signal.aborted) throw err;
      }
    }
    if (previous && previous.state === "closed" && !previous.merged && this.gh.reopenPull) {
      try {
        const reopened = await this.gh.reopenPull(owner, name, number, options);
        const url = reopened?.url || this.job.prUrl;
        await this.log("pr", `The pull request had been closed — reopened it with this update: ${url}`);
        return url;
      } catch (err) {
        if (this.signal.aborted) throw err;
        await this.log("pr", `Couldn't reopen the closed pull request (${err.message}) — opening a new one`, "warn");
      }
    } else if (previous?.merged) {
      await this.log("pr", "The previous pull request was already merged — opening a new pull request for this update");
    } else {
      await this.log("pr", "The previous pull request is no longer open — opening a new one for this update");
    }

    await this.log("pr", `Opening a pull request: ${branch} → ${this.baseBranch}…`);
    const title = previous?.merged ? `${this.job.prTitle} (update)` : this.job.prTitle;
    const pr = await this.gh.createPull(
      owner,
      name,
      { title, head: branch, base: this.baseBranch, body: this.job.prBody || prompts.buildPrBody("", "", this.job) },
      options,
    );
    const url = pr?.url || pr?.html_url;
    if (!isRealPrUrl(url)) throw new PipelineError("GitHub didn't return a valid pull request URL.");
    await this.set({ prUrl: url });
    await User.updateOne({ _id: this.job.userId }, { $inc: { successfulPRs: 1 } });
    await this.log("pr", `Opened pull request ${url}`);
    return url;
  }

  /** No PR yet: rebuild the previous result on the base branch, then refine. */
  async runRefineFromBase() {
    const { job } = this;
    const repo = await this.prepareRepo();
    this.baseBranch = job.baseBranch || repo.defaultBranch;
    await this.set({ baseBranch: this.baseBranch });
    const stored = hasStoredChanges(job) ? job.changes : [];
    // Continue in the previous preview's clone (its commit is already there).
    const reused = stored.length > 0 && (await this.reuseClone(job.branchName));
    // An empty repository's base commit may still exist only in this clone.
    if (reused && !job.previewBeforePush && (await this.remoteIsEmpty())) {
      this.unpublishedBase = this.baseBranch;
    }
    let baseSha = job.baseSha;
    let branch = job.branchName;
    if (!reused) {
      baseSha = await this.clone(this.baseBranch, { allowEmpty: true });
      if (this.emptyRepository) baseSha = null;
      branch = await this.chooseBranch(job.branchName);
      await this.checkout(branch);
      if (stored.length) {
        await this.replay(stored, "Re-applying the previous preview");
        await git.addAll(this.cwd, this.gitOptions());
      }
    }
    const pending = pendingRefinements(job);
    this.includedRefinementIds = pending.map((r) => r._id);
    const request = prompts.buildRequestBlock({
      instruction: job.instruction,
      attachments: job.attachments,
      refinements: job.refinements,
      originalApplied: stored.length > 0,
    });
    const edit = await this.generateChanges(request);
    const snap = await this.snapshot();
    const refinedMessage = prompts.cleanCommitMessage(edit.commitMessage, job);
    const commitMessage =
      stored.length && job.commitMessage
        ? `${job.commitMessage}\n\nRefined: ${firstLine(refinedMessage)}`
        : refinedMessage;
    const prBody =
      stored.length && job.prBody
        ? `${job.prBody}\n\n### Follow-up\n${edit.summary || firstLine(refinedMessage)}`
        : prompts.buildPrBody(edit.prBody, edit.summary, job);
    // A reused clone already holds the previous preview commit, so this round
    // is a new commit on top; the stored preview becomes the combined result.
    const commitSha = await this.commitChanges(reused ? refinedMessage : commitMessage);
    const changes = reused ? mergeChanges(stored, snap.changes) : snap.changes;
    const diff = reused ? (await this.diffAgainstBase()) || snap.diff : snap.diff;
    const fields = {
      diff,
      diffSummary: prompts.buildDiffSummary(edit.summary, snap.stat),
      baseBranch: this.baseBranch,
      baseSha,
      commitSha,
      commitMessage,
      prBody,
      branchName: branch,
      changes: await this.storable(changes, { required: job.previewBeforePush }),
    };
    if (job.previewBeforePush) {
      await this.complete(fields, "Preview updated — review the diff, then click Open PR");
      return;
    }
    await this.set(fields);
    await this.push(branch);
    const url = await this.openPullRequest({ branch, base: this.baseBranch, body: prBody });
    await this.complete({}, `Done — pull request: ${url}`);
  }
}

/**
 * Run one job in `mode` ("create" | "publish" | "refine" | "retry").
 * deps: { signal, createGitHubClient(token), createLlmClient({apiKey, apiKeys, log}),
 *         remoteUrl (string | (repoInfo) => string), workdirRoot }
 * Never throws.
 */
export async function runPipeline(jobId, mode, deps = {}) {
  const signal = deps.signal || new AbortController().signal;
  let run = null;
  let workspace = null;
  try {
    const job = await Job.findById(jobId).select(INTERNAL_FIELDS);
    if (!job) return { ok: false, reason: "missing" };
    const user = await User.findById(job.userId);
    const credentials = resolveCredentials(user);
    workspace = createWorkspace(job, deps.workdirRoot);
    const redact = createRedactor([credentials.githubToken, ...(credentials.groqKeys || [credentials.groqKey])], {
      paths: workspace.redactions,
    });
    run = new JobRun({ job, credentials, workspace, redact, signal, deps, requestedMode: mode });
    await run.execute();
    return { ok: true, followUp: !!run.followUp };
  } catch (err) {
    if (run) {
      try {
        await run.fail(err);
      } catch (failError) {
        console.error(`[jobs] Could not record the failure of job ${jobId}: ${scrubSecrets(failError.message)}`);
      }
    } else {
      console.error(`[jobs] Job ${jobId} could not start: ${scrubSecrets(err?.message || String(err))}`);
      try {
        await Job.updateOne(
          { _id: jobId },
          { $set: { status: "failed", errorMessage: "The job could not start — click Retry", finishedAt: new Date() } },
        );
      } catch {
        // nothing else we can do
      }
    }
    return { ok: false, error: err, followUp: !!run?.followUp };
  } finally {
    if (workspace) {
      // The clone is kept for inspection (unless PR_CLEANUP_WORKDIR=true),
      // except when the job was deleted while it ran.
      const deleted = !(await Job.exists({ _id: jobId }).catch(() => true));
      await workspace.cleanup({ force: deleted });
    }
  }
}
