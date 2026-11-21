import { UnrecoverableError, Worker, type Job } from "bullmq";
import type { Settings } from "./config.ts";
import { parseRedisUrl } from "./connection.ts";
import { makeThumbnail, SourceError, type Outcome } from "./processor.ts";
import type { ThumbJob } from "./spec.ts";

export type Handler = (job: ThumbJob, outDir: string) => Promise<Outcome>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createThumbWorker(settings: Settings, handler: Handler = makeThumbnail): Worker<ThumbJob, Outcome> {
  return new Worker<ThumbJob, Outcome>(
    settings.queueName,
    async (job: Job<ThumbJob, Outcome>) => {
      if (settings.slowMs > 0) await sleep(settings.slowMs);
      try {
        return await handler(job.data, settings.outDir);
      } catch (err) {
        // A missing or changed source will not fix itself on a retry.
        if (err instanceof SourceError) throw new UnrecoverableError(err.message);
        throw err;
      }
    },
    {
      connection: parseRedisUrl(settings.redisUrl),
      concurrency: settings.concurrency,
      limiter: { max: settings.rateMax, duration: settings.rateWindowMs },
      lockDuration: settings.lockDurationMs,
      stalledInterval: settings.stalledIntervalMs,
    },
  );
}
