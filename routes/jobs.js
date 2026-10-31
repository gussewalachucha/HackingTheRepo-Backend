import express from "express";
import mongoose from "mongoose";
import Job from "../models/Job.js";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";
import {
  createJobSchema,
  refineSchema,
  validate,
} from "../middleware/validate.js";
import { slugBranchName } from "../services/branchName.js";
import { resolveCredentials } from "../services/credentials.js";
import { makeLogEntry, pushLogsUpdate } from "../services/jobLog.js";
import { cancelJob, enqueueJob, removeJobFolder } from "../services/jobQueue.js";
import { VisionError, describeImages } from "../services/vision.js";

const router = express.Router();

// Same algorithm as before; falls back when the slug comes out empty
// (e.g. an instruction with no Latin letters or digits).
const toBranchName = (instruction, id) =>
  slugBranchName(instruction) || `repomind/job-${id}`;

function rejectFinalized(res) {
  return res.status(400).json({
    message: "This job is marked as completed, so it can't be updated any more. Create a new job for more changes.",
    code: "JOB_FINISHED",
  });
}

function notFound(res) {
  return res.status(404).json({ message: "Job not found", code: "NOT_FOUND" });
}

async function findOwnedJob(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Job.findOne({ _id: req.params.id, userId: req.user._id });
}

/** Sends a 400 and returns true when a required credential is missing. */
function rejectMissingCredentials(res, credentials, { needLlm = true } = {}) {
  if (!credentials.githubToken) {
    res.status(400).json({
      message:
        "Save your GitHub token in Settings (or sign in with GitHub) before running a job",
      code: "SETTINGS_REQUIRED",
    });
    return true;
  }
  if (needLlm && !credentials.groqKey) {
    res.status(400).json({
      message:
        "No Groq API key found. Add your key in Settings → Groq API keys (or set GROQ_API_KEY in backend/.env), then send your request again.",
      code: "LLM_UNAVAILABLE",
    });
    return true;
  }
  return false;
}

async function credentialsFor(req) {
  const user = await User.findById(req.user._id);
  return resolveCredentials(user);
}

/**
 * Describe the uploaded images with the Groq vision model. Returns the
 * attachments to store, or null after sending an error response.
 */
async function describeAttachments(res, images, instruction, credentials) {
  if (!images?.length) return [];
  try {
    return await describeImages(images, instruction, { apiKeys: credentials.groqKeys });
  } catch (err) {
    if (!(err instanceof VisionError)) throw err;
    const status = err.code === "INVALID_IMAGE" ? 400 : 502;
    res.status(status).json({ message: err.message, code: err.code });
    return null;
  }
}

