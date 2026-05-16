# Imgproxy on-demand migration — perf + rollback notes

Date: 2026-05-16
Branch: `perf/imgproxy-on-demand`

## What changed

The derivative worker used to bake five variant blobs per photo
(thumb/web/large WEBP + web/large AVIF). The new worker writes
metadata only (dimensions, EXIF `taken_at`, thumbhash, status), and
all resizing happens lazily at request time through imgproxy.

| Step | Before | After |
|------|--------|-------|
| Worker per-photo wall-clock (4-core dev box) | ~5 000–15 000 ms | ~80–120 ms |
| Status='ready' latency after finalize | ~5–15 s | ~100 ms |
| MinIO objects per photo | 1 original + 5 variants | 1 original |
| AVIF support for legacy albums | requires backfill | automatic via Accept header |
| Watermark composition | baked into web/large WEBP+AVIF | lazy via imgproxy `wm_url` |

## Where the pixels come from

Browser → imgproxy URL (signed, content-addressed by source key +
processing chain) → imgproxy fetches the MinIO original over the
internal Docker network → resize + format negotiate (AVIF when the
Accept header signals it, else WEBP) → cached for `IMGPROXY_TTL`
(1y) and served back.

URL builder: `src/lib/imgproxy.ts`. Three convenience helpers mirror
the historical size buckets:

* `imgproxyThumb(key)` — 400×400 fit, q75
* `imgproxyWeb(key)` — 1600×1600 fit, q82
* `imgproxyLarge(key)` — 2400×2400 fit, q86

Every call to those helpers stamps `version=photoVersionSeed(p.updated_at)`
into the source URI so a photo-edit invalidates imgproxy's cache
without needing the Pro `PURGE` endpoint.

## Numbers

Captured via `scripts/upload-bench.ts --count 150 --width 4000 --height 3000`
against the dev stack with the imgproxy container running.

Upload pipeline (worker-only stages):

| Stage | Before (pre-imgproxy) | After (imgproxy era) |
|-------|----------------------:|----------------------:|
| presign | ~280 ms | ~280 ms |
| put | ~5.4 s | ~5.4 s |
| finalize | ~120 ms | ~120 ms |
| process | ~13.8 s | ~1.0 s |
| **total** | **~19.6 s** | **~6.8 s** |

The PUT-to-MinIO leg dominates the post-process wall-clock; the
worker-side savings are visible immediately in the photo status
transition (~100ms vs ~5–15s).

imgproxy first-render latency (1600px web variant from a 3 MB JPEG):

| Hit kind | Latency |
|---------|--------:|
| Cold | ~280 ms |
| Warm | ~12 ms |

Cold-render includes the MinIO fetch + sharp/libvips resize + AVIF
encode at `IMGPROXY_AVIF_SPEED=8`. Warm-render is imgproxy's
in-memory cache (well under one frame on a Cloudflare-tunnelled
prod box).

## Rollback procedure

The branch is local-only (per the refactor brief). To roll back:

```bash
# Discard the branch wholesale — nothing has been merged.
git checkout master
git branch -D perf/imgproxy-on-demand

# Or, keep the branch but unmount imgproxy:
docker compose -f docker-compose.yml stop gallery-imgproxy
# … and revert src/lib/imgproxy.ts callers to the previous
#    presignGet(variantKey(...)) pattern.
```

Critical things the rollback can lean on:

* Variant byte columns (`thumb_bytes` / `web_bytes` / `large_bytes`
  / `avif_bytes_*`) are NOT dropped — migration 016 only adds COMMENT
  markers tagging them legacy. A reverted worker can resume writing
  them.
* `photos.updated_at` (migration 015) is harmless if unused — the
  column has a `DEFAULT now()` so legacy code paths don't break.
* `src/lib/images.ts` still exports `generatePrimaryVariants` /
  `generateAvifVariants` / `applyWatermark`. The functions are
  flagged LEGACY but functionally intact.

## Risks + mitigations

| Risk | Mitigation |
|------|-----------|
| Imgproxy down → no images render | Browser sees opaque `imgproxy://...` placeholder (the fallback returned by `buildImgproxyUrl` when env unset); rollback is a `git checkout master`. |
| Signature key compromise | Rotate `IMGPROXY_KEY` / `IMGPROXY_SALT` + redeploy; old URLs become 403 immediately. URLs are not handed out for >TTL so impact is bounded. |
| Bandwidth amplification | `IMGPROXY_MAX_SRC_RESOLUTION=50` (megapixels) caps the input. Quality + size are baked into helper functions, not user-controllable. |
| Bytes drift between MinIO and imgproxy cache after photo-edit | `updated_at` bump → fresh `?v=` → fresh imgproxy cache key. Verified via tests/lib/imgproxy.test.ts (signature differs across versions). |
