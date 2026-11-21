import type { Worker } from "bullmq";

export interface ShutdownOptions {
  signals?: NodeJS.Signals[];
  exit?: (code: number) => void;
  log?: (line: string) => void;
}

// First signal: stop taking jobs and wait for the ones in flight.
// Second signal: give up waiting and close hard.
export function installShutdown(worker: Worker, opts: ShutdownOptions = {}): () => void {
  const signals = opts.signals ?? ["SIGTERM", "SIGINT"];
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((line: string) => console.log(line));
  let closing = false;

  const handler = (signal: NodeJS.Signals) => {
    if (closing) {
      log(`${signal} again, closing without waiting`);
      void worker.close(true).finally(() => exit(1));
      return;
    }
    closing = true;
    log(`${signal} received, finishing in-flight jobs`);
    worker
      .close()
      .then(() => {
        log("drained");
        exit(0);
      })
      .catch((err: unknown) => {
        log(`close failed: ${String(err)}`);
        exit(1);
      });
  };

  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}
