# imgproxy URL cheatsheet

Quick reference for the URL builder in `src/lib/imgproxy.ts`.

## Helpers

```ts
import {
  buildImgproxyUrl,
  imgproxyThumb,
  imgproxyWeb,
  imgproxyLarge,
  photoVersionSeed,
} from "@/lib/imgproxy";
import { originalKey } from "@/lib/keys";
import { resolveOriginalExt } from "@/lib/photoExt";

const key = originalKey(albumId, photoId, resolveOriginalExt(photo.filename));
const v = photoVersionSeed(photo.updated_at);

// Convenience helpers — use these everywhere in pages/components:
const thumb = imgproxyThumb(key, { version: v });
const web   = imgproxyWeb(key, { version: v });
const large = imgproxyLarge(key, { version: v });

// Hand-rolled options:
const banner = buildImgproxyUrl(key, {
  width: 1920, height: 600,
  resize: "fill",
  gravity: "sm",     // smart-crop (face / saliency hint)
  quality: 88,
  format: "auto",    // Accept-header negotiation (default)
  version: v,
  watermark: { key: "watermarks/album123.png" },
});
```

## URL anatomy

```
https://img.gallery.divass.space
  /{signature}                              (HMAC-SHA256 base64url)
  /resize:fit:1600:1600:0
  /quality:82
  /watermark:0.6:soea:20:0.25
  /wm_url:czM6Ly9nYWxsZXJ5L3dhdGVybWFya3Mv...    (base64url of "s3://...")
  /czM6Ly9nYWxsZXJ5L2FsYnVtcy8uLi5waw          (base64url of "s3://...?v=...")
```

* `resize:type:w:h:enlarge` — enlarge=0 means "never upscale".
* `quality:N` clamped 1..100.
* `gravity:sm` (smart) / `ce` (center) / `no|so|ea|we` (cardinal).
* `watermark:opacity:position:offset:scale` — followed by `wm_url:{b64}`.
* Source URL is the trailing segment; output extension goes after a `.`
  unless `format='auto'` (then there's no extension and imgproxy
  negotiates via `Accept`).

## Signing

```
sig = base64url( HMAC_SHA256(salt || path, key) )
```

where `path = "/{processing}/{encodedSource}[.{ext}]"`. The library
runs this once per call (~50µs) and caches the decoded key+salt
buffers at module load — call hundreds of times per render safely.

## Cache invalidation

Imgproxy caches by URL. Different processing chain or different
source URI ⇒ different URL ⇒ different cache key. Two ways to
invalidate:

1. **Photo edits** — `photos.updated_at` bumps, `photoVersionSeed`
   stamps a new `?v=epoch` into the source URI, fresh cache entry.
2. **Watermark toggle** — `updateAlbumWatermarkAction` rewrites
   `watermarks/{albumId}.png` AND bumps every photo's `updated_at`,
   so every URL flips its `?v=` and re-renders with (or without)
   the new wm.

There's no manual `PURGE` (Pro-only feature). The cache-bust
through `?v=` is sufficient for our edit/watermark flow.

## When NOT to use imgproxy

* **Export ZIP** (`/api/export/{token}`) — streams originals straight
  from MinIO. Routing through imgproxy would waste a resize pass on
  a download that intentionally wants the raw bytes.
* **Single-photo "Save" download** — `presignGet(originalKey(...))`
  with `Content-Disposition: attachment` so the browser writes the
  pristine file.
* **Lighthouse / programmatic clients that can't negotiate format** —
  pass `format: 'jpg'` explicitly so the response is decodable
  without an Accept header.

## Env wiring (per deploy/imgproxy.md)

| Var | Dev | Prod |
|-----|-----|------|
| `PUBLIC_IMGPROXY_URL` | `http://localhost:8080` | `https://img.gallery.divass.space` |
| `IMGPROXY_URL` | `http://localhost:8080` | `http://gallery-imgproxy:8080` |
| `IMGPROXY_KEY` | per-machine hex (gitignored) | 32-hex prod secret |
| `IMGPROXY_SALT` | per-machine hex (gitignored) | 32-hex prod secret |
| `IMGPROXY_S3_ENDPOINT` | `http://host.docker.internal:9100` | `http://gallery-minio:9000` |

Without `PUBLIC_IMGPROXY_URL` the builder falls back to an
`imgproxy://{key}` sentinel; tests + dev-without-imgproxy environments
keep their import-time semantics intact.
