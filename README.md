# thumb-queue

_Built with AI assistance._

A worker that reads image files off a Redis queue and writes thumbnails. It is
a BullMQ queue, a worker built on sharp, and a command line to feed and watch
it. The interesting part is what happens when things go wrong: a job fails, the
same upload is queued twice, the process gets SIGTERM, a worker is killed with
`kill -9` halfway through a job.

TypeScript in strict mode, Node 24, BullMQ 6, ioredis, sharp. 94 tests, 11
files, about 20 seconds against a local Redis.

## What a job is

Queueing a file hashes its bytes (sha256) and builds a job id from the first 32
hex characters of the hash, the target size and the format:

    3f9c...e1-256x256-webp

The id is the whole idempotency story. BullMQ ignores an `add` whose id already
exists, so the same bytes queued twice, from two paths or from two callers at
once, are one job. If the job record has already been removed, the worker still
finds `<key>.webp` on disk and returns without decoding anything.

The worker re-hashes the source before it decodes it. A file replaced after it
was queued fails as "changed since it was queued" and is not retried, because
a retry would only fail again.

```
src/spec.ts        sizes, formats, content hash, job key
src/processor.ts   sharp, temp file then rename
src/queue.ts       enqueue, list failed
src/worker.ts      concurrency, rate limit, lock and stall settings
src/shutdown.ts    first signal drains, second signal closes hard
src/cli.ts         worker | enqueue <files> | failed
bench/             throughput script
```

## Five behaviours, and the test that holds each one

| Behaviour | How the test proves it |
|---|---|
| Failures retry with exponential backoff | A handler that always throws is timed. With a 100 ms base the gaps between the four attempts are at least 100, 200 and 400 ms |
| After the last attempt the job sits in the failed set with its reason | `listFailed` returns the id, the attempt count and the exact error text, and the stack trace is still on the job |
| The same upload gives one output | 20 concurrent enqueues make one job. Ten enqueues across two workers run the handler once and leave one file |
| SIGTERM drains | A child process with a 1.5 s job in flight gets SIGTERM. It exits 0 after the job finishes, and the two jobs behind it are still waiting |
| A killed worker's job is finished by another worker | The child is `kill -9`'d while the job is active. A second worker with a 1 s lock picks it up when the lock expires, runs it once, and the job's stalled counter is 1 |

Concurrency and rate are checked under load with 60 to 100 jobs and a fake
handler: the peak number in flight equals the configured 5 and never goes
over, every job runs once, and with a limit of 10 per second the first second
holds at most 10 starts.

## Throughput, measured

`npm run bench` queues 200 JPEGs of 1600x1200, generated in code, and times the
whole path to 256 px WebP: enqueue, Redis, worker, sharp, disk write.

| Concurrency | Jobs per second | Runs |
|---|---|---|
| 4 | 363 and 324 | 551 ms and 617 ms for 200 jobs |
| 1 | 107 | 1875 ms for 200 jobs |

(M), one Mac with 10 cores and a local Redis. Sharp does the decoding on
libuv's thread pool, so the gain from 1 to 4 is a little over three times.
The numbers say nothing about a network Redis.

## Try it

You need Node 22 or newer and a Redis you can reach.

    npm ci
    export REDIS_URL=redis://127.0.0.1:6379
    npm test
    node --experimental-strip-types src/cli.ts worker
    node --experimental-strip-types src/cli.ts enqueue photo.jpg --width 320 --height 240
    node --experimental-strip-types src/cli.ts failed

The tests need Redis and say so in one line when it is missing. They give
every test its own queue name, so a shared development Redis is safe, and
they clean up what they create. `npm run build` compiles to `dist/`.

| Variable | Default | Meaning |
|---|---|---|
| `REDIS_URL` | `redis://127.0.0.1:6379` | where the queue lives |
| `THUMB_QUEUE` | `thumbnails` | queue name |
| `THUMB_OUT_DIR` | `./thumbs` | where thumbnails are written |
| `THUMB_CONCURRENCY` | 4 | jobs in flight per worker |
| `THUMB_RATE_MAX`, `THUMB_RATE_WINDOW_MS` | 50, 1000 | starts per window, across all workers |
| `THUMB_ATTEMPTS`, `THUMB_BACKOFF_MS` | 4, 500 | tries per job and the first retry delay |
| `THUMB_LOCK_MS`, `THUMB_STALLED_MS` | 30000, 30000 | how long a dead worker holds a job |
| `THUMB_SLOW_MS` | 0 | sleep before each job, used by the shutdown and stall tests |

## Two things that went wrong on the way

**The rate limit test assumed the wrong window.** It asserted that no sliding
second held more than 10 starts and failed with 20. BullMQ counts in fixed
windows that open at the first job, so 10 at the end of one window and 10 at
the start of the next are both allowed. The test now asserts what is true: 10 in
the first second, 20 at worst in any second, and a total time of at least three
full waits for 35 jobs. If you need a smooth rate rather than a capped one,
this limiter is not it.

**Tests hung when Redis was down.** With nothing on the port, ioredis retried
forever and every test ran into its timeout. A global setup now pings Redis
first and stops the run with one line.

## What I would not rely on yet

- The rate limit is per queue and fixed window, as above.
- `removeOnComplete` keeps a job for an hour. A re-queue after that finds the
  file on disk and skips, but the skip is decided by file name, not by checking
  that the file is a good image.
- The processor trusts a path on a disk every worker can see. There is no
  upload step and no object store.
- Output files are never deleted. Nothing here expires a thumbnail.
- A job killed twice by stalls is failed by BullMQ's `maxStalledCount` default
  of 1. I did not change it and did not test the second kill.
- Tested on macOS with Redis from Homebrew, and in CI on Linux with Redis 7.
  Not tried with Redis Cluster.

MIT licence.
