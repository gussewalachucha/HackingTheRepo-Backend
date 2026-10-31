import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Job from "../models/Job.js";
import {
  JobAbortError,
  RECOVERY_MESSAGE,
  createJobQueue,
  recoverInterruptedJobs,
} from "../services/jobQueue.js";
import { clearDb, connectTestDb, createUserAndToken, disconnectTestDb } from "./helpers.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("job queue", () => {
  it("limits concurrency and starts waiting jobs when a worker frees up", async () => {
    const runs = new Map();
    const runner = vi.fn((id) => {
      const d = deferred();
      runs.set(id, d);
      return d.promise;
    });
    const onWait = vi.fn();
    const queue = createJobQueue({ runner, maxConcurrent: 1, timeoutMs: 60000, onWait });

    expect(queue.enqueue("a", "create")).toBe(true);
    expect(queue.enqueue("b", "create")).toBe(true);
    await tick();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0].slice(0, 2)).toEqual(["a", "create"]);
    expect(onWait).toHaveBeenCalledWith("b");
    expect(queue.stats()).toEqual({ active: 1, waiting: 1 });

    runs.get("a").resolve({ ok: true });
    await tick();
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1].slice(0, 2)).toEqual(["b", "create"]);
    runs.get("b").resolve({ ok: true });
    await tick();
    expect(queue.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it("runs a refine pass right after a run that reports a follow-up message", async () => {
    const runner = vi.fn(async (id, mode) => ({ ok: true, followUp: mode === "create" }));
    const onWait = vi.fn();
    const queue = createJobQueue({ runner, maxConcurrent: 2, timeoutMs: 60000, onWait });

    queue.enqueue("a", "create");
    await tick();
    await tick();
    expect(runner.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["a", "create"],
      ["a", "refine"],
    ]);
    expect(onWait).not.toHaveBeenCalled();
    expect(queue.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it("never queues the same job twice, but keeps one follow-up for a running job", async () => {
    const d = deferred();
    const runner = vi.fn(() => d.promise);
    const queue = createJobQueue({ runner, maxConcurrent: 2, timeoutMs: 60000 });

    expect(queue.enqueue("a", "create")).toBe(true);
    await tick();
    expect(queue.enqueue("a", "refine")).toBe(true);
    expect(queue.enqueue("a", "refine")).toBe(false);
    await tick();
    expect(runner).toHaveBeenCalledTimes(1);

    d.resolve();
    await tick();
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1][1]).toBe("refine");
  });

  it("aborts a run that exceeds the job timeout", async () => {
    let signal;
    const runner = vi.fn((_id, _mode, options) => {
      signal = options.signal;
      return new Promise((resolve) => signal.addEventListener("abort", resolve));
    });
    const queue = createJobQueue({ runner, maxConcurrent: 1, timeoutMs: 30 });
    queue.enqueue("slow", "create");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(JobAbortError);
    expect(signal.reason.kind).toBe("timeout");
    expect(queue.stats().active).toBe(0);
  });

  it("cancels waiting and running jobs", async () => {
    let signal;
    const runner = vi.fn((_id, _mode, options) => {
      signal = options.signal;
      return new Promise((resolve) => signal.addEventListener("abort", resolve));
    });
    const queue = createJobQueue({ runner, maxConcurrent: 1, timeoutMs: 60000 });
    queue.enqueue("running", "create");
    queue.enqueue("waiting", "create");
    await tick();

    expect(queue.cancel("waiting")).toBe(true);
    expect(queue.stats().waiting).toBe(0);
    expect(queue.cancel("running")).toBe(true);
    expect(signal.reason.kind).toBe("cancelled");
    await tick();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(queue.cancel("unknown")).toBe(false);
  });

  it("survives a runner that throws and keeps processing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runner = vi
      .fn()
      .mockRejectedValueOnce(new Error("kaboom ghp_" + "x".repeat(36)))
      .mockResolvedValueOnce({ ok: true });
    const queue = createJobQueue({ runner, maxConcurrent: 1, timeoutMs: 60000 });
    queue.enqueue("bad", "create");
    queue.enqueue("good", "create");
    await tick();
    await tick();
    expect(runner).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0].join(" ")).not.toContain("ghp_xxxx");
    errorSpy.mockRestore();
  });
});

describe("recoverInterruptedJobs", () => {
  beforeAll(async () => {
    await connectTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await clearDb();
  });

  it("marks running and queued jobs as failed", async () => {
    const { user } = await createUserAndToken({ username: "recover" });
    const base = { userId: user._id, repoUrl: "https://github.com/a/b", instruction: "x", branchName: "repomind/x", prTitle: "x" };
    const running = await Job.create({ ...base, status: "running" });
    const queued = await Job.create({ ...base, status: "queued", repomindJobId: "legacy" });
    const completed = await Job.create({ ...base, status: "completed" });

    // Jobs touched by the current process (after its start) are left alone.
    expect(await recoverInterruptedJobs()).toBe(0);
    expect((await Job.findById(running._id)).status).toBe("running");

    expect(await recoverInterruptedJobs({ before: new Date(Date.now() + 60000) })).toBe(2);

    for (const id of [running._id, queued._id]) {
      const job = await Job.findById(id);
      expect(job.status).toBe("failed");
      expect(job.errorMessage).toBe(RECOVERY_MESSAGE);
      expect(job.finishedAt).toBeTruthy();
      expect(job.logs.at(-1)).toMatchObject({ step: "error", level: "error", message: RECOVERY_MESSAGE });
    }
    expect((await Job.findById(completed._id)).status).toBe("completed");
  });
});
