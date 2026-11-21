import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Queue } from "bullmq";
import type { Settings } from "./config.ts";
import { parseRedisUrl } from "./connection.ts";
import { contentHash, jobKey, validateSpec, type ThumbJob, type ThumbSpec } from "./spec.ts";

export const JOB_NAME = "thumbnail";

export function createQueue(settings: Settings): Queue<ThumbJob> {
  return new Queue<ThumbJob>(settings.queueName, {
    connection: parseRedisUrl(settings.redisUrl),
  });
}

export async function enqueueThumbnail(
  queue: Queue<ThumbJob>,
  settings: Pick<Settings, "attempts" | "backoffMs">,
  file: string,
  spec: ThumbSpec,
): Promise<string> {
  validateSpec(spec);
  const src = resolve(file);
  const hash = contentHash(await readFile(src));
  const jobId = jobKey(hash, spec);
  await queue.add(
    JOB_NAME,
    { src, hash, ...spec },
    {
      jobId,
      attempts: settings.attempts,
      backoff: { type: "exponential", delay: settings.backoffMs },
      removeOnComplete: { age: 3600 },
      removeOnFail: false,
    },
  );
  return jobId;
}

export interface FailedJob {
  id: string;
  reason: string;
  attempts: number;
  src: string;
}

export async function listFailed(queue: Queue<ThumbJob>): Promise<FailedJob[]> {
  const jobs = await queue.getFailed(0, 999);
  return jobs.map((j) => ({
    id: j.id ?? "",
    reason: j.failedReason ?? "",
    attempts: j.attemptsMade,
    src: j.data.src,
  }));
}
