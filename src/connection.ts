import type { ConnectionOptions } from "bullmq";

export function parseRedisUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") {
    throw new Error(`not a redis url: ${url}`);
  }
  const opts: Record<string, unknown> = {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
  };
  if (u.username) opts.username = decodeURIComponent(u.username);
  if (u.password) opts.password = decodeURIComponent(u.password);
  const db = u.pathname.replace(/^\//, "");
  if (db) {
    if (!/^\d+$/.test(db)) throw new Error(`redis db must be a number, got "${db}"`);
    opts.db = Number(db);
  }
  if (u.protocol === "rediss:") opts.tls = {};
  return opts as ConnectionOptions;
}
