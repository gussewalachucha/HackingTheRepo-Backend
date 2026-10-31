import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";

// The routes only enqueue work: mock the queue so no git/GitHub/Groq runs.
vi.mock("../services/jobQueue.js", () => ({
  enqueueJob: vi.fn(() => true),
  cancelJob: vi.fn(() => false),
  removeJobFolder: vi.fn(async () => {}),
  isJobQueued: vi.fn(() => false),
  recoverInterruptedJobs: vi.fn(async () => 0),
  RECOVERY_MESSAGE: "Interrupted",
}));

// Image understanding calls Groq: replace it with a canned description.
vi.mock("../services/vision.js", async () => {
  const actual = await vi.importActual("../services/vision.js");
  return {
    ...actual,
    describeImages: vi.fn(async (images) =>
      images.map((image) => {
        if (!String(image.dataUrl).startsWith("data:image/")) {
          throw new actual.VisionError("Each image must be a base64 data URL", "INVALID_IMAGE");
        }
        return { name: image.name || "image", mimeType: "image/png", size: 10, thumbnail: null, description: "A blue slider" };
      }),
    ),
  };
});

import app from "../index.js";
import Job from "../models/Job.js";
import User from "../models/User.js";
import { cancelJob, enqueueJob, removeJobFolder } from "../services/jobQueue.js";
import {
  connectTestDb,
  clearDb,
  disconnectTestDb,
  createUserAndToken,
  authHeader,
  agent,
} from "./helpers.js";

process.env.VITEST = "true";
process.env.JWT_SECRET = process.env.JWT_SECRET || "ci-test-secret";

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await clearDb();
  vi.clearAllMocks();
  // index.js loads backend/.env: never depend on the developer's values.
  delete process.env.GROQ_API_KEY;
  delete process.env.REPOMIND_GITHUB_TOKEN;
});

async function makeJob(userId, overrides = {}) {
  return Job.create({
    userId,
    repoUrl: "https://github.com/a/b",
    instruction: "x",
    branchName: "repomind/x",
    prTitle: "x",
    status: "queued",
    ...overrides,
  });
}

