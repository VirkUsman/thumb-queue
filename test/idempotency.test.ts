import { readdir } from "node:fs/promises";
import type { Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeThumbnail } from "../src/processor.ts";
import { enqueueThumbnail } from "../src/queue.ts";
import { createThumbWorker, type Handler } from "../src/worker.ts";
import { makeImage, makeRig, sleep, waitFor, type Rig } from "./helpers.ts";

let rig: Rig;
let workers: Worker[] = [];
beforeEach(async () => {
  rig = await makeRig();
});
afterEach(async () => {
  for (const w of workers) await w.close(true);
  workers = [];
  await rig.cleanup();
});

const spec = { width: 64, height: 64, format: "webp" } as const;
const outputs = async () => (await readdir(rig.settings.outDir).catch(() => [])).filter((n) => !n.endsWith(".tmp"));

describe("one output per upload", () => {
  it("runs the handler once for a file queued twice before the worker starts", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 200, 200);
    let calls = 0;
    const handler: Handler = (job, out) => {
      calls++;
      return makeThumbnail(job, out);
    };
    await enqueueThumbnail(q, rig.settings, file, spec);
    await enqueueThumbnail(q, rig.settings, file, spec);
    workers.push(createThumbWorker(rig.settings, handler));
    await waitFor(async () => (await q.getCompletedCount()) === 1);
    await sleep(200);
    expect(calls).toBe(1);
    expect(await outputs()).toHaveLength(1);
  });

  it("runs the handler once for a second enqueue while the first is running", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 200, 200);
    let calls = 0;
    const handler: Handler = async (job, out) => {
      calls++;
      await sleep(300);
      return makeThumbnail(job, out);
    };
    workers.push(createThumbWorker(rig.settings, handler));
    await enqueueThumbnail(q, rig.settings, file, spec);
    await waitFor(() => calls === 1);
    await enqueueThumbnail(q, rig.settings, file, spec);
    await waitFor(async () => (await q.getCompletedCount()) === 1);
    await sleep(200);
    expect(calls).toBe(1);
    expect(await outputs()).toHaveLength(1);
  });

  it("writes nothing new when the same upload comes again after the first job is gone", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 200, 200);
    const results: boolean[] = [];
    workers.push(
      createThumbWorker(rig.settings, async (job, out) => {
        const r = await makeThumbnail(job, out);
        results.push(r.skipped);
        return r;
      }),
    );
    const id = await enqueueThumbnail(q, rig.settings, file, spec);
    await waitFor(async () => (await q.getCompletedCount()) === 1);
    // Drop the job record, as removeOnComplete does after an hour.
    await (await q.getJob(id))?.remove();
    await enqueueThumbnail(q, rig.settings, file, spec);
    await waitFor(() => results.length === 2);
    expect(results).toEqual([false, true]);
    expect(await outputs()).toHaveLength(1);
  });

  it("keeps one output when two workers share the queue and the file is queued 10 times", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 200, 200);
    let calls = 0;
    const handler: Handler = (job, out) => {
      calls++;
      return makeThumbnail(job, out);
    };
    workers.push(createThumbWorker(rig.settings, handler), createThumbWorker(rig.settings, handler));
    for (let i = 0; i < 10; i++) await enqueueThumbnail(q, rig.settings, file, spec);
    await waitFor(async () => (await q.getCompletedCount()) >= 1);
    await sleep(300);
    expect(calls).toBe(1);
    expect(await outputs()).toHaveLength(1);
  });

  it("makes one output per distinct image and size", async () => {
    const q = rig.queue();
    const a = await makeImage(rig.dir, "a.png", 200, 200, 1);
    const b = await makeImage(rig.dir, "b.png", 200, 200, 2);
    workers.push(createThumbWorker(rig.settings));
    await enqueueThumbnail(q, rig.settings, a, spec);
    await enqueueThumbnail(q, rig.settings, a, { ...spec, format: "jpeg" });
    await enqueueThumbnail(q, rig.settings, b, spec);
    await enqueueThumbnail(q, rig.settings, b, spec);
    await waitFor(async () => (await q.getCompletedCount()) === 3);
    expect(await outputs()).toHaveLength(3);
  });

  it("makes a new output when the file at the same path has new bytes", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 200, 200, 1);
    workers.push(createThumbWorker(rig.settings));
    await enqueueThumbnail(q, rig.settings, file, spec);
    await waitFor(async () => (await q.getCompletedCount()) === 1);
    await makeImage(rig.dir, "a.png", 200, 200, 9);
    await enqueueThumbnail(q, rig.settings, file, spec);
    await waitFor(async () => (await q.getCompletedCount()) === 2);
    expect(await outputs()).toHaveLength(2);
  });
});
