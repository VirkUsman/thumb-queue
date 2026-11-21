export interface Settings {
  redisUrl: string;
  queueName: string;
  outDir: string;
  concurrency: number;
  rateMax: number;
  rateWindowMs: number;
  attempts: number;
  backoffMs: number;
  lockDurationMs: number;
  stalledIntervalMs: number;
  slowMs: number;
}

export const DEFAULTS: Settings = {
  redisUrl: "redis://127.0.0.1:6379",
  queueName: "thumbnails",
  outDir: "./thumbs",
  concurrency: 4,
  rateMax: 50,
  rateWindowMs: 1000,
  attempts: 4,
  backoffMs: 500,
  lockDurationMs: 30000,
  stalledIntervalMs: 30000,
  slowMs: 0,
};

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a whole number, got "${raw}"`);
  const n = Number(raw);
  if (n < min) throw new Error(`${key} must be at least ${min}, got ${n}`);
  return n;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const redisUrl = env.REDIS_URL || DEFAULTS.redisUrl;
  if (!/^rediss?:\/\//.test(redisUrl)) throw new Error(`REDIS_URL must start with redis:// or rediss://`);
  return {
    redisUrl,
    queueName: env.THUMB_QUEUE || DEFAULTS.queueName,
    outDir: env.THUMB_OUT_DIR || DEFAULTS.outDir,
    concurrency: int(env, "THUMB_CONCURRENCY", DEFAULTS.concurrency, 1),
    rateMax: int(env, "THUMB_RATE_MAX", DEFAULTS.rateMax, 1),
    rateWindowMs: int(env, "THUMB_RATE_WINDOW_MS", DEFAULTS.rateWindowMs, 1),
    attempts: int(env, "THUMB_ATTEMPTS", DEFAULTS.attempts, 1),
    backoffMs: int(env, "THUMB_BACKOFF_MS", DEFAULTS.backoffMs, 1),
    lockDurationMs: int(env, "THUMB_LOCK_MS", DEFAULTS.lockDurationMs, 100),
    stalledIntervalMs: int(env, "THUMB_STALLED_MS", DEFAULTS.stalledIntervalMs, 100),
    slowMs: int(env, "THUMB_SLOW_MS", DEFAULTS.slowMs, 0),
  };
}