// POST /api/jobs — Create a job; the PR pipeline runs in the background.
router.post("/", protect, validate(createJobSchema), async (req, res) => {
  try {
    const {
      repoUrl,
      instruction,
      branchName,
      prTitle,
      previewBeforePush = false,
      images,
    } = req.body;

    const credentials = await credentialsFor(req);
    if (rejectMissingCredentials(res, credentials)) return;
    const attachments = await describeAttachments(res, images, instruction, credentials);
    if (!attachments) return;

    const _id = new mongoose.Types.ObjectId();
    const job = await Job.create({
      _id,
      userId: req.user._id,
      repoUrl,
      instruction,
      attachments,
      branchName: branchName || toBranchName(instruction, _id),
      prTitle: prTitle || `repomind: ${instruction.slice(0, 60)}`,
      previewBeforePush: !!previewBeforePush,
      status: "queued",
      logs: [makeLogEntry("queue", "Job created")],
    });

    await User.findByIdAndUpdate(req.user._id, { $inc: { totalJobs: 1 } });
    enqueueJob(job._id, "create");

    res.status(201).json(job);
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

// GET /api/jobs — List all jobs for user
router.get("/", protect, async (req, res) => {
  try {
    // Image previews are only needed on the job page, not in the list.
    const jobs = await Job.find({ userId: req.user._id })
      .select("-attachments.thumbnail -refinements.attachments.thumbnail")
      .sort({ createdAt: -1 });
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

// GET /api/jobs/:id — Get single job
router.get("/:id", protect, async (req, res) => {
  try {
    const job = await findOwnedJob(req);
    if (!job) return notFound(res);
    res.json(job);
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

// GET /api/jobs/:id/status — Current state straight from MongoDB
router.get("/:id/status", protect, async (req, res) => {
  try {
    const job = await findOwnedJob(req);
    if (!job) return notFound(res);
    res.json(job);
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

// POST /api/jobs/:id/refine — queue another AI pass
router.post(
  "/:id/refine",
  protect,
  validate(refineSchema),
  async (req, res) => {
    try {
      const { instruction, images } = req.body;
      const job = await findOwnedJob(req);
      if (!job) return notFound(res);
      if (job.finalized) return rejectFinalized(res);

      const credentials = await credentialsFor(req);
      if (rejectMissingCredentials(res, credentials)) return;
      const attachments = await describeAttachments(res, images, instruction, credentials);
      if (!attachments) return;

      // While a run is in progress the message is stored and queued: a queued
      // job picks it up when it starts, a running one gets another pass right
      // after the current run (the pipeline keeps the job "queued" meanwhile).
      if (["queued", "running"].includes(job.status)) {
        const pending = await Job.findOneAndUpdate(
          {
            _id: job._id,
            userId: req.user._id,
            status: { $in: ["queued", "running"] },
          },
          {
            $push: {
              refinements: { instruction, attachments },
              ...pushLogsUpdate([
                makeLogEntry(
                  "message",
                  job.status === "running"
                    ? "New message received — it will be applied right after the current run finishes"
                    : "New message received — it will be included when the job starts",
                ),
              ]),
            },
          },
          { new: true },
        );
        if (pending) {
          enqueueJob(pending._id, "refine");
          return res.json(pending);
        }
        // The run finished in the meantime: fall through to a normal refinement.
      }

      const updated = await Job.findOneAndUpdate(
        {
          _id: job._id,
          userId: req.user._id,
          status: { $in: ["completed", "failed"] },
        },
        {
          $set: { status: "queued", errorMessage: null, finishedAt: null },
          $push: {
            refinements: { instruction, attachments },
            ...pushLogsUpdate([makeLogEntry("queue", "Refinement requested")]),
          },
        },
        { new: true },
      );
      if (!updated) {
        return res.status(400).json({
          message: "Wait for the current run to finish before refining",
          code: "INVALID_STATUS",
        });
      }

      enqueueJob(updated._id, "refine");
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
    }
  },
);

// POST /api/jobs/:id/open-pr — publish a completed preview
router.post("/:id/open-pr", protect, async (req, res) => {
  try {
    const job = await findOwnedJob(req);
    if (!job) return notFound(res);

    if (job.prUrl) {
      return res.status(400).json({
        message: "Pull request already exists for this job",
        code: "PR_EXISTS",
      });
    }

    if (job.status !== "completed") {
      return res.status(400).json({
        message: "Job must be completed with a preview before opening a PR",
        code: "NOT_READY",
      });
    }

    const hasPreview = await Job.exists({
      _id: job._id,
      "changes.0": { $exists: true },
    });
    if (!hasPreview) {
      return res.status(400).json({
        message:
          "This job has no stored preview to publish — refine it or create a new job",
        code: "NOT_READY",
      });
    }

    if (
      rejectMissingCredentials(res, await credentialsFor(req), {
        needLlm: false,
      })
    ) {
      return;
    }

    const updated = await Job.findOneAndUpdate(
      { _id: job._id, userId: req.user._id, status: "completed", prUrl: null },
      {
        $set: { status: "running", errorMessage: null, finishedAt: null },
        $push: pushLogsUpdate([makeLogEntry("queue", "Open PR requested")]),
      },
      { new: true },
    );
    if (!updated) {
      return res.status(400).json({
        message: "Job must be completed with a preview before opening a PR",
        code: "NOT_READY",
      });
    }

    enqueueJob(updated._id, "publish");
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

// POST /api/jobs/:id/retry — re-run a failed (or stuck queued) job
router.post("/:id/retry", protect, async (req, res) => {
  try {
    const job = await findOwnedJob(req);
    if (!job) return notFound(res);
    if (job.finalized) return rejectFinalized(res);

    if (!["failed", "queued"].includes(job.status)) {
      return res.status(400).json({
        message: "Only failed or queued jobs can be retried",
        code: "INVALID_STATUS",
      });
    }

    // Retrying a failed "Open PR" only pushes stored changes: no LLM needed.
    const retriesPublish = await Job.exists({
      _id: job._id,
      prUrl: null,
      lastMode: "publish",
      "changes.0": { $exists: true },
    });
    if (
      rejectMissingCredentials(res, await credentialsFor(req), {
        needLlm: !retriesPublish,
      })
    ) {
      return;
    }

    const updated = await Job.findOneAndUpdate(
      {
        _id: job._id,
        userId: req.user._id,
        status: { $in: ["failed", "queued"] },
      },
      {
        $set: { status: "queued", errorMessage: null, finishedAt: null },
        $push: pushLogsUpdate([
          makeLogEntry("queue", "──────── Retry requested ────────"),
        ]),
      },
      { new: true },
    );
    if (!updated) {
      return res.status(400).json({
        message: "Only failed or queued jobs can be retried",
        code: "INVALID_STATUS",
      });
    }

    enqueueJob(updated._id, "retry");
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

// POST /api/jobs/:id/finish — the user is done: stop accepting updates
router.post("/:id/finish", protect, async (req, res) => {
  try {
    const job = await findOwnedJob(req);
    if (!job) return notFound(res);
    if (job.finalized) return res.json(job);

    const updated = await Job.findOneAndUpdate(
      {
        _id: job._id,
        userId: req.user._id,
        status: { $nin: ["queued", "running"] },
      },
      {
        $set: { finalized: true, finalizedAt: new Date() },
        $push: pushLogsUpdate([
          makeLogEntry("done", "Marked as completed — no more updates will be made to this job"),
        ]),
      },
      { new: true },
    );
    if (!updated) {
      return res.status(400).json({
        message: "Wait for the current update to finish before marking the job as completed",
        code: "INVALID_STATUS",
      });
    }
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

// DELETE /api/jobs/:id
router.delete("/:id", protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return notFound(res);
    const deleted = await Job.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!deleted) return notFound(res);
    cancelJob(deleted._id);
    removeJobFolder(deleted);
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

export default router;
