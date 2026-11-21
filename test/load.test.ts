import type { Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Outcome } from "../src/processor.ts";
import { JOB_NAME } from "../src/queue.ts";
import type { ThumbJob } from "../src/spec.ts";
import { createThumbWorker } from "../src/worker.ts";
import { makeRig, sleep, waitFor, type Rig } from "./helpers.ts";

let rig: Rig;
let workers: Worker[] = [];
afterEach(async () => {
  for (const w of workers) await w.close(true);
  workers = [];
  await rig?.cleanup();
});

const fakeOutcome: Outcome = { output: "x", bytes: 1, skipped: false };

async function addMany(n: number): Promise<void> {
  const q = rig.queue();
  await q.addBulk(
    Array.from({ length: n }, (_, i) => ({
      name: JOB_NAME,
      data: { src: "x", hash: `hash-${i}`, width: 64, height: 64, format: "webp" } as ThumbJob,
      opts: { jobId: `job-${i}` },
    })),
  );
}

describe("concurrency", () => {
  beforeEach(async () => {
    rig = await makeRig({ concurrency: 5 });
  });

  it("never runs more than the configured number at once, and does reach it", async () => {
    let inFlight = 0;
    let peak = 0;
    workers.push(
      createThumbWorker(rig.settings, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(40);
        inFlight--;
        return fakeOutcome;
      }),
    );
    await addMany(60);
    await waitFor(async () => (await rig.queue().getCompletedCount()) === 60, 20000);
    expect(peak).toBe(5);
  });

  it("finishes every job exactly once under load", async () => {
    const seen = new Map<string, number>();
    workers.push(
      createThumbWorker(rig.settings, async (job) => {
        seen.set(job.hash, (seen.get(job.hash) ?? 0) + 1);
        await sleep(5);
        return fakeOutcome;
      }),
    );
    await addMany(100);
    await waitFor(async () => (await rig.queue().getCompletedCount()) === 100, 20000);
    expect(seen.size).toBe(100);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });

  it("holds the limit across two workers that share a queue", async () => {
    // The concurrency setting is per worker, so two workers of 5 may reach 10.
    let inFlight = 0;
    let peak = 0;
    const handler = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(40);
      inFlight--;
      return fakeOutcome;
    };
    workers.push(createThumbWorker(rig.settings, handler), createThumbWorker(rig.settings, handler));
    await addMany(80);
    await waitFor(async () => (await rig.queue().getCompletedCount()) === 80, 20000);
    expect(peak).toBeLessThanOrEqual(10);
    expect(peak).toBeGreaterThan(5);
  });
});

describe("rate limit", () => {
  beforeEach(async () => {
    rig = await makeRig({ concurrency: 8, rateMax: 10, rateWindowMs: 1000 });
  });

  it("starts at most 10 jobs in any one second window", async () => {
    const starts: number[] = [];
    workers.push(
      createThumbWorker(rig.settings, async () => {
        starts.push(Date.now());
        return fakeOutcome;
      }),
    );
    const t0 = Date.now();
    await addMany(35);
    await waitFor(async () => (await rig.queue().getCompletedCount()) === 35, 20000);
    const elapsed = Date.now() - t0;
    starts.sort((a, b) => a - b);
    let worst = 0;
    for (let i = 0; i < starts.length; i++) {
      const inWindow = starts.filter((t) => t >= starts[i]! && t < starts[i]! + 1000).length;
      worst = Math.max(worst, inWindow);
    }
    expect(worst).toBeLessThanOrEqual(10);
    // 35 jobs at 10 a second cannot finish in under three windows
    expect(elapsed).toBeGreaterThanOrEqual(2900);
  });
});
