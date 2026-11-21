import { describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.ts";

describe("parseCli", () => {
  it("parses the worker command", () => {
    expect(parseCli(["worker"]).command).toBe("worker");
  });

  it("parses enqueue with files and defaults", () => {
    expect(parseCli(["enqueue", "a.png", "b.png"])).toEqual({
      command: "enqueue",
      files: ["a.png", "b.png"],
      width: 256,
      height: 256,
      format: "webp",
    });
  });

  it("reads size and format flags", () => {
    const p = parseCli(["enqueue", "a.png", "--width", "320", "--height", "180", "--format", "jpeg"]);
    expect([p.width, p.height, p.format]).toEqual([320, 180, "jpeg"]);
  });

  it("parses failed", () => {
    expect(parseCli(["failed"]).command).toBe("failed");
  });

  it("refuses enqueue with no files", () => {
    expect(() => parseCli(["enqueue"])).toThrow(/at least one file/);
  });

  it("refuses an unknown command", () => {
    expect(() => parseCli(["purge"])).toThrow(/usage/);
  });

  it("refuses an unknown format", () => {
    expect(() => parseCli(["enqueue", "a.png", "--format", "gif"])).toThrow(/format/);
  });

  it("refuses a width that is not a number", () => {
    expect(() => parseCli(["enqueue", "a.png", "--width", "wide"])).toThrow(/whole numbers/);
  });
});
