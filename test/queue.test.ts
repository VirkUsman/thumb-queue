import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQueue, enqueueThumbnail, JOB_NAME, listFailed } from "../src/queue.ts";
import { jobKey } from "../src/spec.ts";
import { makeImage, makeRig, type Rig } from "./helpers.ts";

let rig: Rig;
beforeEach(async () => {
  rig = await makeRig();
});
afterEach(async () => {
  await rig.cleanup();
});

const spec = { width: 64, height: 64, format: "webp" } as const;

describe("enqueueThumbnail", () => {
  it("uses the content key as the job id", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 100, 100);
    const id = await enqueueThumbnail(q, rig.settings, file, spec);
    const job = await q.getJob(id);
    expect(job?.id).toBe(id);
    expect(id).toBe(jobKey(job!.data.hash, spec));
  });

  it("stores the absolute path, the hash and the target shape", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 100, 100);
    const job = await q.getJob(await enqueueThumbnail(q, rig.settings, file, spec));
    expect(job?.name).toBe(JOB_NAME);
    expect(job?.data).toMatchObject({ src: file, width: 64, height: 64, format: "webp" });
    expect(job?.data.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sets attempts and exponential backoff on the job", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 100, 100);
    const job = await q.getJob(await enqueueThumbnail(q, rig.settings, file, spec));
    expect(job?.opts.attempts).toBe(3);
    expect(job?.opts.backoff).toEqual({ type: "exponential", delay: 50 });
  });

  it("keeps failed jobs around", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 100, 100);
    const job = await q.getJob(await enqueueThumbnail(q, rig.settings, file, spec));
    expect(job?.opts.removeOnFail).toBe(false);
  });

  it("makes one job for the same file queued twice", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 100, 100);
    const a = await enqueueThumbnail(q, rig.settings, file, spec);
    const b = await enqueueThumbnail(q, rig.settings, file, spec);
    expect(a).toBe(b);
    expect((await q.getJobCounts("waiting")).waiting).toBe(1);
  });

  it("makes one job for two copies of the same bytes under different names", async () => {
    const q = rig.queue();
    const one = await makeImage(rig.dir, "one.png", 100, 100, 5);
    const two = await makeImage(rig.dir, "two.png", 100, 100, 5);
    const a = await enqueueThumbnail(q, rig.settings, one, spec);
    const b = await enqueueThumbnail(q, rig.settings, two, spec);
    expect(a).toBe(b);
    expect((await q.getJobCounts("waiting")).waiting).toBe(1);
  });

  it("makes two jobs for two different images", async () => {
    const q = rig.queue();
    const one = await makeImage(rig.dir, "one.png", 100, 100, 1);
    const two = await makeImage(rig.dir, "two.png", 100, 100, 2);
    await enqueueThumbnail(q, rig.settings, one, spec);
    await enqueueThumbnail(q, rig.settings, two, spec);
    expect((await q.getJobCounts("waiting")).waiting).toBe(2);
  });

  it("makes two jobs for one image at two sizes", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 100, 100);
    await enqueueThumbnail(q, rig.settings, file, spec);
    await enqueueThumbnail(q, rig.settings, file, { ...spec, width: 32, height: 32 });
    expect((await q.getJobCounts("waiting")).waiting).toBe(2);
  });

  it("rejects a bad spec before touching redis", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 100, 100);
    await expect(enqueueThumbnail(q, rig.settings, file, { ...spec, width: 1 })).rejects.toThrow(/width/);
    expect((await q.getJobCounts("waiting")).waiting).toBe(0);
  });

  it("rejects a file that does not exist", async () => {
    const q = rig.queue();
    await expect(enqueueThumbnail(q, rig.settings, `${rig.dir}/missing.png`, spec)).rejects.toThrow(/ENOENT/);
  });

  it("collapses a burst of 20 identical enqueues into one job", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 100, 100);
    await Promise.all(Array.from({ length: 20 }, () => enqueueThumbnail(q, rig.settings, file, spec)));
    expect((await q.getJobCounts("waiting")).waiting).toBe(1);
  });
});

describe("createQueue and listFailed", () => {
  it("opens a queue on the configured name", async () => {
    const q = createQueue(rig.settings);
    rig.queues.push(q);
    expect(q.name).toBe(rig.settings.queueName);
  });

  it("lists nothing when nothing failed", async () => {
    expect(await listFailed(rig.queue())).toEqual([]);
  });
});
