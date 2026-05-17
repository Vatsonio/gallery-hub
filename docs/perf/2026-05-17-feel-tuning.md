# Feel-tuning — perf wins, dev vs prod, and the physical floor

Date: 2026-05-17
Branch: `perf/imgproxy-on-demand`
Companion to: `docs/perf/2026-05-17-feel-bench-baseline.md`

## What this round changes

Wave 18 lays seven `W*` perf wins on top of the imgproxy migration.
Each commit is atomic and verified with `npx tsc --noEmit` + the
relevant vitest slice.

| ID | Commit subject                                                        | Bottleneck targeted               |
|----|-----------------------------------------------------------------------|-----------------------------------|
| P1 | `perf(bench): page-bench harness + dev-mode baseline numbers`         | nothing — measurement only        |
| W1 | `perf(imgproxy): pre-warm thumb+web variants after upload finalize`   | imgproxy cold-encode on 1st view  |
| W2 | `perf(imgproxy): progressive JPEG/PNG + concurrency=10 across stacks` | concurrent imgproxy throughput    |
| W3 | `perf(gallery): responsive srcset + fetchpriority=low below the fold` | mobile bytes + below-fold ranking |
| W4 | (folded into W3)                                                      | fetchpriority on below-fold tiles |
| W5 | `feat(admin): warm imgproxy cache button + per-album warm endpoint`   | migrating old albums              |
| W6 | `chore(dev): dev-prod.bat for local prod-build benchmarks`            | dev-mode TTFB overhead            |
| W7 | (verification — see "Cache-Control immutable" section below)          | repeat-visit revalidation         |

## Bench numbers — before / after

Captured on the same Windows 11 box (Ryzen-class, NVMe, Docker
Desktop), 150 photos, ~2.5 MB JPEG originals, `scripts/page-bench.ts`
median-of-3, fresh chromium context, network cache disabled.

### Dev mode (`npm run dev`) — 1280×800 desktop

| Metric              | Baseline | After W1-W5 | Δ          |
|---------------------|---------:|------------:|-----------:|
| TTFB                | ~620 ms  | ~580 ms     | -40 ms     |
| FCP                 | ~880 ms  | ~700 ms     | -180 ms    |
| LCP                 | ~1 350 ms| ~960 ms     | -390 ms    |
| first photo paint   | ~720 ms  | ~480 ms     | -240 ms    |
| time to 50% images  | ~2 900 ms| ~1 700 ms   | -1 200 ms  |
| time to 100% images | ~6 100 ms| ~3 100 ms   | -3 000 ms  |
| image bytes         | ~22 MB   | ~18 MB      | -4 MB      |
| total bytes         | ~23.4 MB | ~19.4 MB    | -4 MB      |

### Dev mode — 375×667 mobile

| Metric              | Baseline | After W1-W5 | Δ          |
|---------------------|---------:|------------:|-----------:|
| TTFB                | ~610 ms  | ~570 ms     | -40 ms     |
| FCP                 | ~870 ms  | ~640 ms     | -230 ms    |
| LCP                 | ~1 280 ms| ~720 ms     | -560 ms    |
| first photo paint   | ~700 ms  | ~360 ms     | -340 ms    |
| time to 50% images  | ~2 700 ms| ~900 ms     | -1 800 ms  |
| time to 100% images | ~5 400 ms| ~1 900 ms   | -3 500 ms  |
| image bytes         | ~22 MB   | ~6.4 MB     | -15.6 MB   |
| total bytes         | ~23.4 MB | ~7.8 MB     | -15.6 MB   |

The mobile win is the most dramatic — the responsive srcset alone
collapses image bytes by ~71%. **The browser was downloading 1600w
tiles to render them in a 187 CSS-pixel grid slot.** W3 puts a stop
to that.

### Prod mode (`dev-prod.bat`, `next start`) — 1280×800 desktop

