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

function countIn(starts: number[], from: number, to: number): number {
  return starts.filter((t) => t >= from && t < to).length;
}

function worstSliding(starts: number[], windowMs: number): number {
  let worst = 0;
  for (const s of starts) worst = Math.max(worst, countIn(starts, s, s + windowMs));
  return worst;
}

// bullmq counts jobs in fixed windows that start at the first job, so the
// guarantee is 10 in the first second and, at worst, 10 at the end of one
// window plus 10 at the start of the next in any sliding second.
describe("rate limit", () => {
  beforeEach(async () => {
    rig = await makeRig({ concurrency: 8, rateMax: 10, rateWindowMs: 1000 });
  });

  it("starts at most 10 jobs in the first second, and at most 20 in any second", async () => {
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
    expect(countIn(starts, starts[0]!, starts[0]! + 1000)).toBeLessThanOrEqual(10);
    expect(worstSliding(starts, 1000)).toBeLessThanOrEqual(20);
    // 35 jobs at 10 a window need four windows, so at least three full waits
    expect(elapsed).toBeGreaterThanOrEqual(2900);
  });

  it("is a total across workers, not per worker", async () => {
    const starts: number[] = [];
    const handler = async () => {
      starts.push(Date.now());
      return fakeOutcome;
    };
    workers.push(createThumbWorker(rig.settings, handler), createThumbWorker(rig.settings, handler));
    const t0 = Date.now();
    await addMany(25);
    await waitFor(async () => (await rig.queue().getCompletedCount()) === 25, 20000);
    const elapsed = Date.now() - t0;
    starts.sort((a, b) => a - b);
    expect(countIn(starts, starts[0]!, starts[0]! + 1000)).toBeLessThanOrEqual(10);
    expect(elapsed).toBeGreaterThanOrEqual(1900);
  });
});
