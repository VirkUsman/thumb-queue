import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readdir } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enqueueThumbnail } from "../src/queue.ts";
import { installShutdown } from "../src/shutdown.ts";
import { createThumbWorker } from "../src/worker.ts";
import { makeImage, makeRig, sleep, waitFor, type Rig } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const spec = { width: 64, height: 64, format: "webp" } as const;

let rig: Rig;
let children: ChildProcess[] = [];
let workers: Worker[] = [];
beforeEach(async () => {
  rig = await makeRig({ concurrency: 1 });
});
afterEach(async () => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  children = [];
  for (const w of workers) await w.close(true);
  workers = [];
  await rig.cleanup();
});

function startChild(extra: Record<string, string> = {}): { child: ChildProcess; lines: string[]; exited: Promise<number | null> } {
  const lines: string[] = [];
  const child = spawn("node", ["--experimental-strip-types", "--no-warnings", CLI, "worker"], {
    env: {
      ...process.env,
      REDIS_URL: rig.settings.redisUrl,
      THUMB_QUEUE: rig.settings.queueName,
      THUMB_OUT_DIR: rig.settings.outDir,
      THUMB_CONCURRENCY: "1",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout?.on("data", (b: Buffer) => lines.push(...b.toString().split("\n").filter(Boolean)));
  child.stderr?.on("data", (b: Buffer) => lines.push(...b.toString().split("\n").filter(Boolean)));
  const exited = once(child, "exit").then(([code]) => code as number | null);
  return { child, lines, exited };
}

describe("shutdown handler, in process", () => {
  it("closes the worker on the first signal and exits 0", async () => {
    const emitter = new EventEmitter();
    const exits: number[] = [];
    const logs: string[] = [];
    let closed = 0;
    const fake = { close: async () => void closed++ } as unknown as Worker;
    const realOn = process.on.bind(process);
    const realOff = process.off.bind(process);
    process.on = emitter.on.bind(emitter) as typeof process.on;
    process.off = emitter.off.bind(emitter) as typeof process.off;
    try {
      const dispose = installShutdown(fake, { exit: (c) => exits.push(c), log: (l) => logs.push(l) });
      emitter.emit("SIGTERM", "SIGTERM");
      await waitFor(() => exits.length === 1);
      dispose();
      expect(closed).toBe(1);
      expect(exits).toEqual([0]);
      expect(logs[0]).toMatch(/finishing in-flight/);
      expect(emitter.listenerCount("SIGTERM")).toBe(0);
    } finally {
      process.on = realOn;
      process.off = realOff;
    }
  });

  it("closes hard and exits 1 on a second signal", async () => {
    const emitter = new EventEmitter();
    const exits: number[] = [];
    const calls: boolean[] = [];
    const fake = {
      close: (force?: boolean) => {
        calls.push(force === true);
        return force ? Promise.resolve() : new Promise<void>(() => undefined);
      },
    } as unknown as Worker;
    const realOn = process.on.bind(process);
    const realOff = process.off.bind(process);
    process.on = emitter.on.bind(emitter) as typeof process.on;
    process.off = emitter.off.bind(emitter) as typeof process.off;
    try {
      const dispose = installShutdown(fake, { exit: (c) => exits.push(c), log: () => undefined });
      emitter.emit("SIGTERM", "SIGTERM");
      emitter.emit("SIGTERM", "SIGTERM");
      await waitFor(() => exits.length === 1);
      dispose();
      expect(calls).toEqual([false, true]);
      expect(exits).toEqual([1]);
    } finally {
      process.on = realOn;
      process.off = realOff;
    }
  });

  it("exits 1 when close rejects", async () => {
    const emitter = new EventEmitter();
    const exits: number[] = [];
    const fake = { close: () => Promise.reject(new Error("redis gone")) } as unknown as Worker;
    const realOn = process.on.bind(process);
    const realOff = process.off.bind(process);
    process.on = emitter.on.bind(emitter) as typeof process.on;
    process.off = emitter.off.bind(emitter) as typeof process.off;
    try {
      const dispose = installShutdown(fake, { exit: (c) => exits.push(c), log: () => undefined });
      emitter.emit("SIGINT", "SIGINT");
      await waitFor(() => exits.length === 1);
      dispose();
      expect(exits).toEqual([1]);
    } finally {
      process.on = realOn;
      process.off = realOff;
    }
  });
});

describe("SIGTERM to a real worker process", () => {
  it("finishes the job in flight, takes no new one, and exits 0", async () => {
    const q = rig.queue();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const f = await makeImage(rig.dir, `p${i}.png`, 200, 200, i + 1);
      ids.push(await enqueueThumbnail(q, rig.settings, f, spec));
    }
    const { child, lines, exited } = startChild({ THUMB_SLOW_MS: "1500" });
    await waitFor(() => lines.some((l) => l.startsWith("worker up")));
    await waitFor(async () => (await q.getActiveCount()) === 1);
    const t0 = Date.now();
    child.kill("SIGTERM");
    const code = await exited;
    const took = Date.now() - t0;
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("finishing in-flight"))).toBe(true);
    expect(lines.some((l) => l === "drained")).toBe(true);
    // it waited for the 1.5 s job instead of dropping it
    expect(took).toBeGreaterThan(500);
    const counts = await q.getJobCounts("completed", "waiting", "active", "failed");
    expect(counts).toMatchObject({ completed: 1, waiting: 2, active: 0, failed: 0 });
    expect((await readdir(rig.settings.outDir)).filter((n) => n.endsWith(".webp"))).toHaveLength(1);
    expect(await q.getJob(ids[0]!)).toBeTruthy();
  });

  it("exits at once when it is idle", async () => {
    const { child, lines, exited } = startChild();
    await waitFor(() => lines.some((l) => l.startsWith("worker up")));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  });

  it("lets the job it drained be picked up cleanly by the next worker", async () => {
    const q = rig.queue();
    for (let i = 0; i < 2; i++) {
      const f = await makeImage(rig.dir, `p${i}.png`, 200, 200, i + 1);
      await enqueueThumbnail(q, rig.settings, f, spec);
    }
    const { child, lines, exited } = startChild({ THUMB_SLOW_MS: "800" });
    await waitFor(() => lines.some((l) => l.startsWith("worker up")));
    await waitFor(async () => (await q.getActiveCount()) === 1);
    child.kill("SIGTERM");
    await exited;
    workers.push(createThumbWorker(rig.settings));
    await waitFor(async () => (await q.getCompletedCount()) === 2);
    expect(await q.getFailedCount()).toBe(0);
    await sleep(50);
  });
});
