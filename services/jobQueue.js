// In-process job queue: a concurrency limiter in front of runPipeline.
//
// - At most PR_MAX_CONCURRENT_JOBS (default 2) pipelines run at once; others
//   stay "queued" with a "Waiting for a free worker" log.
// - Each run gets an AbortController that fires after PR_JOB_TIMEOUT_MS
//   (default 15 min) or when the job is deleted.
// - A job is never queued twice, and a pipeline rejection can never crash
//   the process.
//
// Single-process by design: run one backend instance (not serverless).
import Job from "../models/Job.js";
import { appendJobLog, pushLogsUpdate, makeLogEntry } from "./jobLog.js";
import { removeJobWorkspace, runPipeline } from "./prPipeline.js";
import { scrubSecrets } from "./redact.js";

export class JobAbortError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "JobAbortError";
    this.kind = kind;
  }
}

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function formatMinutes(ms) {
  const minutes = ms / 60000;
  return minutes >= 1
    ? `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minute${minutes === 1 ? "" : "s"}`
    : `${Math.round(ms / 1000)} seconds`;
}

export function createJobQueue({
  runner = runPipeline,
  maxConcurrent,
  timeoutMs,
  onWait = () => {},
} = {}) {
  const waiting = [];
  const pending = new Set();
  const active = new Map();
  const limit = () => maxConcurrent ?? envInt("PR_MAX_CONCURRENT_JOBS", 2);
  const timeout = () => timeoutMs ?? envInt("PR_JOB_TIMEOUT_MS", 15 * 60 * 1000);

  function start(task) {
    const controller = new AbortController();
    const ms = timeout();
    const timer = setTimeout(() => {
      controller.abort(new JobAbortError("timeout", `Timed out after ${formatMinutes(ms)}`));
    }, ms);
    timer.unref?.();
    active.set(task.id, { controller, mode: task.mode });

    let followUp = false;
    Promise.resolve()
      .then(() => runner(task.id, task.mode, { ...task.options, signal: controller.signal }))
      .then((result) => {
        // The user sent a message while this run was busy: refine next.
        followUp = Boolean(result?.followUp);
      })
      .catch((err) => {
        console.error(
          `[jobs] Unexpected pipeline error for job ${task.id}: ${scrubSecrets(err?.message || String(err))}`,
        );
      })
      .finally(() => {
        clearTimeout(timer);
        active.delete(task.id);
        if (followUp) enqueue(task.id, "refine", task.options);
        drain();
      });
  }

  function drain() {
    let index = 0;
    while (active.size < limit() && index < waiting.length) {
      const task = waiting[index];
      // A follow-up for a job that is still finishing waits for that run.
      if (active.has(task.id)) {
        index += 1;
        continue;
      }
      waiting.splice(index, 1);
      pending.delete(task.id);
      start(task);
    }
  }

  /** Queue a run. Returns false if this job is already waiting. */
  function enqueue(jobId, mode, options = {}) {
    const id = String(jobId);
    if (pending.has(id)) return false;
    pending.add(id);
    waiting.push({ id, mode, options });
    // A follow-up for a job that is still running isn't waiting for a worker.
    if (!active.has(id) && active.size >= limit()) {
      Promise.resolve()
        .then(() => onWait(id))
        .catch(() => {});
    }
    drain();
    return true;
  }

  /** Drop a waiting run and abort a running one. Returns true if found. */
  function cancel(jobId, message = "Cancelled") {
    const id = String(jobId);
    let found = false;
    const index = waiting.findIndex((task) => task.id === id);
    if (index !== -1) {
      waiting.splice(index, 1);
      pending.delete(id);
      found = true;
    }
    const entry = active.get(id);
    if (entry) {
      entry.controller.abort(new JobAbortError("cancelled", message));
      found = true;
    }
    return found;
  }

  function has(jobId) {
    const id = String(jobId);
    return pending.has(id) || active.has(id);
  }

  function stats() {
    return { active: active.size, waiting: waiting.length };
  }

  return { enqueue, cancel, has, stats };
}

const defaultQueue = createJobQueue({
  onWait: (jobId) => appendJobLog(jobId, "queue", "Waiting for a free worker…"),
});

export function enqueueJob(jobId, mode, options) {
  return defaultQueue.enqueue(jobId, mode, options);
}

export function cancelJob(jobId) {
  return defaultQueue.cancel(jobId, "Cancelled because the job was deleted");
}

export function isJobQueued(jobId) {
  return defaultQueue.has(jobId);
}

/**
 * Remove a deleted job's clone folder. If the job is still running, its
 * pipeline also removes the folder once it stops.
 */
export async function removeJobFolder(job) {
  try {
    await removeJobWorkspace(job);
  } catch (err) {
    console.warn(`[jobs] Could not remove the folder of job ${job._id}: ${scrubSecrets(err?.message || String(err))}`);
  }
}

export const RECOVERY_MESSAGE =
  "Interrupted because the backend restarted while this job was running — click Retry";

const PROCESS_STARTED_AT = new Date();

/**
 * Run once at startup: jobs left "running"/"queued" by a previous process
 * (or by the old RepoMind service) can never finish, so mark them failed.
 * Only jobs last updated before this process started are touched, so a job
 * created while MongoDB was still connecting is left alone.
 */
export async function recoverInterruptedJobs({ before = PROCESS_STARTED_AT } = {}) {
  const entry = makeLogEntry("error", RECOVERY_MESSAGE, "error");
  const result = await Job.updateMany(
    {
      status: { $in: ["running", "queued"] },
      $or: [{ updatedAt: { $lt: before } }, { updatedAt: { $exists: false } }],
    },
    {
      $set: { status: "failed", errorMessage: RECOVERY_MESSAGE, finishedAt: new Date() },
      $push: pushLogsUpdate([entry]),
    },
  );
  return result.modifiedCount || 0;
}
