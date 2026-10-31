// Routes + the real in-process queue, with only the pipeline itself mocked.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../services/prPipeline.js", () => ({
  runPipeline: vi.fn(),
  removeJobWorkspace: vi.fn(async () => {}),
}));

import app from "../index.js";
import Job from "../models/Job.js";
import { runPipeline } from "../services/prPipeline.js";
import {
  agent,
  authHeader,
  connectTestDb,
  createUserAndToken,
  disconnectTestDb,
} from "./helpers.js";

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `check` stops throwing (real MongoDB writes are async). */
async function waitFor(check, timeoutMs = 10000) {
  const started = Date.now();
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (Date.now() - started > timeoutMs) throw err;
      await tick(25);
    }
  }
}

beforeAll(async () => {
  await connectTestDb();
  process.env.PR_MAX_CONCURRENT_JOBS = "1";
});

afterAll(async () => {
  delete process.env.PR_MAX_CONCURRENT_JOBS;
  await disconnectTestDb();
});

describe("job queue wiring", () => {
  it("runs jobs one at a time, logs waiting jobs and cancels deleted ones", async () => {
    const releases = [];
    const signals = new Map();
    runPipeline.mockImplementation((jobId, _mode, options) => {
      signals.set(String(jobId), options.signal);
      return new Promise((resolve) => {
        releases.push(resolve);
        options.signal.addEventListener("abort", () => resolve({ ok: false }));
      });
    });
    process.env.GROQ_API_KEY = "gsk_server";
    const { token } = await createUserAndToken({ username: "queuewire" });
    const create = (instruction) =>
      agent(app)
        .post("/api/jobs")
        .set(authHeader(token))
        .send({ repoUrl: "https://github.com/a/b", instruction });

    const first = await create("first job");
    const second = await create("second job");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    await waitFor(() => expect(runPipeline).toHaveBeenCalledTimes(1));
    expect(runPipeline.mock.calls[0][0]).toBe(first.body._id);
    expect(runPipeline.mock.calls[0][1]).toBe("create");
    expect(runPipeline.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);

    await waitFor(async () => {
      const waiting = await Job.findById(second.body._id);
      expect(waiting.status).toBe("queued");
      expect(waiting.logs.map((entry) => entry.message)).toContain("Waiting for a free worker…");
    });
    await tick();
    expect(runPipeline).toHaveBeenCalledTimes(1);

    releases[0]({ ok: true });
    await waitFor(() => expect(runPipeline).toHaveBeenCalledTimes(2));
    expect(runPipeline.mock.calls[1][0]).toBe(second.body._id);

    const del = await agent(app).delete(`/api/jobs/${second.body._id}`).set(authHeader(token));
    expect(del.status).toBe(200);
    const signal = signals.get(second.body._id);
    expect(signal.aborted).toBe(true);
    expect(signal.reason.kind).toBe("cancelled");
    await tick();
  });
});
