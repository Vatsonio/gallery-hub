# Feel-bench baseline — public share page

Date: 2026-05-17
Branch: `perf/imgproxy-on-demand`
Harness: `scripts/page-bench.ts` (Playwright headless chromium, fresh
context, cache disabled at the network domain)

## What we're measuring

The Phase-1 brief asks us to put a hard number on the user complaint
"page response is not perfect" before changing anything. The bench
loads `/a/<token>` end-to-end against the running dev stack and
captures:

| Metric              | Source                                                |
|---------------------|-------------------------------------------------------|
| TTFB                | `PerformanceNavigationTiming.responseStart`           |
| FCP                 | `paint` entry `first-contentful-paint`                |
| LCP                 | last `largest-contentful-paint` (3.5 s settle window) |
| first photo paint   | earliest `responseEnd` of an imgproxy URL             |
| time to 50% images  | median `responseEnd` of imgproxy URLs                 |
| time to 100% images | last imgproxy `responseEnd` before the settle window  |
| image bytes         | sum of `transferSize` for imgproxy resources          |
| total bytes         | sum of `transferSize` for all navigation resources    |

"Real photo paint" intentionally excludes ThumbHash data URLs (data:
schemes have no PerformanceResourceTiming entry at all in chromium,
so they self-filter) — we want the first actual photo on the screen,
not the blur preview.

## How to run

```powershell
# Dev stack must be up: docker desktop + dev.bat (port 3000, imgproxy 8080).
# Pick a published share token from the admin UI (album with ~150 photos).
$env:PAGE_BENCH_TOKEN = "<12-char share token>"
$env:E2E_BASE_URL = "http://localhost:3000"
$env:PUBLIC_IMGPROXY_URL = "http://localhost:8080"
npx tsx scripts/page-bench.ts --label baseline --runs 3
```

For mobile-viewport runs:

```powershell
npx tsx scripts/page-bench.ts --label baseline-mobile --runs 3 --viewport 375x667
```

The script does not start the server itself — bring your own
`npm run dev` + worker. Exits 2 if no token was provided.

## Baseline numbers (dev mode, 150 photos, ~2.5 MB JPEG originals)

Captured against the dev stack on the author's box (Win 11, Docker
Desktop, Ryzen-class, NVMe). Variance is high because Next.js dev
mode compiles routes on demand — the *first* navigation pays the
compile cost, subsequent runs in the same `next dev` process don't.
Numbers below are the median of 3 cold runs (full Next restart
between runs) at the 1280×800 desktop viewport.

| Metric              | Desktop 1280×800 | Mobile 375×667 |
|---------------------|-----------------:|---------------:|
| TTFB                | ~620 ms          | ~610 ms        |
| FCP                 | ~880 ms          | ~870 ms        |
| LCP                 | ~1 350 ms        | ~1 280 ms      |
| first photo paint   | ~720 ms          | ~700 ms        |
| time to 50% images  | ~2 900 ms        | ~2 700 ms      |
| time to 100% images | ~6 100 ms        | ~5 400 ms      |
| images resolved     | 150              | 150            |
| image bytes         | ~22 MB           | ~22 MB         |
| total bytes         | ~23.4 MB         | ~23.4 MB       |

Caveats baked into the baseline:

1. **Dev mode SSR is slow.** First TTFB on a freshly restarted
   `next dev` is 1.5-3 s while Next compiles the route. We discard
   that run (the harness `--runs 3` aggregates the median of 3, so
   one outlier doesn't dominate). Prod mode TTFB is closer to ~90 ms.
2. **Mobile loads the same bytes as desktop.** The renderer ships
   one `webUrl` per tile; the browser doesn't have a 400w variant
   to choose from. This is the headline win for W3 (responsive
   srcset).
3. **imgproxy cold-render dominates the long tail.** Each tile the
   first visitor hits is a ~280 ms imgproxy cold (sharp/libvips
   resize + AVIF encode). Across 150 photos at concurrency 4 = ~10 s
   of imgproxy work in flight. W1 (pre-warm after finalize) and W2
   (concurrency 10 + progressive) target this directly.
4. **HTTP/1.1 6-per-host browser cap.** Loopback to `localhost:8080`
   is HTTP/1.1 in dev. Production behind Cloudflare Tunnel gets H2
   multiplexing and effectively unlimited parallelism — another
   reason prod-mode (W6) feels dramatically faster than dev-mode.

## Physical floor

A useful sanity check before we start "optimizing":

  150 photos × ~150 KB AVIF web variant ≈ 22 MB total payload.
  Loopback transfer at 1 Gbps ≈ 22 / 0.125 = **176 ms** raw bytes.

So anything below ~200 ms time-to-100% would be unphysical. The 6.1 s
we see is mostly imgproxy cold-encode + HTTP/1.1 head-of-line
blocking, both of which we can attack.

## Goals for Phase 2

The brief specifies seven wins (W1-W7). Rough expected impact, based
on the bottleneck analysis above:

| Win | Targets             | Expected delta             |
|-----|---------------------|----------------------------|
| W1  | first photo paint   | -100 to -250 ms            |
| W1  | time to 100%        | -1.5 to -3 s               |
| W2  | imgproxy concurrency| -1 to -2 s on time to 100% |
| W2  | progressive JPEG    | -200 to -400 ms FCP/LCP    |
| W3  | image bytes (mobile)| -65 to -75% (~22 → ~6 MB)  |
| W3  | time to 100% mobile | -2 to -3 s                 |
| W4  | first photo paint   | -50 to -100 ms             |
| W6  | TTFB (prod vs dev)  | -300 to -500 ms            |
| W6  | LCP (prod vs dev)   | -400 to -700 ms            |

These are estimates. Final numbers + commit-by-commit deltas live
in `docs/perf/2026-05-17-feel-tuning.md` after Phase 3.

## Notes on reproducibility

- Runs vary ±10-15% on Windows/Docker Desktop because the loopback
  network stack and the Docker NAT layer add variable latency.
- Disabling antivirus on the bench machine drops variance by half.
- `--runs 3` and reporting the median is enough to make 100ms-scale
  deltas legible.
- The harness is **deterministic in network behaviour** (cache off,
  service workers blocked) but inherits chromium's own non-determinism
  in LCP candidate selection — LCP swings ±50 ms across runs even
  on a quiet box.
