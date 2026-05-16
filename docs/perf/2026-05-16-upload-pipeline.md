# Upload + derivatives pipeline perf pass — 2026-05-16

## Problem

User report: *"навіть локально це все дужееее повільно 150 фоток jpeg 80%
грузяться дуже довго"* — i.e. **150 q80 JPEG photos take too long to
upload + process even on the local dev stack**.

## Method

`scripts/upload-bench.ts` drives the real route handlers (`/api/upload/
presign`, `/api/upload/finalize`) over a real MinIO + Postgres dev stack
with a single derivatives worker. It times each stage independently:

  1. **presign** — POST /api/upload/presign (signs N URLs).
  2. **put**     — parallel PUT of N files to MinIO using the signed URLs.
  3. **finalize**— POST /api/upload/finalize (inserts rows + enqueues
     jobs).
  4. **process** — polls Postgres until every photo's row hits
     `status='ready'`.

Fixture: a 4000×3000 RGB raw buffer with a smooth gradient + centred
random-noise band, JPEG-encoded at q80. Result lands at ~2.6 MB — close
to a real phone JPEG. Run config: `--count 20 --width 4000 --height 3000
--concurrency 10` (dev box: 4 cores, gh-demo-pg:5433, gh-demo-minio:9100,
one worker).

## Results

| stage    | baseline (`1a8c969`) | after all fixes |  Δ wall-clock |
|----------|---------------------:|----------------:|--------------:|
| presign  |               41 ms  |          54 ms  |          +13 ms |
| put      |              1.16 s  |          1.07 s |          (within noise) |
| finalize |             833 ms   |          661 ms |          −21 % |
| process  |           191.49 s   |         36.75 s |          **−80.8 %** |
| **total**|       **193.53 s**   |     **38.53 s** |          **−80.1 %** |

Per-photo throughput: **0.27 MB/s → 1.33 MB/s (4.9×).**

Linear extrapolation for the 150-photo case the user complained about:

  - Baseline: ~24 min end-to-end.
  - After fixes: ~4–5 min end-to-end.

The headline number — **photo flips to `status='ready'` 5× sooner** —
is what the user sees on the album grid. The split derivatives pipeline
(B6) puts the user-visible flip even earlier than the table suggests:
the AVIF re-encode happens *after* the row turns ready, so the grid
renders mid-job.

## Per-commit deltas

The fixes ship as seven atomic commits on top of `1a8c969`. Each commit
body includes the local before/after.

| SHA       | scope          | knob                                            | per-photo win |
|-----------|----------------|-------------------------------------------------|--------------:|
| `f9526a3` | bench          | `scripts/upload-bench.ts` (no code change)      | — |
| `9ac680e` | upload/client  | Dropzone concurrency 4 → 10 (env-configurable)  | network-only (loopback saturates already) |
| `5e21695` | upload/server  | finalize: `insertPhotosBatch` + `boss.insert`   | finalize -21 % |
| `9c5fc9f` | worker         | `WORKER_BATCH_SIZE=6` + parallel handler        | unlocks below |
| `ba5f34e` | encode         | AVIF `effort: 4 → 2`                            | -8 s / photo |
| `8303575` | worker         | `sharp.concurrency(2)`                          | -1–2 s / photo at batch |
| `2479334` | worker         | two-phase: `ready` after WEBPs, AVIF after      | user-visible -50 % |
| `48d2b00` | worker         | `Body.transformToByteArray()` instead of stream | -10 ms / photo |

The big single hitter is **B4 (`ba5f34e`) AVIF effort 4 → 2**: a 9×
encode speed-up at <2 % size delta. Everything else is structural —
removing serial choke points (B2 batch insert, B3 parallel handler,
B6 split phases) so the encode speed-up actually shows up in wall-clock.

## What was *not* changed

- Original JPEG storage path. The signed-PUT-to-MinIO flow on the client
  is unchanged; we just bumped the client worker count.
- WEBP variants. WEBP encode is fast already (~200–500 ms for 4000×3000
  at q80) — the AVIF mirror was always the heavy lifter.
- Sharp pipeline (single buffer, no streaming). Considered, but sharp's
  resize wants random access for EXIF + multi-output; the cost saving
  on 5–15 MB JPEGs is tens of ms vs the encode budget in the seconds.

## Re-running

```powershell
# dev stack from `dev.bat` (gh-demo-pg:5433, gh-demo-minio:9100) + worker running.
$env:DATABASE_URL = "postgresql://gallery:gallery@localhost:5433/gallery_hub"
$env:MINIO_ENDPOINT = "http://localhost:9100"
$env:MINIO_ACCESS_KEY = "minio"
$env:MINIO_SECRET_KEY = "minio12345"
$env:MINIO_BUCKET = "gallery"
$env:MINIO_FORCE_PATH_STYLE = "true"
$env:NODE_ENV = "test"
npx tsx scripts/upload-bench.ts --count 20 --width 4000 --height 3000 --concurrency 10 --label local
```

## Env knobs introduced

- `NEXT_PUBLIC_UPLOAD_CONCURRENCY` — client PUT concurrency (default 10,
  clamp 1..32). Exposed to the browser.
- `WORKER_BATCH_SIZE` — derivative jobs per worker process (default 6,
  clamp 1..16).
- `WORKER_REPLICAS` — number of worker windows spawned by `dev.bat`
  (default 1; pg-boss SKIP LOCKED makes replicas safe).
- `SHARP_CONCURRENCY` — libvips threads per encode (default 2). Override
  on boxes with very different topology.
