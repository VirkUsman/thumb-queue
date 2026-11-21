import type { Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enqueueThumbnail, listFailed } from "../src/queue.ts";
import { SourceError } from "../src/processor.ts";
import { makeThumbnail } from "../src/processor.ts";
import { createThumbWorker, type Handler } from "../src/worker.ts";
import { makeImage, makeRig, waitFor, type Rig } from "./helpers.ts";

let rig: Rig;
let worker: Worker | undefined;
beforeEach(async () => {
  rig = await makeRig({ attempts: 4, backoffMs: 100 });
});
afterEach(async () => {
  await worker?.close(true);
  worker = undefined;
  await rig.cleanup();
});

const spec = { width: 64, height: 64, format: "webp" } as const;

describe("retries and the failed set", () => {
  it("retries a failing job with exponential gaps", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 100, 100);
    const starts: number[] = [];
    const handler: Handler = async () => {
      starts.push(Date.now());
      throw new Error("disk full");
    };
    worker = createThumbWorker(rig.settings, handler);
    await enqueueThumbnail(q, rig.settings, file, spec);
    await waitFor(async () => (await q.getFailedCount()) === 1);
    expect(starts).toHaveLength(4);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
    // delays are 100, 200, 400 ms
    expect(gaps[0]).toBeGreaterThanOrEqual(95);
    expect(gaps[1]).toBeGreaterThanOrEqual(195);
    expect(gaps[2]).toBeGreaterThanOrEqual(395);
    expect(gaps[1]!).toBeGreaterThan(gaps[0]!);
    expect(gaps[2]!).toBeGreaterThan(gaps[1]!);
  });

  it("lands in the failed set after the last attempt, with the reason kept", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 100, 100);
    worker = createThumbWorker(rig.settings, async () => {
      throw new Error("encoder crashed on frame 3");
    });
    const id = await enqueueThumbnail(q, rig.settings, file, spec);
    await waitFor(async () => (await q.getFailedCount()) === 1);
    const failed = await listFailed(q);
    expect(failed).toEqual([{ id, reason: "encoder crashed on frame 3", attempts: 4, src: file }]);
  });

  it("does not move a job to failed before the attempts run out", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 100, 100);
    let calls = 0;
    worker = createThumbWorker(rig.settings, async () => {
      calls++;
      throw new Error("nope");
    });
    await enqueueThumbnail(q, rig.settings, file, spec);
    await waitFor(() => calls === 2);
    expect(await q.getFailedCount()).toBe(0);
  });

  it("completes when a later attempt succeeds", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 100, 100);
    let calls = 0;
    worker = createThumbWorker(rig.settings, async (job, outDir) => {
      calls++;
      if (calls < 3) throw new Error("flaky");
      return makeThumbnail(job, outDir);
    });
    const id = await enqueueThumbnail(q, rig.settings, file, spec);
    await waitFor(async () => (await q.getCompletedCount()) === 1);
    const job = await q.getJob(id);
    expect(calls).toBe(3);
    expect(job?.attemptsMade).toBe(3);
    expect(await q.getFailedCount()).toBe(0);
  });

  it("keeps the stack trace of the last failure", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 100, 100);
    worker = createThumbWorker({ ...rig.settings, attempts: 1 }, async () => {
      throw new Error("boom");
    });
    const id = await enqueueThumbnail(q, { ...rig.settings, attempts: 1 }, file, spec);
    await waitFor(async () => (await q.getFailedCount()) === 1);
    const job = await q.getJob(id);
    expect(job?.stacktrace.join("\n")).toContain("boom");
  });

  it("fails a corrupt image through the real processor and keeps sharp's message", async () => {
    const q = rig.queue();
    const { writeFile } = await import("node:fs/promises");
    const file = `${rig.dir}/corrupt.png`;
    await writeFile(file, Buffer.from("not an image at all"));
    worker = createThumbWorker({ ...rig.settings, attempts: 2, backoffMs: 20 });
    await enqueueThumbnail(q, { ...rig.settings, attempts: 2, backoffMs: 20 }, file, spec);
    await waitFor(async () => (await q.getFailedCount()) === 1);
    const [failed] = await listFailed(q);
    expect(failed?.attempts).toBe(2);
    expect(failed?.reason).toMatch(/unsupported image format|Input buffer/i);
  });

  it("does not retry a missing source", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 100, 100);
    let calls = 0;
    worker = createThumbWorker(rig.settings, async (job) => {
      calls++;
      throw new SourceError(`source file is gone: ${job.src}`);
    });
    await enqueueThumbnail(q, rig.settings, file, spec);
    await waitFor(async () => (await q.getFailedCount()) === 1);
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(1);
    const [failed] = await listFailed(q);
    expect(failed?.reason).toMatch(/source file is gone/);
  });

  it("fails a real missing source on the first attempt", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 100, 100);
    worker = createThumbWorker(rig.settings);
    const { rm } = await import("node:fs/promises");
    await worker.pause();
    await enqueueThumbnail(q, rig.settings, file, spec);
    await rm(file);
    worker.resume();
    await waitFor(async () => (await q.getFailedCount()) === 1);
    const [failed] = await listFailed(q);
    expect(failed?.attempts).toBe(1);
  });
});
