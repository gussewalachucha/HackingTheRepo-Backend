import Job from "../models/Job.js";
import { scrubSecrets } from "./redact.js";

export const MAX_LOG_ENTRIES = 200;
const MAX_MESSAGE_CHARS = 2000;

export const LOG_STEPS = [
  "queue",
  "message",
  "clone",
  "branch",
  "structure",
  "analyze",
  "edit",
  "apply",
  "commit",
  "push",
  "pr",
  "done",
  "error",
];
const LEVELS = new Set(["info", "warn", "error"]);

export function makeLogEntry(step, message, level = "info", redact = scrubSecrets) {
  let text = redact(String(message ?? ""));
  if (text.length > MAX_MESSAGE_CHARS) text = `${text.slice(0, MAX_MESSAGE_CHARS)}…`;
  return {
    step: LOG_STEPS.includes(step) ? step : "queue",
    message: text,
    level: LEVELS.has(level) ? level : "info",
    at: new Date(),
  };
}

/** $push update that appends `entries` and keeps only the newest entries. */
export function pushLogsUpdate(entries) {
  return { logs: { $each: entries, $slice: -MAX_LOG_ENTRIES } };
}

/**
 * Append one log entry atomically. Never throws: logging must not be able
 * to fail a job (or crash the process).
 */
export async function appendJobLog(jobId, step, message, level = "info", redact) {
  const entry = makeLogEntry(step, message, level, redact);
  try {
    await Job.updateOne({ _id: jobId }, { $push: pushLogsUpdate([entry]) });
  } catch (err) {
    console.error(`[jobs] Could not write a log entry for job ${jobId}: ${scrubSecrets(err.message)}`);
  }
  return entry;
}
