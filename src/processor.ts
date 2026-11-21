import { randomBytes } from "node:crypto";
import { access, readFile, rename, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { contentHash, jobKey, type ThumbJob } from "./spec.ts";

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

export interface Outcome {
  output: string;
  bytes: number;
  skipped: boolean;
}

export function outputPath(outDir: string, job: ThumbJob): string {
  return join(outDir, `${jobKey(job.hash, job)}.${job.format}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function makeThumbnail(job: ThumbJob, outDir: string): Promise<Outcome> {
  const output = outputPath(outDir, job);
  if (await exists(output)) {
    return { output, bytes: 0, skipped: true };
  }

  let data: Buffer;
  try {
    data = await readFile(job.src);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SourceError(`source file is gone: ${job.src}`);
    }
    throw err;
  }
  if (contentHash(data) !== job.hash) {
    throw new SourceError(`source changed since it was queued: ${job.src}`);
  }

  const thumb = await sharp(data)
    .rotate()
    .resize({ width: job.width, height: job.height, fit: "inside", withoutEnlargement: true })
    .toFormat(job.format)
    .toBuffer();

  await mkdir(outDir, { recursive: true });
  // Write beside the target and rename, so a reader never sees half a file
  // and two workers racing on one key cannot interleave their bytes.
  const tmp = `${output}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, thumb);
    await rename(tmp, output);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return { output, bytes: thumb.length, skipped: false };
}
