import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enqueueThumbnail } from "../src/queue.ts";
import { createThumbWorker } from "../src/worker.ts";
import { makeImage, makeRig, waitFor, type Rig } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const spec = { width: 64, height: 64, format: "webp" } as const;

let rig: Rig;
let child: ChildProcess | undefined;
let rescuer: Worker | undefined;
beforeEach(async () => {
  rig = await makeRig({ lockDurationMs: 1000, stalledIntervalMs: 500, concurrency: 1 });
});
afterEach(async () => {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  await rescuer?.close(true);
  await rig.cleanup();
});

function startVictim(): string[] {
  const lines: string[] = [];
  child = spawn("node", ["--experimental-strip-types", "--no-warnings", CLI, "worker"], {
    env: {
      ...process.env,
      REDIS_URL: rig.settings.redisUrl,
      THUMB_QUEUE: rig.settings.queueName,
      THUMB_OUT_DIR: rig.settings.outDir,
      THUMB_CONCURRENCY: "1",
      THUMB_LOCK_MS: "1000",
      THUMB_STALLED_MS: "500",
      THUMB_SLOW_MS: "30000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (b: Buffer) => lines.push(...b.toString().split("\n").filter(Boolean)));
  return lines;
}

describe("a worker killed in the middle of a job", () => {
  it("has its job picked up by another worker and finished once", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 300, 300);
    const lines = startVictim();
    await waitFor(() => lines.some((l) => l.startsWith("worker up")));
    const id = await enqueueThumbnail(q, rig.settings, file, spec);
    await waitFor(async () => (await q.getActiveCount()) === 1);

    const exited = once(child!, "exit");
    child!.kill("SIGKILL");
    await exited;
    // the dead worker still holds the lock, so the job stays active for now
    expect(await q.getActiveCount()).toBe(1);

    let calls = 0;
    rescuer = createThumbWorker(rig.settings, async (job, out) => {
      calls++;
      const { makeThumbnail } = await import("../src/processor.ts");
      return makeThumbnail(job, out);
    });
    await waitFor(async () => (await q.getCompletedCount()) === 1, 15000);
    expect(calls).toBe(1);
    const job = await q.getJob(id);
    expect(job?.stalledCounter).toBeGreaterThanOrEqual(1);
    expect(await q.getFailedCount()).toBe(0);
    expect((await readdir(rig.settings.outDir)).filter((n) => n.endsWith(".webp"))).toHaveLength(1);
  });

  it("is not picked up while its worker is alive and renewing the lock", async () => {
    const q = rig.queue();
    const file = await makeImage(rig.dir, "a.png", 300, 300);
    const lines = startVictim();
    await waitFor(() => lines.some((l) => l.startsWith("worker up")));
    await enqueueThumbnail(q, rig.settings, file, spec);
    await waitFor(async () => (await q.getActiveCount()) === 1);
    let calls = 0;
    rescuer = createThumbWorker(rig.settings, async () => {
      calls++;
      throw new Error("should never run");
    });
    await new Promise((r) => setTimeout(r, 3500));
    expect(calls).toBe(0);
    expect(await q.getActiveCount()).toBe(1);
    const job = (await q.getActive())[0];
    expect(job?.stalledCounter ?? 0).toBe(0);
  });
});
