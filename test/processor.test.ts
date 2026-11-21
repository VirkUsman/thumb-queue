import { readdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeThumbnail, outputPath, SourceError } from "../src/processor.ts";
import { contentHash, type ThumbJob } from "../src/spec.ts";
import { makeImage, makeRig, type Rig } from "./helpers.ts";

let rig: Rig;
beforeEach(async () => {
  rig = await makeRig();
});
afterEach(async () => {
  await rig.cleanup();
});

async function jobFor(file: string, width = 100, height = 100, format: ThumbJob["format"] = "webp"): Promise<ThumbJob> {
  return { src: file, hash: contentHash(await readFile(file)), width, height, format };
}

describe("makeThumbnail", () => {
  it("fits a wide image inside the box and keeps its ratio", async () => {
    const file = await makeImage(rig.dir, "wide.png", 400, 200);
    const out = await makeThumbnail(await jobFor(file, 100, 100), rig.settings.outDir);
    const meta = await sharp(out.output).metadata();
    expect([meta.width, meta.height]).toEqual([100, 50]);
  });

  it("fits a tall image inside the box", async () => {
    const file = await makeImage(rig.dir, "tall.png", 200, 400);
    const out = await makeThumbnail(await jobFor(file, 100, 100), rig.settings.outDir);
    const meta = await sharp(out.output).metadata();
    expect([meta.width, meta.height]).toEqual([50, 100]);
  });

  it("does not enlarge a small image", async () => {
    const file = await makeImage(rig.dir, "small.png", 40, 30);
    const out = await makeThumbnail(await jobFor(file, 100, 100), rig.settings.outDir);
    const meta = await sharp(out.output).metadata();
    expect([meta.width, meta.height]).toEqual([40, 30]);
  });

  it.each(["webp", "jpeg", "png"] as const)("writes %s", async (format) => {
    const file = await makeImage(rig.dir, "in.png", 120, 120);
    const out = await makeThumbnail(await jobFor(file, 64, 64, format), rig.settings.outDir);
    const meta = await sharp(out.output).metadata();
    expect(meta.format).toBe(format);
    expect(out.output.endsWith(`.${format}`)).toBe(true);
  });

  it("accepts a jpeg source", async () => {
    const file = await makeImage(rig.dir, "in.jpg", 300, 200, 1, "jpeg");
    const out = await makeThumbnail(await jobFor(file, 150, 150), rig.settings.outDir);
    expect((await sharp(out.output).metadata()).width).toBe(150);
  });

  it("applies the exif orientation before resizing", async () => {
    const raw = Buffer.alloc(200 * 100 * 3, 128);
    const buf = await sharp(raw, { raw: { width: 200, height: 100, channels: 3 } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const file = `${rig.dir}/rotated.jpg`;
    await writeFile(file, buf);
    const out = await makeThumbnail(await jobFor(file, 400, 400, "png"), rig.settings.outDir);
    const meta = await sharp(out.output).metadata();
    expect([meta.width, meta.height]).toEqual([100, 200]);
  });

  it("reports the byte size it wrote", async () => {
    const file = await makeImage(rig.dir, "in.png", 200, 200);
    const out = await makeThumbnail(await jobFor(file), rig.settings.outDir);
    expect(out.skipped).toBe(false);
    expect(out.bytes).toBeGreaterThan(0);
    expect((await readFile(out.output)).length).toBe(out.bytes);
  });

  it("skips when the output file already exists", async () => {
    const file = await makeImage(rig.dir, "in.png", 200, 200);
    const job = await jobFor(file);
    const first = await makeThumbnail(job, rig.settings.outDir);
    const second = await makeThumbnail(job, rig.settings.outDir);
    expect(first.skipped).toBe(false);
    expect(second).toEqual({ output: first.output, bytes: 0, skipped: true });
  });

  it("does not even read the source when the output exists", async () => {
    const file = await makeImage(rig.dir, "in.png", 200, 200);
    const job = await jobFor(file);
    await makeThumbnail(job, rig.settings.outDir);
    const second = await makeThumbnail({ ...job, src: "/no/such/file.png" }, rig.settings.outDir);
    expect(second.skipped).toBe(true);
  });

  it("names the output from the key", async () => {
    const file = await makeImage(rig.dir, "in.png", 200, 200);
    const job = await jobFor(file, 64, 48, "jpeg");
    expect(outputPath("/o", job)).toBe(`/o/${job.hash.slice(0, 32)}-64x48-jpeg.jpeg`);
  });

  it("raises a SourceError for a missing file", async () => {
    const job: ThumbJob = { src: `${rig.dir}/gone.png`, hash: "0".repeat(64), width: 64, height: 64, format: "webp" };
    await expect(makeThumbnail(job, rig.settings.outDir)).rejects.toBeInstanceOf(SourceError);
  });

  it("raises a SourceError when the file changed after it was queued", async () => {
    const file = await makeImage(rig.dir, "in.png", 200, 200, 1);
    const job = await jobFor(file);
    await makeImage(rig.dir, "in.png", 200, 200, 2);
    await expect(makeThumbnail(job, rig.settings.outDir)).rejects.toThrow(/changed since it was queued/);
  });

  it("fails on bytes that are not an image, and leaves no file behind", async () => {
    const file = `${rig.dir}/not-an-image.png`;
    await writeFile(file, "this is text");
    await expect(makeThumbnail(await jobFor(file), rig.settings.outDir)).rejects.toThrow();
    const left = await readdir(rig.settings.outDir).catch(() => []);
    expect(left).toEqual([]);
  });

  it("leaves no temp files after a good run", async () => {
    const file = await makeImage(rig.dir, "in.png", 200, 200);
    await makeThumbnail(await jobFor(file), rig.settings.outDir);
    const names = await readdir(rig.settings.outDir);
    expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(names).toHaveLength(1);
  });

  it("gives a readable file when two calls race on one key", async () => {
    const file = await makeImage(rig.dir, "in.png", 300, 300);
    const job = await jobFor(file);
    const [a, b] = await Promise.all([makeThumbnail(job, rig.settings.outDir), makeThumbnail(job, rig.settings.outDir)]);
    expect(a.output).toBe(b.output);
    const meta = await sharp(a.output).metadata();
    expect(meta.width).toBe(100);
    expect((await readdir(rig.settings.outDir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});
