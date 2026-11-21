import { describe, expect, it } from "vitest";
import { DEFAULTS, loadSettings } from "../src/config.ts";

describe("loadSettings", () => {
  it("returns the defaults for an empty environment", () => {
    expect(loadSettings({})).toEqual(DEFAULTS);
  });

  it("reads each variable", () => {
    const s = loadSettings({
      REDIS_URL: "redis://cache:6390/2",
      THUMB_QUEUE: "pics",
      THUMB_OUT_DIR: "/var/thumbs",
      THUMB_CONCURRENCY: "8",
      THUMB_RATE_MAX: "20",
      THUMB_RATE_WINDOW_MS: "2000",
      THUMB_ATTEMPTS: "6",
      THUMB_BACKOFF_MS: "250",
      THUMB_LOCK_MS: "5000",
      THUMB_STALLED_MS: "2500",
      THUMB_SLOW_MS: "10",
    });
    expect(s).toEqual({
      redisUrl: "redis://cache:6390/2",
      queueName: "pics",
      outDir: "/var/thumbs",
      concurrency: 8,
      rateMax: 20,
      rateWindowMs: 2000,
      attempts: 6,
      backoffMs: 250,
      lockDurationMs: 5000,
      stalledIntervalMs: 2500,
      slowMs: 10,
    });
  });

  it("treats an empty string as unset", () => {
    expect(loadSettings({ THUMB_CONCURRENCY: "" }).concurrency).toBe(DEFAULTS.concurrency);
  });

  it("rejects a non numeric count", () => {
    expect(() => loadSettings({ THUMB_CONCURRENCY: "four" })).toThrow(/THUMB_CONCURRENCY/);
  });

  it("rejects a negative number", () => {
    expect(() => loadSettings({ THUMB_ATTEMPTS: "-1" })).toThrow(/whole number/);
  });

  it("rejects a decimal", () => {
    expect(() => loadSettings({ THUMB_RATE_MAX: "2.5" })).toThrow(/whole number/);
  });

  it("rejects concurrency below one", () => {
    expect(() => loadSettings({ THUMB_CONCURRENCY: "0" })).toThrow(/at least 1/);
  });

  it("rejects a lock shorter than 100 ms", () => {
    expect(() => loadSettings({ THUMB_LOCK_MS: "50" })).toThrow(/at least 100/);
  });

  it("rejects a redis url with the wrong scheme", () => {
    expect(() => loadSettings({ REDIS_URL: "http://localhost" })).toThrow(/redis:\/\//);
  });

  it("accepts a tls redis url", () => {
    expect(loadSettings({ REDIS_URL: "rediss://cache:6380" }).redisUrl).toBe("rediss://cache:6380");
  });
});
