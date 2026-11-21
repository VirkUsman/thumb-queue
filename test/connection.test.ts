import { describe, expect, it } from "vitest";
import { parseRedisUrl } from "../src/connection.ts";

describe("parseRedisUrl", () => {
  it("defaults the port", () => {
    expect(parseRedisUrl("redis://cache")).toEqual({ host: "cache", port: 6379 });
  });

  it("reads host and port", () => {
    expect(parseRedisUrl("redis://127.0.0.1:6391")).toEqual({ host: "127.0.0.1", port: 6391 });
  });

  it("reads credentials and decodes them", () => {
    expect(parseRedisUrl("redis://worker:p%40ss@cache:6379")).toMatchObject({
      username: "worker",
      password: "p@ss",
    });
  });

  it("reads the database number", () => {
    expect(parseRedisUrl("redis://cache:6379/3")).toMatchObject({ db: 3 });
  });

  it("rejects a database that is not a number", () => {
    expect(() => parseRedisUrl("redis://cache:6379/main")).toThrow(/number/);
  });

  it("turns on tls for rediss", () => {
    expect(parseRedisUrl("rediss://cache:6380")).toMatchObject({ tls: {} });
  });

  it("rejects other schemes", () => {
    expect(() => parseRedisUrl("https://cache")).toThrow(/not a redis url/);
  });
});
