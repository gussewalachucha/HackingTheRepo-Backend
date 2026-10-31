import mongoose from "mongoose";

const logSchema = new mongoose.Schema(
  {
    step: { type: String, required: true },
    message: { type: String, default: "" },
    level: { type: String, enum: ["info", "warn", "error"], default: "info" },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

// An uploaded image: only its vision-model description and a small preview
// are kept, never the full image.
const attachmentSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    mimeType: { type: String, default: "" },
    size: { type: Number, default: 0 },
    thumbnail: { type: String, default: null },
    description: { type: String, default: "" },
  },
  { _id: false }
);

// Fields the pipeline needs internally; never part of an API response.
const INTERNAL_FIELDS = ["changes", "commitMessage", "prBody", "baseSha", "lastMode"];

const jobSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    repoUrl: { type: String, required: true },
    instruction: { type: String, required: true },
    attachments: { type: [attachmentSchema], default: [] },
    branchName: { type: String, required: true },
    prTitle: { type: String, required: true },
    previewBeforePush: { type: Boolean, default: false },
    // Legacy: job id of the removed RepoMind FastAPI service
    repomindJobId: { type: String, default: null },
    status: {
      type: String,
      // "refined" is kept for old documents; it is no longer set.
      enum: ["queued", "running", "completed", "failed", "refined"],
      default: "queued",
    },
    prUrl: { type: String, default: null },
    diff: { type: String, default: null },
    diffSummary: { type: String, default: null },
    baseBranch: { type: String, default: null },
    commitSha: { type: String, default: null },
    errorMessage: { type: String, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    logs: { type: [logSchema], default: [] },
    // Set when the user says they are done: no more updates are accepted.
    finalized: { type: Boolean, default: false },
    finalizedAt: { type: Date, default: null },
    // Refinement history
    refinements: [
      {
        instruction: String,
        attachments: { type: [attachmentSchema], default: [] },
        timestamp: { type: Date, default: Date.now },
        // true once a successful run has implemented this refinement
        applied: { type: Boolean, default: false },
      },
    ],
    // Final state of every changed path [{ path, action: "write"|"delete", content? }],
    // used to replay a preview when publishing or refining it.
    changes: { type: mongoose.Schema.Types.Mixed, select: false },
    commitMessage: { type: String, select: false },
    prBody: { type: String, select: false },
    baseSha: { type: String, select: false },
    lastMode: { type: String, select: false },
  },
  { timestamps: true }
);

jobSchema.set("toJSON", {
  transform(_doc, ret) {
    for (const field of INTERNAL_FIELDS) delete ret[field];
    return ret;
  },
});

export default mongoose.model("Job", jobSchema);
