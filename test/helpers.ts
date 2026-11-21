import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Queue } from "bullmq";
import sharp from "sharp";
import { DEFAULTS, type Settings } from "../src/config.ts";
import { parseRedisUrl } from "../src/connection.ts";
import type { ThumbJob } from "../src/spec.ts";

export const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

export interface Rig {
  settings: Settings;
  dir: string;
  cleanup: () => Promise<void>;
  queues: Queue<ThumbJob>[];
  queue: () => Queue<ThumbJob>;
}

// Every test gets its own queue name and its own folder, so nothing leaks
// between tests and nothing needs flushing in redis.
export async function makeRig(overrides: Partial<Settings> = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "thumb-queue-"));
  const settings: Settings = {
    ...DEFAULTS,
    redisUrl: REDIS_URL,
    queueName: `t-${randomBytes(5).toString("hex")}`,
    outDir: join(dir, "out"),
    backoffMs: 50,
    attempts: 3,
    rateMax: 1000,
    ...overrides,
  };
  const queues: Queue<ThumbJob>[] = [];
  const rig: Rig = {
    settings,
    dir,
    queues,
    queue() {
      const q = new Queue<ThumbJob>(settings.queueName, { connection: parseRedisUrl(settings.redisUrl) });
      queues.push(q);
      return q;
    },
    async cleanup() {
      for (const q of queues) {
        await q.obliterate({ force: true }).catch(() => undefined);
        await q.close();
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
  return rig;
}

export async function makeImage(
  dir: string,
  name: string,
  width: number,
  height: number,
  seed = 0,
  format: "png" | "jpeg" = "png",
): Promise<string> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + seed * 31 + (i % width)) & 255;
  const buf = await sharp(raw, { raw: { width, height, channels: 3 } })
    .toFormat(format)
    .toBuffer();
  const path = join(dir, name);
  await writeFile(path, buf);
  return path;
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 10000, step = 25): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, step));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