describe("POST /api/jobs", () => {
  it("stores the vision description of attached images", async () => {
    const { token } = await createUserAndToken({ username: "imgs", email: "imgs@example.com" });
    const res = await agent(app)
      .post("/api/jobs")
      .set(authHeader(token))
      .send({
        repoUrl: "https://github.com/a/b",
        instruction: "make the slider look like this",
        images: [{ name: "slider.png", dataUrl: "data:image/png;base64,AAAA" }],
      });
    expect(res.status).toBe(201);
    expect(res.body.attachments).toEqual([
      expect.objectContaining({ name: "slider.png", description: "A blue slider" }),
    ]);
    expect(enqueueJob).toHaveBeenCalled();

    const bad = await agent(app)
      .post("/api/jobs")
      .set(authHeader(token))
      .send({ repoUrl: "https://github.com/a/b", instruction: "x", images: [{ dataUrl: "nope" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_IMAGE");
  });

  it("requires auth", async () => {
    const res = await agent(app).post("/api/jobs").send({
      repoUrl: "https://github.com/a/b",
      instruction: "do stuff",
    });
    expect(res.status).toBe(401);
  });

  it("returns SETTINGS_REQUIRED without any GitHub token", async () => {
    const { token } = await createUserAndToken({
      stripSecrets: true,
      username: "nosettings",
      email: "nosettings@example.com",
    });
    process.env.GROQ_API_KEY = "gsk_server_key";

    const res = await agent(app)
      .post("/api/jobs")
      .set(authHeader(token))
      .send({ repoUrl: "https://github.com/a/b", instruction: "do stuff" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SETTINGS_REQUIRED");
    expect(await Job.countDocuments()).toBe(0);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("returns LLM_UNAVAILABLE without any Groq key", async () => {
    const { token } = await createUserAndToken({
      username: "nogroq",
      email: "nogroq@example.com",
      groqKey: null,
    });

    const res = await agent(app)
      .post("/api/jobs")
      .set(authHeader(token))
      .send({ repoUrl: "https://github.com/a/b", instruction: "add tests" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("LLM_UNAVAILABLE");
    expect(await Job.countDocuments()).toBe(0);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("falls back to the server GitHub token and Groq key", async () => {
    const { token } = await createUserAndToken({
      stripSecrets: true,
      username: "serverkeys",
      email: "serverkeys@example.com",
    });
    process.env.REPOMIND_GITHUB_TOKEN = "ghp_server_token";
    process.env.GROQ_API_KEY = "gsk_server_key";

    const res = await agent(app)
      .post("/api/jobs")
      .set(authHeader(token))
      .send({ repoUrl: "https://github.com/a/b", instruction: "add tests" });

    expect(res.status).toBe(201);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(String(enqueueJob.mock.calls[0][0])).toBe(res.body._id);
    expect(enqueueJob.mock.calls[0][1]).toBe("create");
  });

  it("creates a queued job and enqueues the create pipeline", async () => {
    const { token, user } = await createUserAndToken({
      username: "jobber",
      email: "jobber@example.com",
    });

    const res = await agent(app)
      .post("/api/jobs")
      .set(authHeader(token))
      .send({
        repoUrl: "https://github.com/a/b",
        instruction: "Add tests",
        previewBeforePush: true,
        branchName: "",
        prTitle: "",
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    expect(res.body.previewBeforePush).toBe(true);
    expect(res.body.branchName).toBe("repomind/add-tests");
    expect(res.body.prTitle).toBe("repomind: Add tests");
    expect(res.body.prUrl).toBeNull();
    expect(res.body.diff).toBeNull();
    expect(Array.isArray(res.body.logs)).toBe(true);
    expect(res.body.logs[0]).toMatchObject({ step: "queue", level: "info" });
    expect(res.body).not.toHaveProperty("changes");
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob.mock.calls[0][0].toString()).toBe(res.body._id);
    expect(enqueueJob.mock.calls[0][1]).toBe("create");

    const fresh = await User.findById(user._id);
    expect(fresh.totalJobs).toBe(1);
  });

  it("keeps a valid custom branch name", async () => {
    const { token } = await createUserAndToken({
      username: "custombranch",
      email: "custombranch@example.com",
    });
    const res = await agent(app)
      .post("/api/jobs")
      .set(authHeader(token))
      .send({
        repoUrl: "https://github.com/a/b.git",
        instruction: "x",
        branchName: "feature/my-change_1.2",
      });
    expect(res.status).toBe(201);
    expect(res.body.branchName).toBe("feature/my-change_1.2");
  });

  it("falls back to repomind/job-<id> when the instruction has no usable slug", async () => {
    const { token } = await createUserAndToken({
      username: "noslug",
      email: "noslug@example.com",
    });
    const res = await agent(app)
      .post("/api/jobs")
      .set(authHeader(token))
      .send({ repoUrl: "https://github.com/a/b", instruction: "¿¿¿ ???" });
    expect(res.status).toBe(201);
    expect(res.body.branchName).toBe(`repomind/job-${res.body._id}`);
  });

  it.each([
    ["-starts-with-dash"],
    ["has space"],
    ["a..b"],
    ["feature/"],
    ["bad~name"],
    ["x.lock"],
  ])("rejects branch name %j", async (branchName) => {
    const { token } = await createUserAndToken({
      username: `badbranch${Math.random().toString(36).slice(2, 8)}`,
    });
    const res = await agent(app)
      .post("/api/jobs")
      .set(authHeader(token))
      .send({ repoUrl: "https://github.com/a/b", instruction: "x", branchName });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("rejects repositories that are not on github.com", async () => {
    const { token } = await createUserAndToken({
      username: "gitlab",
      email: "gitlab@example.com",
    });
    const res = await agent(app)
      .post("/api/jobs")
      .set(authHeader(token))
      .send({ repoUrl: "https://gitlab.com/a/b", instruction: "x" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.message).toMatch(/github\.com/);
  });
});

describe("reading jobs", () => {
  it("scopes get to owner", async () => {
    const owner = await createUserAndToken({ username: "owner", email: "owner@example.com" });
    const other = await createUserAndToken({ username: "other", email: "other@example.com" });
    const job = await makeJob(owner.user._id);

    const res = await agent(app).get(`/api/jobs/${job._id}`).set(authHeader(other.token));
    expect(res.status).toBe(404);

    const invalid = await agent(app).get("/api/jobs/not-an-id").set(authHeader(owner.token));
    expect(invalid.status).toBe(404);
  });

  it("status returns the stored state without the internal changes", async () => {
    const { token, user } = await createUserAndToken({
      username: "poller",
      email: "poller@example.com",
    });
    const job = await makeJob(user._id, {
      status: "completed",
      prUrl: "https://github.com/a/b/pull/12",
      diff: "diff --git a/x b/x",
      diffSummary: "Did things\n\n 1 file changed",
      baseBranch: "main",
      commitSha: "a".repeat(40),
      logs: [{ step: "done", message: "Done", level: "info" }],
      changes: [{ path: "x", action: "write", content: "secret-ish content" }],
      commitMessage: "msg",
    });

    const res = await agent(app).get(`/api/jobs/${job._id}/status`).set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "completed",
      prUrl: "https://github.com/a/b/pull/12",
      diff: "diff --git a/x b/x",
      baseBranch: "main",
      commitSha: "a".repeat(40),
    });
    expect(res.body.logs).toHaveLength(1);
    expect(res.body).not.toHaveProperty("changes");
    expect(res.body).not.toHaveProperty("commitMessage");
    expect(JSON.stringify(res.body)).not.toContain("secret-ish content");
  });

  it("lists jobs without the internal changes", async () => {
    const { token, user } = await createUserAndToken({ username: "lister", email: "lister@example.com" });
    await makeJob(user._id, { changes: [{ path: "x", action: "write", content: "hidden" }] });
    const res = await agent(app).get("/api/jobs").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain("hidden");
  });
});

describe("POST /api/jobs/:id/open-pr", () => {
  it("rejects a job that is not completed", async () => {
    const { token, user } = await createUserAndToken({ username: "notready", email: "notready@example.com" });
    const job = await makeJob(user._id, { status: "running", previewBeforePush: true });
    const res = await agent(app).post(`/api/jobs/${job._id}/open-pr`).set(authHeader(token));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NOT_READY");
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("rejects when a PR already exists", async () => {
    const { token, user } = await createUserAndToken({ username: "haspr", email: "haspr@example.com" });
    const job = await makeJob(user._id, {
      status: "completed",
      prUrl: "https://github.com/a/b/pull/1",
    });
    const res = await agent(app).post(`/api/jobs/${job._id}/open-pr`).set(authHeader(token));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PR_EXISTS");
  });

  it("rejects a completed job without a stored preview", async () => {
    const { token, user } = await createUserAndToken({ username: "nopreview", email: "nopreview@example.com" });
    const job = await makeJob(user._id, { status: "completed", previewBeforePush: true });
    const res = await agent(app).post(`/api/jobs/${job._id}/open-pr`).set(authHeader(token));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NOT_READY");
  });

  it("starts publishing a completed preview", async () => {
    const { token, user } = await createUserAndToken({ username: "opener", email: "opener@example.com" });
    const job = await makeJob(user._id, {
      status: "completed",
      previewBeforePush: true,
      diff: "diff",
      changes: [{ path: "a.txt", action: "write", content: "a\n" }],
    });

    const res = await agent(app).post(`/api/jobs/${job._id}/open-pr`).set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("running");
    expect(res.body.prUrl).toBeNull();
    expect(res.body).not.toHaveProperty("changes");
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob.mock.calls[0][1]).toBe("publish");
  });
});

describe("POST /api/jobs/:id/refine", () => {
  it("queues a refinement for a completed job", async () => {
    const { token, user } = await createUserAndToken({ username: "refiner", email: "refiner@example.com" });
    const job = await makeJob(user._id, { status: "completed", errorMessage: "old" });

    const res = await agent(app)
      .post(`/api/jobs/${job._id}/refine`)
      .set(authHeader(token))
      .send({ instruction: "also add types" });

    expect(res.status).toBe(200);
    expect(["queued", "running"]).toContain(res.body.status);
    expect(res.body.errorMessage).toBeNull();
    expect(res.body.refinements).toHaveLength(1);
    expect(res.body.refinements[0]).toMatchObject({ instruction: "also add types", applied: false });
    expect(enqueueJob.mock.calls[0][1]).toBe("refine");
  });

  it("allows refining a failed job", async () => {
    const { token, user } = await createUserAndToken({ username: "refinefail", email: "refinefail@example.com" });
    const job = await makeJob(user._id, { status: "failed" });
    const res = await agent(app)
      .post(`/api/jobs/${job._id}/refine`)
      .set(authHeader(token))
      .send({ instruction: "try again differently" });
    expect(res.status).toBe(200);
  });

  it("accepts a message while the job is running and queues a follow-up pass", async () => {
    const { token, user } = await createUserAndToken({ username: "busy", email: "busy@example.com" });
    const job = await makeJob(user._id, { status: "running" });
    const res = await agent(app)
      .post(`/api/jobs/${job._id}/refine`)
      .set(authHeader(token))
      .send({ instruction: "more" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("running");
    expect(res.body.refinements[0]).toMatchObject({ instruction: "more", applied: false });
    expect(res.body.logs.at(-1).message).toMatch(/applied right after the current run/);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob.mock.calls[0][1]).toBe("refine");
  });

  it("accepts a message while the job is queued", async () => {
    const { token, user } = await createUserAndToken({ username: "waiter", email: "waiter@example.com" });
    const job = await makeJob(user._id, { status: "queued" });
    const res = await agent(app)
      .post(`/api/jobs/${job._id}/refine`)
      .set(authHeader(token))
      .send({ instruction: "use TypeScript" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("queued");
    expect(res.body.logs.at(-1).message).toMatch(/included when the job starts/);
  });

  it("requires a Groq key", async () => {
    const { token, user } = await createUserAndToken({
      username: "refinenogroq",
      email: "refinenogroq@example.com",
      groqKey: null,
    });
    const job = await makeJob(user._id, { status: "completed" });
    const res = await agent(app)
      .post(`/api/jobs/${job._id}/refine`)
      .set(authHeader(token))
      .send({ instruction: "more" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("LLM_UNAVAILABLE");
  });

  it("rejects an empty instruction", async () => {
    const { token, user } = await createUserAndToken({ username: "emptyref", email: "emptyref@example.com" });
    const job = await makeJob(user._id, { status: "completed" });
    const res = await agent(app)
      .post(`/api/jobs/${job._id}/refine`)
      .set(authHeader(token))
      .send({ instruction: "  " });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/jobs/:id/retry", () => {
  it("re-runs a failed job", async () => {
    const { token, user } = await createUserAndToken({ username: "retrier", email: "retrier@example.com" });
    const job = await makeJob(user._id, {
      status: "failed",
      errorMessage: "boom",
      logs: [{ step: "error", message: "boom", level: "error" }],
    });

    const res = await agent(app).post(`/api/jobs/${job._id}/retry`).set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("queued");
    expect(res.body.errorMessage).toBeNull();
    expect(res.body.logs).toHaveLength(2);
    expect(res.body.logs[1].message).toMatch(/Retry/);
    expect(enqueueJob.mock.calls[0][1]).toBe("retry");
  });

  it("re-runs a stuck queued job", async () => {
    const { token, user } = await createUserAndToken({ username: "stuck", email: "stuck@example.com" });
    const job = await makeJob(user._id, { status: "queued" });
    const res = await agent(app).post(`/api/jobs/${job._id}/retry`).set(authHeader(token));
    expect(res.status).toBe(200);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
  });

  it.each([["completed"], ["running"]])("rejects retrying a %s job", async (status) => {
    const { token, user } = await createUserAndToken({
      username: `noretry${status}`,
      email: `noretry${status}@example.com`,
    });
    const job = await makeJob(user._id, { status });
    const res = await agent(app).post(`/api/jobs/${job._id}/retry`).set(authHeader(token));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_STATUS");
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("retrying a failed publish does not need a Groq key", async () => {
    const { token, user } = await createUserAndToken({
      username: "retrypublish",
      email: "retrypublish@example.com",
      groqKey: null,
    });
    const job = await makeJob(user._id, {
      status: "failed",
      lastMode: "publish",
      changes: [{ path: "a.txt", action: "write", content: "a\n" }],
    });
    const res = await agent(app).post(`/api/jobs/${job._id}/retry`).set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/jobs/:id/finish", () => {
  it("marks a job completed for good and blocks further updates", async () => {
    const { token, user } = await createUserAndToken({ username: "finisher", email: "finisher@example.com" });
    const job = await makeJob(user._id, { status: "completed", prUrl: "https://github.com/a/b/pull/1" });

    const res = await agent(app).post(`/api/jobs/${job._id}/finish`).set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.finalized).toBe(true);
    expect(res.body.finalizedAt).toBeTruthy();
    expect(res.body.logs.at(-1)).toMatchObject({ step: "done" });

    const refine = await agent(app)
      .post(`/api/jobs/${job._id}/refine`)
      .set(authHeader(token))
      .send({ instruction: "one more thing" });
    expect(refine.status).toBe(400);
    expect(refine.body.code).toBe("JOB_FINISHED");
    expect(enqueueJob).not.toHaveBeenCalled();

    await Job.updateOne({ _id: job._id }, { $set: { status: "failed" } });
    const retry = await agent(app).post(`/api/jobs/${job._id}/retry`).set(authHeader(token));
    expect(retry.status).toBe(400);
    expect(retry.body.code).toBe("JOB_FINISHED");
  });

  it("refuses while an update is still running", async () => {
    const { token, user } = await createUserAndToken({ username: "hasty", email: "hasty@example.com" });
    const job = await makeJob(user._id, { status: "running" });
    const res = await agent(app).post(`/api/jobs/${job._id}/finish`).set(authHeader(token));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_STATUS");
    expect((await Job.findById(job._id)).finalized).toBe(false);
  });

  it("does not finish another user's job", async () => {
    const owner = await createUserAndToken({ username: "own3", email: "own3@example.com" });
    const other = await createUserAndToken({ username: "oth3", email: "oth3@example.com" });
    const job = await makeJob(owner.user._id, { status: "completed" });
    const res = await agent(app).post(`/api/jobs/${job._id}/finish`).set(authHeader(other.token));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/jobs/:id", () => {
  it("deletes the owner's job, cancels any run and removes its clone folder", async () => {
    const { token, user } = await createUserAndToken({ username: "deleter", email: "deleter@example.com" });
    const job = await makeJob(user._id);

    const res = await agent(app).delete(`/api/jobs/${job._id}`).set(authHeader(token));

    expect(res.status).toBe(200);
    expect(await Job.findById(job._id)).toBeNull();
    expect(cancelJob).toHaveBeenCalledTimes(1);
    expect(cancelJob.mock.calls[0][0].toString()).toBe(job._id.toString());
    expect(removeJobFolder).toHaveBeenCalledTimes(1);
    expect(removeJobFolder.mock.calls[0][0]._id.toString()).toBe(job._id.toString());
  });

  it("does not delete another user's job", async () => {
    const owner = await createUserAndToken({ username: "own2", email: "own2@example.com" });
    const other = await createUserAndToken({ username: "oth2", email: "oth2@example.com" });
    const job = await makeJob(owner.user._id);
    const res = await agent(app).delete(`/api/jobs/${job._id}`).set(authHeader(other.token));
    expect(res.status).toBe(404);
    expect(await Job.findById(job._id)).not.toBeNull();
  });
});
