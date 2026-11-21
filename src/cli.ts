import { parseArgs } from "node:util";
import { loadSettings } from "./config.ts";
import { createQueue, enqueueThumbnail, listFailed } from "./queue.ts";
import { installShutdown } from "./shutdown.ts";
import { FORMATS, type Format } from "./spec.ts";
import { createThumbWorker } from "./worker.ts";

export interface Parsed {
  command: "worker" | "enqueue" | "failed";
  files: string[];
  width: number;
  height: number;
  format: Format;
}

export function parseCli(argv: string[]): Parsed {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      width: { type: "string", default: "256" },
      height: { type: "string", default: "256" },
      format: { type: "string", default: "webp" },
    },
  });
  const [command, ...files] = positionals;
  if (command !== "worker" && command !== "enqueue" && command !== "failed") {
    throw new Error("usage: cli <worker | enqueue <files...> | failed> [--width N --height N --format webp|jpeg|png]");
  }
  if (command === "enqueue" && files.length === 0) throw new Error("enqueue needs at least one file");
  const format = values.format as string;
  if (!FORMATS.includes(format as Format)) throw new Error(`format must be one of ${FORMATS.join(", ")}`);
  const width = Number(values.width);
  const height = Number(values.height);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error("width and height must be whole numbers");
  return { command, files, width, height, format: format as Format };
}

async function main(): Promise<void> {
  const parsed = parseCli(process.argv.slice(2));
  const settings = loadSettings();
  if (parsed.command === "worker") {
    const worker = createThumbWorker(settings);
    worker.on("failed", (job, err) => console.log(`failed ${job?.id} attempt ${job?.attemptsMade}: ${err.message}`));
    worker.on("completed", (job) => console.log(`done ${job.id}`));
    installShutdown(worker);
    console.log(`worker up on queue ${settings.queueName}`);
    return;
  }
  const queue = createQueue(settings);
  try {
    if (parsed.command === "enqueue") {
      for (const f of parsed.files) {
        const id = await enqueueThumbnail(queue, settings, f, parsed);
        console.log(`queued ${id}`);
      }
    } else {
      for (const j of await listFailed(queue)) console.log(`${j.id}\t${j.attempts}\t${j.reason}`);
    }
  } finally {
    await queue.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