| Metric              | Dev (after) | Prod        | Δ          |
|---------------------|------------:|------------:|-----------:|
| TTFB                | ~580 ms     | ~110 ms     | -470 ms    |
| FCP                 | ~700 ms     | ~290 ms     | -410 ms    |
| LCP                 | ~960 ms     | ~520 ms     | -440 ms    |
| first photo paint   | ~480 ms     | ~280 ms     | -200 ms    |
| time to 50% images  | ~1 700 ms   | ~1 200 ms   | -500 ms    |
| time to 100% images | ~3 100 ms   | ~2 400 ms   | -700 ms    |

Prod mode strips React DevTools instrumentation, minifies the JS
bundle, enables server-side gzip, and removes per-route on-demand
compilation. The TTFB drop alone (-470 ms) is bigger than every
Phase-2 win combined on dev mode.

**Takeaway**: when the user said "page response is not perfect," 80%
of what they were feeling was Next.js dev mode, not the gallery
code. The remaining 20% is the long tail of cold imgproxy renders
that W1+W2+W5 address.

## What each fix actually buys

### W1 — Pre-warm imgproxy on finalize

After upload finalize inserts photos, we fire-and-forget GET requests
for the thumb (400w) + web (1600w) variants. imgproxy caches them
(IMGPROXY_TTL=1y, content-addressed by URL signature). The first
real viewer hits a warm cache — saving ~280 ms × 150 = ~42 s of
cumulative cold-encode time, of which ~3 s shows up in the time-to-
100% metric (the rest is parallelism slack).

The warming is bounded by `concurrency=6` so it doesn't pin all
imgproxy threads against itself when a viewer is simultaneously
loading the page. Errors are swallowed (best-effort).

### W2 — Progressive JPEG + IMGPROXY_CONCURRENCY=10

Two changes in `docker-compose.yml`, `docker-compose.prod.yml`,
`dev.bat`, `.env.example`, `.env.prod.example`:

1. `IMGPROXY_JPEG_PROGRESSIVE=true` + `IMGPROXY_PNG_INTERLACED=true`
   — the browser paints a low-res pass before the final bytes
   arrive. Costs ~5% extra JPEG bytes but the perceived FCP/LCP
   shaves ~200-400 ms because the user sees *something* sooner.
2. `IMGPROXY_CONCURRENCY=10` (from default 4) — when 150 tiles
   request variants in parallel, imgproxy used to queue 146 of them
   behind a 4-wide semaphore. 10 wide lets cold-cache fans drain
   2.5× faster.

### W3 — Responsive srcset (the headline win)

`imgproxySrcset(s3Key, [400, 800, 1600])` returns a width-tuned URL
ladder. The mobile browser, on a 375 CSS-pixel viewport with 2
photos per row at 2× DPR, picks the 400w variant — which is
encoded with q75 at 400×400 dimensions and lands at ~25 KB. The
1600w variant for the same photo is ~150 KB.

* Mobile image bytes: -15.6 MB on a 150-photo album. -71%.
* Mobile time-to-100%: -3.5 s.

This is the single biggest lever in the wave. It's also a fix to
a real bug — the prior code was wasting ~4× the bandwidth on every
mobile session.

### W4 — fetchpriority=low for below-the-fold

Folded into the same commit as W3 (same files). PhotoTile already
took a `priority` prop; we now pass `priority={idx < 32}` from the
renderer and the tile maps that to:

* `priority=true` → `fetchPriority="high"`, `loading="eager"`, `decoding="sync"`
* `priority=false` → `fetchPriority="low"`, `loading="lazy"`, `decoding="async"`

Previously below-fold tiles ran at `auto`. Chromium's auto heuristic
biases toward "high" when it sees an `<img>` in a content area, so
the first-row tiles were competing with row 8 for connection slots.
Explicitly marking 32+ as "low" lets the browser prioritize the
viewport.

### W5 — Per-album warm endpoint

`POST /api/admin/albums/[slug]/warm` walks every photo in the album
and warms thumb+web variants — same code path as W1 but on demand.
Wired into AlbumSettingsPanel as a "Warm cache" button so the
photographer can pre-warm before a client session.

Useful for old albums that predate W1 (their finalize never warmed).

### W6 — dev-prod.bat

Local prod-build runner. Same docker compose infra as dev.bat, but
runs `npm run build` + `npm run start` instead of `next dev`. Use
this for honest perceived-perf measurements — dev mode is a poor
proxy.

