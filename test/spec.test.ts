import { describe, expect, it } from "vitest";
import { contentHash, jobKey, validateSpec } from "../src/spec.ts";

const spec = { width: 200, height: 100, format: "webp" } as const;

describe("contentHash", () => {
  it("is the sha256 of the bytes", () => {
    expect(contentHash(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("changes when one byte changes", () => {
    expect(contentHash(Buffer.from([1, 2, 3]))).not.toBe(contentHash(Buffer.from([1, 2, 4])));
  });

  it("is the same for equal bytes in different buffers", () => {
    expect(contentHash(Buffer.from("same"))).toBe(contentHash(new Uint8Array(Buffer.from("same"))));
  });
});

describe("jobKey", () => {
  const hash = "a".repeat(64);

  it("carries the hash prefix, the size and the format", () => {
    expect(jobKey(hash, spec)).toBe(`${"a".repeat(32)}-200x100-webp`);
  });

  it("differs by format", () => {
    expect(jobKey(hash, spec)).not.toBe(jobKey(hash, { ...spec, format: "jpeg" }));
  });

  it("differs by size", () => {
    expect(jobKey(hash, spec)).not.toBe(jobKey(hash, { ...spec, width: 201 }));
  });

  it("holds no colon, which a bullmq job id may not contain", () => {
    expect(jobKey(hash, spec)).not.toContain(":");
  });
});

describe("validateSpec", () => {
  it("returns a good spec untouched", () => {
    expect(validateSpec(spec)).toBe(spec);
  });

  it("refuses a width under 16", () => {
    expect(() => validateSpec({ ...spec, width: 15 })).toThrow(/width/);
  });

  it("refuses a height over 4096", () => {
    expect(() => validateSpec({ ...spec, height: 4097 })).toThrow(/height/);
  });

  it("refuses a fractional size", () => {
    expect(() => validateSpec({ ...spec, width: 20.5 })).toThrow(/whole number/);
  });

  it("refuses an unknown format", () => {
    expect(() => validateSpec({ ...spec, format: "gif" as never })).toThrow(/format/);
  });
});
