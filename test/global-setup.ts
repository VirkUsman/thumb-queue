import { Redis } from "ioredis";

// Without this, a missing redis makes every test hang until its own timeout,
// retrying the connection the whole time. Say so in one line instead.
export default async function setup(): Promise<void> {
  const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.ping();
  } catch {
    throw new Error(`tests need redis, none answering at ${url}. Set REDIS_URL.`);
  } finally {
    client.disconnect();
  }
}