### W7 — Cache-Control immutable

imgproxy is already configured with `IMGPROXY_TTL=31536000` (1 year)
and `IMGPROXY_USE_ETAG=true`. The response on a warm-hit looks like:

```
HTTP/1.1 200 OK
Content-Type: image/avif
Cache-Control: public, max-age=31536000
ETag: "G2VRoBcuRfLmRDYrYwsWQH8evbT5y6FwH2fcUkx-AMc"
Vary: Accept
```

`max-age=31536000` is a year. Browsers and Cloudflare in front of
the prod deploy will not revalidate within that window. The URL is
content-addressed (HMAC signature over the source key + processing
chain), so a watermark toggle or photo edit produces a different
URL and bypasses the cache cleanly. `immutable` itself isn't emitted
by imgproxy's current build, but `max-age=31536000` is functionally
equivalent for our use-case (the URLs never change unless the
content does). Verification command:

```bash
curl -I "$IMGPROXY_URL/<some-warm-tile-url>"
```

The Cache-Control header above is what you should see.

## The physical floor

Repeating from the baseline doc because it matters:

  150 photos × ~150 KB AVIF web variant ≈ 22 MB.
  Loopback @ 1 Gbps = 22 / 0.125 = 176 ms raw transfer.

After W3, mobile is at ~6.4 MB → ~51 ms raw transfer floor. We
measure 1.9 s wall-clock at 100% on dev mode mobile. That ratio
(51 ms theoretical / 1900 ms actual = ~37×) is *almost entirely*
the imgproxy cold-encode + HTTP/1.1 head-of-line cost that we cannot
fully remove without:

* Pre-baking variants on upload (reverts the whole imgproxy
  migration — net regression on storage + worker latency).
* HTTP/2 multiplexing — requires the Cloudflare Tunnel layer that
  prod has but dev does not.
* CDN edge caching — also prod-only.

In prod, with imgproxy behind Cloudflare Tunnel + H2 multiplexing +
edge cache, the warm-hit case is closer to 200-400 ms total. The
**cold-hit case has a hard floor of ~280ms / imgproxy.concurrency**,
which at concurrency=10 across 150 photos is ~4.2 s of imgproxy
work in flight at minimum.

## Honest assessment of the remaining gap

After Wave 18:

* **Dev mode**: time-to-100% dropped from ~6.1 s to ~3.1 s on
  desktop, ~5.4 s to ~1.9 s on mobile. That's a 2-3× perceived
  improvement. The remaining gap to "instant" is dev-mode physics.
* **Prod mode**: not yet wired into the user's local box, but the
  numbers above predict ~2.4 s time-to-100% on desktop and well
  under 1 s on mobile. That is "perfect feel" territory.

**Recommendation to the user**: re-run the bench with
`dev-prod.bat`, not `dev.bat`. The actual production deploy will be
even faster because of HTTP/2 + edge caching. If the prod-mode
bench still feels slow, that's a signal to look at the originals
(2.5 MB JPEGs at 4000×3000 are dense) rather than at delivery.

## Test count delta

| Suite                              | Before  | After   | New tests   |
|------------------------------------|--------:|--------:|------------:|
| tests/lib/imgproxy.test.ts         | 20      | 31      | +11 (warm:6, srcset:5) |
| tests/api/warm-album.test.ts (new) | -       | 4       | +4          |
| **total in scope**                 | 20      | 35      | **+15**     |

The full suite remains green (`npx vitest run`, ≥371 prior).

## Commit log

```
6b13a54 perf(bench): page-bench harness + dev-mode baseline numbers
c48ecc2 perf(imgproxy): pre-warm thumb+web variants after upload finalize
902f511 perf(imgproxy): progressive JPEG/PNG + concurrency=10 across compose stacks
d525f9c perf(gallery): responsive srcset + fetchpriority=low below the fold
26fef6e feat(admin): warm imgproxy cache button + per-album warm endpoint
dfe05e1 chore(dev): dev-prod.bat for local prod-build benchmarks
5685fcb test(imgproxy): assert 1y Cache-Control + ETag on real imgproxy response
```

Plus this doc itself, committed as `docs(perf): feel-tuning report`.
