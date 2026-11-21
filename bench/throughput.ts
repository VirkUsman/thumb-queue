// Times real thumbnails end to end: enqueue, redis, worker, sharp, disk.
//   REDIS_URL=redis://127.0.0.1:6379 npm run bench
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { DEFAULTS, type Settings } from "../src/config.ts";
import { createQueue, enqueueThumbnail } from "../src/queue.ts";
import { createThumbWorker } from "../src/worker.ts";

const JOBS = Number(process.env.BENCH_JOBS ?? 200);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 4);

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "thumb-bench-"));
  const settings: Settings = {
    ...DEFAULTS,
    redisUrl: process.env.REDIS_URL ?? DEFAULTS.redisUrl,
    queueName: `bench-${randomBytes(4).toString("hex")}`,
    outDir: join(dir, "out"),
    concurrency: CONCURRENCY,
    rateMax: 100000,
  };

  const files: string[] = [];
  const w = 1600;
  const h = 1200;
  for (let i = 0; i < JOBS; i++) {
    const raw = Buffer.alloc(w * h * 3);
    for (let p = 0; p < raw.length; p += 3) {
      raw[p] = (p / 3 + i * 13) & 255;
      raw[p + 1] = ((p / 3 / w) | 0) + i;
      raw[p + 2] = (i * 29) & 255;
    }
    const file = join(dir, `src-${i}.jpg`);
    await writeFile(file, await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 85 }).toBuffer());
    files.push(file);
  }

  const queue = createQueue(settings);
  const worker = createThumbWorker(settings);
  await worker.waitUntilReady();
  const t0 = performance.now();
  for (const f of files) await enqueueThumbnail(queue, settings, f, { width: 256, height: 256, format: "webp" });
  while ((await queue.getCompletedCount()) < JOBS) await new Promise((r) => setTimeout(r, 20));
  const ms = performance.now() - t0;

  console.log(`${JOBS} thumbnails from ${w}x${h} jpeg in ${ms.toFixed(0)} ms`);
  console.log(`${((JOBS / ms) * 1000).toFixed(1)} jobs per second at concurrency ${CONCURRENCY} on ${cpus().length} cores`);

  await worker.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await rm(dir, { recursive: true, force: true });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
