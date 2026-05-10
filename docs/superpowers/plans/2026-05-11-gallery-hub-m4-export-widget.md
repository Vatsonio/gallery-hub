# Gallery-Hub M4 — Export + Personal-Hub Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship ZIP export pipeline (favorites/web/originals) with 24h MinIO caching, plus a bearer-authed widget endpoint consumed by a dark-cinematic server component on personal-hub.

**Architecture:** Streamed `archiver` ZIP fanned out (PassThrough) to both HTTP response and MinIO PutObject; cache key `exports/{token}/{scope}-{variant}-{YYYY-MM-DD}.zip` with a favorites-signature hash in object metadata; pg-boss reaper purges >24h artifacts. A bearer-authed `/api/widget/summary` endpoint aggregates albums/photos/view_events with in-memory 60s cache + 6 req/min token-bucket; personal-hub renders a server component (`next: { revalidate: 300 }`) with rose-accent cards.

**Tech Stack:** Next.js 15 App Router, postgres.js, MinIO (`@aws-sdk/client-s3`), `archiver@7`, native `stream.PassThrough`, `pg-boss`, `vitest` + `testcontainers`, Tailwind, Lucide.

**Repos touched:** `gallery-hub` (primary) and `personal-hub` (widget consumer).

---

## File Map

### Repo: `gallery-hub`

**Create:**
- `migrations/007_photo_variant_sizes.sql` — add `thumb_bytes`, `web_bytes`, `large_bytes` to `photos`.
- `src/lib/exportCache.ts` — cache-key + favorites-signature helpers.
- `src/lib/rateLimiter.ts` — token-bucket per bearer.
- `src/lib/zipStream.ts` — `archiver` + `PassThrough` fan-out helper.
- `src/lib/widgetQuery.ts` — aggregation queries + 60s memo.
- `src/lib/viewerGrouping.ts` — group `favorite_add` events into 5-min windows.
- `src/app/api/export/[token]/route.ts` — export route handler.
- `src/app/api/widget/summary/route.ts` — widget endpoint.
- `src/components/gallery/ExportModal.tsx` — three-option modal.
- `src/jobs/exportReaper.ts` — pg-boss recurring reaper.
- `tests/unit/exportCache.test.ts`
- `tests/unit/rateLimiter.test.ts`
- `tests/unit/viewerGrouping.test.ts`
- `tests/integration/export.flow.test.ts`
- `tests/integration/widget.summary.test.ts`

**Modify:**
- `src/lib/jobs.ts` — register reaper job + (M2 backfill) write variant byte sizes.
- `src/workers/derivatives.ts` *(or equivalent M2 worker file)* — **Modifies M2 file:** persist `thumb_bytes`, `web_bytes`, `large_bytes`.
- `src/app/a/[token]/favorites/page.tsx` — wire Glass Dock CTA to `ExportModal`.
- `src/app/a/[token]/page.tsx` — wire Export tab/button to `ExportModal`.
- `docker-compose.yml` — add `WIDGET_TOKEN` env.
- `.env.example` — add `WIDGET_TOKEN`.
- `package.json` — add `archiver`, `@types/archiver`.

### Repo: `personal-hub`

**Create:**
- `src/components/dashboard/GalleryWidget.tsx` — server component (RSC).
- `tests/components/GalleryWidget.test.tsx` — snapshot + mocked fetch.

**Modify:**
- `src/app/dashboard/page.tsx` — mount widget under `<QuickActions />`.
- `.env.example` — add `GALLERY_WIDGET_TOKEN`, `GALLERY_BASE_URL`.

---

## PART A — ZIP Export Pipeline (Repo: gallery-hub)

### Task 1: Migration — variant byte size columns

**Repo:** gallery-hub
**Files:**
- Create: `migrations/007_photo_variant_sizes.sql`

- [ ] **Step 1: Write migration**

```sql
-- migrations/007_photo_variant_sizes.sql
ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS thumb_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS web_bytes   BIGINT,
  ADD COLUMN IF NOT EXISTS large_bytes BIGINT;

CREATE INDEX IF NOT EXISTS photos_album_status_idx
  ON photos (album_id, status);
```

- [ ] **Step 2: Run migration**

```bash
docker compose run --rm gallery-migrate
```

Expected: `007_photo_variant_sizes.sql applied`.

- [ ] **Step 3: Commit**

```bash
git add migrations/007_photo_variant_sizes.sql
git commit -m "feat(db): add per-variant byte size columns to photos"
```

---

### Task 2: Backfill variant sizes in M2 derivative worker — **Modifies M2 file**

**Repo:** gallery-hub
**Files:**
- Modify: `src/workers/derivatives.ts`

- [ ] **Step 1: Locate the M2 worker write block**

The M2 worker uploads `thumb.webp`, `web.webp`, `large.webp` then UPDATEs `photos.status='ready'`. After every `sharp(...).toBuffer()` call, capture `buffer.length` and pass through.

- [ ] **Step 2: Update worker to persist sizes**

```ts
// src/workers/derivatives.ts (inside processPhoto)
const thumbBuf = await sharp(orig).resize({ width: 400 }).webp({ quality: 80 }).toBuffer();
const webBuf   = await sharp(orig).resize({ width: 1600 }).webp({ quality: 85 }).toBuffer();
const largeBuf = await sharp(orig).resize({ width: 2400 }).webp({ quality: 88 }).toBuffer();

await Promise.all([
  putObject(`albums/${albumId}/${photoId}/thumb.webp`, thumbBuf, "image/webp"),
  putObject(`albums/${albumId}/${photoId}/web.webp`,   webBuf,   "image/webp"),
  putObject(`albums/${albumId}/${photoId}/large.webp`, largeBuf, "image/webp"),
]);

await sql`
  UPDATE photos
     SET status = 'ready',
         thumb_bytes = ${thumbBuf.length},
         web_bytes   = ${webBuf.length},
         large_bytes = ${largeBuf.length}
   WHERE id = ${photoId}
`;
```

- [ ] **Step 3: Add a one-shot backfill script for already-processed photos**

Create `scripts/backfill-variant-sizes.ts`:

```ts
import { sql } from "@/lib/db";
import { headObject } from "@/lib/minio";

async function main() {
  const rows = await sql<{ id: string; album_id: string }[]>`
    SELECT id, album_id FROM photos
     WHERE status = 'ready'
       AND (thumb_bytes IS NULL OR web_bytes IS NULL OR large_bytes IS NULL)
  `;
  for (const p of rows) {
    const base = `albums/${p.album_id}/${p.id}`;
    const [t, w, l] = await Promise.all([
      headObject(`${base}/thumb.webp`),
      headObject(`${base}/web.webp`),
      headObject(`${base}/large.webp`),
    ]);
    await sql`
      UPDATE photos
         SET thumb_bytes = ${t.ContentLength ?? null},
             web_bytes   = ${w.ContentLength ?? null},
             large_bytes = ${l.ContentLength ?? null}
       WHERE id = ${p.id}
    `;
    console.log("backfilled", p.id);
  }
  process.exit(0);
}
main();
```

Add `headObject` to `src/lib/minio.ts` if not present:

```ts
export async function headObject(key: string) {
  return s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
}
```

- [ ] **Step 4: Run backfill against dev**

```bash
docker compose run --rm gallery-app node --import tsx scripts/backfill-variant-sizes.ts
```

Expected: every existing ready-photo row prints `backfilled <uuid>`.

- [ ] **Step 5: Commit**

```bash
git add src/workers/derivatives.ts src/lib/minio.ts scripts/backfill-variant-sizes.ts
git commit -m "feat(derivatives): persist thumb/web/large byte sizes; add backfill"
```

---

### Task 3: Install `archiver` dependency

**Repo:** gallery-hub
**Files:** Modify `package.json`

- [ ] **Step 1: Install**

```bash
npm install archiver@^7.0.1
npm install -D @types/archiver
```

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add archiver@7 for ZIP export"
```

---

### Task 4: Cache-key + favorites-signature unit (TDD)

**Repo:** gallery-hub
**Files:**
- Create: `src/lib/exportCache.ts`
- Test: `tests/unit/exportCache.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/exportCache.test.ts
import { describe, it, expect } from "vitest";
import { buildCacheKey, favoritesSignature } from "@/lib/exportCache";

describe("buildCacheKey", () => {
  it("formats key as exports/{token}/{scope}-{variant}-{YYYY-MM-DD}.zip", () => {
    const d = new Date("2026-05-11T08:33:00Z");
    expect(buildCacheKey("Hk7eRq8x", "all", "web", d))
      .toBe("exports/Hk7eRq8x/all-web-2026-05-11.zip");
    expect(buildCacheKey("Hk7eRq8x", "favorites", "original", d))
      .toBe("exports/Hk7eRq8x/favorites-original-2026-05-11.zip");
  });
});

describe("favoritesSignature", () => {
  it("is order-independent and stable", () => {
    const a = favoritesSignature(["p3", "p1", "p2"]);
    const b = favoritesSignature(["p1", "p2", "p3"]);
    expect(a).toBe(b);
    expect(a).toHaveLength(64); // sha256 hex
  });

  it("changes when set changes", () => {
    const a = favoritesSignature(["p1", "p2"]);
    const c = favoritesSignature(["p1", "p2", "p3"]);
    expect(a).not.toBe(c);
  });

  it("returns 'empty' marker for empty array", () => {
    expect(favoritesSignature([])).toBe("empty");
  });
});
```

- [ ] **Step 2: Run — verify failure**

```bash
npx vitest run tests/unit/exportCache.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/exportCache.ts
import { createHash } from "node:crypto";

export type ExportScope = "favorites" | "all";
export type ExportVariant = "original" | "web";

export function buildCacheKey(
  token: string,
  scope: ExportScope,
  variant: ExportVariant,
  now: Date = new Date(),
): string {
  const ymd = now.toISOString().slice(0, 10);
  return `exports/${token}/${scope}-${variant}-${ymd}.zip`;
}

export function favoritesSignature(photoIds: string[]): string {
  if (photoIds.length === 0) return "empty";
  const sorted = [...photoIds].sort();
  return createHash("sha256").update(sorted.join("|")).digest("hex");
}
```

- [ ] **Step 4: Run — verify pass**

```bash
npx vitest run tests/unit/exportCache.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/exportCache.ts tests/unit/exportCache.test.ts
git commit -m "feat(export): cache-key + favorites-signature helpers"
```

---

### Task 5: ZIP stream fan-out helper

**Repo:** gallery-hub
**Files:**
- Create: `src/lib/zipStream.ts`

- [ ] **Step 1: Implement helper**

```ts
// src/lib/zipStream.ts
import archiver from "archiver";
import { PassThrough, Readable } from "node:stream";

export interface ZipEntry {
  name: string;        // filename inside ZIP, e.g. "001-IMG_0001.jpg"
  body: Readable;      // source stream (MinIO GET body)
}

/**
 * Creates a ZIP archive and fans it out to two destinations.
 * Returns the two readable streams: one for the HTTP response, one for MinIO upload.
 * Caller must consume both, otherwise backpressure will stall.
 */
export function createFanOutZip(entries: AsyncIterable<ZipEntry>) {
  const archive = archiver("zip", { zlib: { level: 0 } }); // store-only — photos already compressed
  const toHttp = new PassThrough();
  const toMinio = new PassThrough();

  archive.on("error", (err) => {
    toHttp.destroy(err);
    toMinio.destroy(err);
  });

  // fan out: every byte archiver emits is written to BOTH passthroughs.
  archive.on("data", (chunk: Buffer) => {
    toHttp.write(chunk);
    toMinio.write(chunk);
  });
  archive.on("end", () => {
    toHttp.end();
    toMinio.end();
  });

  // append entries as they arrive
  (async () => {
    try {
      for await (const e of entries) {
        archive.append(e.body, { name: e.name });
      }
      await archive.finalize();
    } catch (err) {
      archive.emit("error", err);
    }
  })();

  return { toHttp, toMinio };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/zipStream.ts
git commit -m "feat(export): archiver + PassThrough fan-out helper"
```

---

### Task 6: Export route handler

**Repo:** gallery-hub
**Files:**
- Create: `src/app/api/export/[token]/route.ts`

- [ ] **Step 1: Implement route**

```ts
// src/app/api/export/[token]/route.ts
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { s3, BUCKET, headObject, getObjectStream, getPresignedUrl } from "@/lib/minio";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { buildCacheKey, favoritesSignature, type ExportScope, type ExportVariant } from "@/lib/exportCache";
import { createFanOutZip, type ZipEntry } from "@/lib/zipStream";
import { getViewerId } from "@/lib/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const url = new URL(req.url);
  const scope = (url.searchParams.get("scope") ?? "all") as ExportScope;
  const variant = (url.searchParams.get("variant") ?? "web") as ExportVariant;

  if (!["favorites", "all"].includes(scope) || !["original", "web"].includes(variant)) {
    return new Response("bad params", { status: 400 });
  }

  // 1. Validate share link
  const [link] = await sql<{ album_id: string; expires_at: Date | null; allow_download: boolean }[]>`
    SELECT album_id, expires_at, allow_download
      FROM share_links WHERE token = ${token}
  `;
  if (!link) return new Response("not found", { status: 404 });
  if (link.expires_at && link.expires_at.getTime() < Date.now()) {
    return new Response("expired", { status: 410 });
  }
  if (!link.allow_download) return new Response("download disabled", { status: 403 });

  const viewerId = await getViewerId(req);

  // 2. Resolve photo set
  let photos: { id: string; filename: string; sort_order: number }[];
  if (scope === "favorites") {
    photos = await sql`
      SELECT p.id, p.filename, p.sort_order
        FROM favorites f
        JOIN photos p ON p.id = f.photo_id
       WHERE f.share_token = ${token} AND f.viewer_id = ${viewerId}
       ORDER BY p.sort_order ASC
    `;
  } else {
    photos = await sql`
      SELECT id, filename, sort_order FROM photos
       WHERE album_id = ${link.album_id} AND status = 'ready'
       ORDER BY sort_order ASC
    `;
  }
  if (photos.length === 0) return new Response("nothing to export", { status: 404 });

  const sig = scope === "favorites"
    ? favoritesSignature(photos.map((p) => p.id))
    : "all";

  // 3. Cache lookup
  const cacheKey = buildCacheKey(token, scope, variant, new Date());
  try {
    const head = await headObject(cacheKey);
    const cachedSig = head.Metadata?.["favorites_signature"];
    const cachedExp = head.Metadata?.["expires"];
    const fresh = cachedExp ? Date.parse(cachedExp) > Date.now() : false;
    if (fresh && cachedSig === sig) {
      const presigned = await getPresignedUrl(cacheKey, 3600);
      await logDownload(token, viewerId, scope, variant, head.ContentLength ?? 0);
      return Response.redirect(presigned, 302);
    }
  } catch {
    // miss — fall through
  }

  // 4. Stream fresh ZIP
  const variantKey = variant === "original" ? "original.jpg" : "large.webp";

  async function* gen(): AsyncGenerator<ZipEntry> {
    for (const p of photos) {
      const key = `albums/${link.album_id}/${p.id}/${variantKey}`;
      const body = await getObjectStream(key);
      yield {
        name: `${String(p.sort_order).padStart(3, "0")}-${p.filename}`,
        body,
      };
    }
  }

  const { toHttp, toMinio } = createFanOutZip(gen());

  // Upload to MinIO in background
  const uploadPromise = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: cacheKey,
      Body: toMinio,
      ContentType: "application/zip",
      Metadata: {
        favorites_signature: sig,
        expires: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      },
    },
  }).done();

  uploadPromise.catch((err) => console.error("export cache upload failed", err));

  // Log download (size approximated by sum of variant bytes)
  const sizeRow = await sql<{ total: bigint }[]>`
    SELECT COALESCE(SUM(${sql(variant === "original" ? "orig_bytes" : "large_bytes")}), 0)::bigint AS total
      FROM photos
     WHERE id = ANY(${photos.map((p) => p.id)}::uuid[])
  `;
  await logDownload(token, viewerId, scope, variant, Number(sizeRow[0].total));

  return new Response(toHttp as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${token}-${scope}-${variant}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}

async function logDownload(
  token: string, viewerId: string, scope: ExportScope, variant: ExportVariant, bytes: number,
) {
  await sql`
    INSERT INTO view_events (share_token, viewer_id, event_type, photo_id, details)
    VALUES (${token}, ${viewerId}, 'download', NULL, ${sql.json({ scope, variant, bytes })})
  `;
}
```

- [ ] **Step 2: Add MinIO helpers if missing**

In `src/lib/minio.ts`:

```ts
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";

export async function getObjectStream(key: string): Promise<Readable> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return res.Body as Readable;
}

export async function getPresignedUrl(key: string, ttlSec: number): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: ttlSec });
}
```

- [ ] **Step 3: Check `view_events.details` jsonb column exists**

If not, add a migration `008_view_events_details.sql`:

```sql
ALTER TABLE view_events ADD COLUMN IF NOT EXISTS details JSONB;
```

Run: `docker compose run --rm gallery-migrate`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/export/[token]/route.ts src/lib/minio.ts migrations/008_view_events_details.sql
git commit -m "feat(api): /api/export/[token] streamed ZIP with 24h MinIO cache"
```

---

### Task 7: Integration test — fresh export

**Repo:** gallery-hub
**Files:**
- Create: `tests/integration/export.flow.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/integration/export.flow.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Wait } from "testcontainers";
import sharp from "sharp";
import AdmZip from "adm-zip";
import { startTestApp, stopTestApp, type TestEnv } from "./helpers/app";

let env: TestEnv;

beforeAll(async () => {
  env = await startTestApp();
  // seed: album + 3 photos with real small JPEGs
  const albumId = await env.seedAlbum("Test Album");
  for (let i = 1; i <= 3; i++) {
    const jpeg = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: i * 50, g: 0, b: 0 } },
    }).jpeg().toBuffer();
    await env.seedPhoto(albumId, `IMG_${i}.jpg`, i, jpeg);
  }
  await env.seedShareLink("TESTTOK0001", albumId);
}, 120_000);

afterAll(() => stopTestApp(env), 30_000);

describe("export flow — all/original", () => {
  it("returns a ZIP with all 3 photos", async () => {
    const res = await fetch(`${env.baseUrl}/api/export/TESTTOK0001?scope=all&variant=original`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = new AdmZip(buf);
    const entries = zip.getEntries().map((e) => e.entryName).sort();
    expect(entries).toEqual([
      "001-IMG_1.jpg",
      "002-IMG_2.jpg",
      "003-IMG_3.jpg",
    ]);
    for (const e of zip.getEntries()) {
      expect(e.getData().length).toBeGreaterThan(100);
    }
  });

  it("serves cached blob on second request (presigned redirect)", async () => {
    // first call already populated cache; allow upload to settle
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(`${env.baseUrl}/api/export/TESTTOK0001?scope=all&variant=original`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location");
    expect(loc).toMatch(/X-Amz-Signature=/);
  });
});
```

- [ ] **Step 2: Add testcontainer helpers**

`tests/integration/helpers/app.ts`:

```ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { spawn, ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { glob } from "glob";

export interface TestEnv {
  baseUrl: string;
  pg: StartedPostgreSqlContainer;
  minio: StartedTestContainer;
  app: ChildProcess;
  seedAlbum: (title: string) => Promise<string>;
  seedPhoto: (albumId: string, filename: string, order: number, body: Buffer) => Promise<void>;
  seedShareLink: (token: string, albumId: string) => Promise<void>;
}

export async function startTestApp(): Promise<TestEnv> {
  const pg = await new PostgreSqlContainer("postgres:16").start();
  const minio = await new GenericContainer("minio/minio:latest")
    .withExposedPorts(9000)
    .withCommand(["server", "/data"])
    .withEnvironment({ MINIO_ROOT_USER: "test", MINIO_ROOT_PASSWORD: "testtest" })
    .withWaitStrategy(Wait.forHttp("/minio/health/live", 9000))
    .start();

  // apply migrations
  const { default: postgres } = await import("postgres");
  const sql = postgres(pg.getConnectionUri());
  const files = (await glob("migrations/*.sql")).sort();
  for (const f of files) {
    await sql.unsafe(readFileSync(f, "utf8"));
  }
  await sql.end();

  // create bucket
  // (mc client or AWS SDK call — omitted for brevity, use s3 client to CreateBucket "gallery")

  const port = 13000 + Math.floor(Math.random() * 1000);
  const app = spawn("node", [".next/standalone/server.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: pg.getConnectionUri(),
      MINIO_ENDPOINT: `http://localhost:${minio.getMappedPort(9000)}`,
      MINIO_ACCESS_KEY: "test",
      MINIO_SECRET_KEY: "testtest",
      MINIO_BUCKET: "gallery",
    },
    stdio: "inherit",
  });

  await waitForHttp(`http://localhost:${port}/api/health`, 30_000);

  return {
    baseUrl: `http://localhost:${port}`,
    pg, minio, app,
    async seedAlbum(title) {
      const sql2 = postgres(pg.getConnectionUri());
      const [row] = await sql2`
        INSERT INTO albums (slug, title, status)
        VALUES (${title.toLowerCase().replace(/\s+/g, "-")}, ${title}, 'published')
        RETURNING id
      `;
      await sql2.end();
      return row.id;
    },
    async seedPhoto(albumId, filename, order, body) {
      const sql2 = postgres(pg.getConnectionUri());
      const [p] = await sql2`
        INSERT INTO photos (album_id, filename, width, height, orig_bytes, sort_order, status, large_bytes)
        VALUES (${albumId}, ${filename}, 200, 200, ${body.length}, ${order}, 'ready', ${body.length})
        RETURNING id
      `;
      // upload original + large to MinIO
      const { S3Client, PutObjectCommand, CreateBucketCommand } = await import("@aws-sdk/client-s3");
      const s3 = new S3Client({
        endpoint: `http://localhost:${minio.getMappedPort(9000)}`,
        region: "us-east-1",
        credentials: { accessKeyId: "test", secretAccessKey: "testtest" },
        forcePathStyle: true,
      });
      try { await s3.send(new CreateBucketCommand({ Bucket: "gallery" })); } catch {}
      await s3.send(new PutObjectCommand({
        Bucket: "gallery", Key: `albums/${albumId}/${p.id}/original.jpg`, Body: body,
      }));
      await s3.send(new PutObjectCommand({
        Bucket: "gallery", Key: `albums/${albumId}/${p.id}/large.webp`, Body: body,
      }));
      await sql2.end();
    },
    async seedShareLink(token, albumId) {
      const sql2 = postgres(pg.getConnectionUri());
      await sql2`
        INSERT INTO share_links (token, album_id, allow_download)
        VALUES (${token}, ${albumId}, true)
      `;
      await sql2.end();
    },
  };
}

export async function stopTestApp(env: TestEnv) {
  env.app.kill("SIGTERM");
  await env.pg.stop();
  await env.minio.stop();
}

async function waitForHttp(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${url}`);
}
```

Add dev deps:

```bash
npm install -D adm-zip @types/adm-zip @testcontainers/postgresql testcontainers glob
```

- [ ] **Step 3: Build standalone for test**

```bash
npm run build
```

- [ ] **Step 4: Run integration test**

```bash
npx vitest run tests/integration/export.flow.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/export.flow.test.ts tests/integration/helpers/app.ts package.json package-lock.json
git commit -m "test(export): integration — fresh ZIP + cached presigned redirect"
```

---

### Task 8: ExportModal component

**Repo:** gallery-hub
**Files:**
- Create: `src/components/gallery/ExportModal.tsx`

- [ ] **Step 1: Implement modal**

```tsx
// src/components/gallery/ExportModal.tsx
"use client";

import { useState } from "react";
import { X, Download, Heart, ImageIcon, FileImage } from "lucide-react";

interface Option {
  id: "favorites-original" | "all-web" | "all-original";
  scope: "favorites" | "all";
  variant: "original" | "web";
  icon: typeof Heart;
  title: string;
  subtitle: string;
  bytes: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  token: string;
  options: Option[];
}

function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function ExportModal({ open, onClose, token, options }: Props) {
  const [selected, setSelected] = useState<Option["id"]>(options[0]?.id);

  if (!open) return null;
  const active = options.find((o) => o.id === selected) ?? options[0];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md bg-neutral-950 border-t sm:border border-white/10 sm:rounded-2xl p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-white text-lg font-medium tracking-wide">Export</h2>
          <button onClick={onClose} aria-label="Close" className="text-neutral-400 hover:text-white transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-2 mb-6">
          {options.map((opt) => {
            const sel = opt.id === selected;
            const Icon = opt.icon;
            return (
              <button
                key={opt.id}
                onClick={() => setSelected(opt.id)}
                className={`w-full flex items-center gap-3 p-4 rounded-xl border transition text-left
                  ${sel
                    ? "border-rose-500/70 bg-rose-500/5"
                    : "border-white/10 bg-white/[0.02] hover:border-white/20"}`}
              >
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center
                  ${sel ? "bg-rose-500/15 text-rose-400" : "bg-white/[0.04] text-neutral-400"}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-white text-sm font-medium">{opt.title}</div>
                  <div className="text-neutral-400 text-xs mt-0.5">{opt.subtitle}</div>
                </div>
                <div className="text-neutral-500 text-xs tabular-nums">{fmtBytes(opt.bytes)}</div>
              </button>
            );
          })}
        </div>

        <a
          href={`/api/export/${token}?scope=${active.scope}&variant=${active.variant}`}
          className="flex items-center justify-center gap-2 w-full h-12 rounded-xl bg-rose-500 hover:bg-rose-400 text-white font-medium transition"
          onClick={onClose}
        >
          <Download className="w-4 h-4" />
          Download ZIP
        </a>
      </div>
    </div>
  );
}

export const EXPORT_ICONS = { Heart, ImageIcon, FileImage };
```

- [ ] **Step 2: Commit**

```bash
git add src/components/gallery/ExportModal.tsx
git commit -m "feat(gallery): ExportModal — 3-option dark-cinematic dialog"
```

---

### Task 9: Wire ExportModal on `/a/[token]` and `/a/[token]/favorites`

**Repo:** gallery-hub
**Files:**
- Modify: `src/app/a/[token]/page.tsx`
- Modify: `src/app/a/[token]/favorites/page.tsx`

- [ ] **Step 1: Add a server helper to compute byte totals**

`src/lib/exportSizes.ts`:

```ts
import { sql } from "@/lib/db";

export interface ExportSizes {
  favoritesOriginalBytes: number;
  allWebBytes: number;
  allOriginalBytes: number;
  favoritesCount: number;
  totalCount: number;
}

export async function computeExportSizes(token: string, viewerId: string, albumId: string): Promise<ExportSizes> {
  const [fav] = await sql<{ count: bigint; bytes: bigint }[]>`
    SELECT COUNT(*)::bigint AS count,
           COALESCE(SUM(p.orig_bytes), 0)::bigint AS bytes
      FROM favorites f
      JOIN photos p ON p.id = f.photo_id
     WHERE f.share_token = ${token} AND f.viewer_id = ${viewerId}
  `;
  const [all] = await sql<{ count: bigint; orig: bigint; large: bigint }[]>`
    SELECT COUNT(*)::bigint AS count,
           COALESCE(SUM(orig_bytes), 0)::bigint AS orig,
           COALESCE(SUM(large_bytes), 0)::bigint AS large
      FROM photos
     WHERE album_id = ${albumId} AND status = 'ready'
  `;
  return {
    favoritesCount: Number(fav.count),
    favoritesOriginalBytes: Number(fav.bytes),
    totalCount: Number(all.count),
    allOriginalBytes: Number(all.orig),
    allWebBytes: Number(all.large),
  };
}
```

- [ ] **Step 2: Create client wrapper to host modal state**

`src/components/gallery/ExportButton.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Download, Heart, ImageIcon, FileImage } from "lucide-react";
import ExportModal from "./ExportModal";

interface Props {
  token: string;
  favoritesCount: number;
  totalCount: number;
  favoritesOriginalBytes: number;
  allWebBytes: number;
  allOriginalBytes: number;
  variant?: "dock" | "button";
}

export default function ExportButton(props: Props) {
  const [open, setOpen] = useState(false);
  const opts = [
    {
      id: "favorites-original" as const,
      scope: "favorites" as const, variant: "original" as const,
      icon: Heart,
      title: "Favorites — originals",
      subtitle: `${props.favoritesCount} photo${props.favoritesCount === 1 ? "" : "s"} · full quality`,
      bytes: props.favoritesOriginalBytes,
    },
    {
      id: "all-web" as const,
      scope: "all" as const, variant: "web" as const,
      icon: ImageIcon,
      title: "Whole album — web size",
      subtitle: `${props.totalCount} photos · 2400px max`,
      bytes: props.allWebBytes,
    },
    {
      id: "all-original" as const,
      scope: "all" as const, variant: "original" as const,
      icon: FileImage,
      title: "Whole album — originals",
      subtitle: `${props.totalCount} photos · full quality`,
      bytes: props.allOriginalBytes,
    },
  ];

  if (props.variant === "dock") {
    return (
      <>
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-4 inset-x-4 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-80 z-40
                     flex items-center gap-3 p-3 rounded-2xl
                     bg-white/[0.04] backdrop-blur-xl border border-white/10
                     shadow-2xl shadow-black/50"
        >
          <span className="w-11 h-11 rounded-xl bg-gradient-to-br from-rose-500 to-rose-700 flex items-center justify-center">
            <Download className="w-5 h-5 text-white" />
          </span>
          <span className="flex-1 text-left">
            <span className="block text-white text-sm font-medium">Export favorites</span>
            <span className="block text-neutral-400 text-xs">
              {props.favoritesCount} photos · {(props.favoritesOriginalBytes / 1024 / 1024).toFixed(1)} MB · ZIP
            </span>
          </span>
        </button>
        <ExportModal open={open} onClose={() => setOpen(false)} token={props.token} options={opts} />
      </>
    );
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-4 h-10 rounded-lg bg-white/[0.05] hover:bg-white/[0.08] border border-white/10 text-white text-sm transition"
      >
        <Download className="w-4 h-4" />
        Export
      </button>
      <ExportModal open={open} onClose={() => setOpen(false)} token={props.token} options={opts} />
    </>
  );
}
```

- [ ] **Step 3: Mount in album page**

In `src/app/a/[token]/page.tsx`, find the M3 placeholder Export button and replace:

```tsx
import ExportButton from "@/components/gallery/ExportButton";
import { computeExportSizes } from "@/lib/exportSizes";
// ...inside the async server component, after loading link & viewerId:
const sizes = await computeExportSizes(token, viewerId, link.album_id);
// ...where the placeholder was:
<ExportButton token={token} variant="button" {...sizes} />
```

- [ ] **Step 4: Mount in favorites page (Glass Dock)**

In `src/app/a/[token]/favorites/page.tsx`, replace the M3 placeholder dock:

```tsx
import ExportButton from "@/components/gallery/ExportButton";
import { computeExportSizes } from "@/lib/exportSizes";
const sizes = await computeExportSizes(token, viewerId, link.album_id);
// at bottom of the page tree:
<ExportButton token={token} variant="dock" {...sizes} />
```

- [ ] **Step 5: Smoke test in dev**

```bash
npm run dev
# Visit /a/<known-token> -> click Export, pick variant, ZIP downloads.
```

- [ ] **Step 6: Commit**

```bash
git add src/components/gallery/ExportButton.tsx src/lib/exportSizes.ts src/app/a/[token]/page.tsx src/app/a/[token]/favorites/page.tsx
git commit -m "feat(gallery): wire ExportModal — Glass Dock + album Export button"
```

---

### Task 10: pg-boss reaper for stale exports

**Repo:** gallery-hub
**Files:**
- Create: `src/jobs/exportReaper.ts`
- Modify: `src/lib/jobs.ts`

- [ ] **Step 1: Implement reaper**

```ts
// src/jobs/exportReaper.ts
import { s3, BUCKET } from "@/lib/minio";
import { DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

export async function reapExports() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let token: string | undefined;
  let deleted = 0;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: "exports/",
      ContinuationToken: token,
    }));
    for (const obj of page.Contents ?? []) {
      if (!obj.Key || !obj.LastModified) continue;
      if (obj.LastModified.getTime() < cutoff) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
        deleted++;
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return { deleted };
}
```

- [ ] **Step 2: Register in pg-boss**

In `src/lib/jobs.ts` (the M2 jobs entrypoint), add:

```ts
import { reapExports } from "@/jobs/exportReaper";

export async function registerWorkers(boss: PgBoss) {
  // ...existing derivative worker registration...
  await boss.work("export-reaper", async () => {
    const r = await reapExports();
    console.log("export-reaper", r);
  });
  await boss.schedule("export-reaper", "0 */6 * * *"); // every 6h
}
```

- [ ] **Step 3: Commit**

```bash
git add src/jobs/exportReaper.ts src/lib/jobs.ts
git commit -m "feat(jobs): reap exports/ MinIO objects older than 24h"
```

---

## PART B — Widget Endpoint (Repo: gallery-hub)

### Task 11: Rate limiter unit (TDD)

**Repo:** gallery-hub
**Files:**
- Create: `src/lib/rateLimiter.ts`
- Test: `tests/unit/rateLimiter.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/rateLimiter.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRateLimiter } from "@/lib/rateLimiter";

describe("rateLimiter", () => {
  beforeEach(() => vi.useFakeTimers());

  it("allows 6 hits in 60s then blocks the 7th", () => {
    vi.setSystemTime(new Date("2026-05-11T00:00:00Z"));
    const rl = createRateLimiter({ max: 6, windowMs: 60_000 });
    for (let i = 0; i < 6; i++) expect(rl.allow("tok")).toBe(true);
    expect(rl.allow("tok")).toBe(false);
  });

  it("refills after the window slides", () => {
    vi.setSystemTime(new Date("2026-05-11T00:00:00Z"));
    const rl = createRateLimiter({ max: 6, windowMs: 60_000 });
    for (let i = 0; i < 6; i++) rl.allow("tok");
    expect(rl.allow("tok")).toBe(false);
    vi.setSystemTime(new Date("2026-05-11T00:01:01Z"));
    expect(rl.allow("tok")).toBe(true);
  });

  it("tracks tokens independently", () => {
    vi.setSystemTime(new Date("2026-05-11T00:00:00Z"));
    const rl = createRateLimiter({ max: 2, windowMs: 60_000 });
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(false);
    expect(rl.allow("b")).toBe(true);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
npx vitest run tests/unit/rateLimiter.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/rateLimiter.ts
export interface RateLimiterOpts {
  max: number;
  windowMs: number;
}

export interface RateLimiter {
  allow(key: string): boolean;
}

export function createRateLimiter(opts: RateLimiterOpts): RateLimiter {
  const buckets = new Map<string, number[]>(); // key -> sorted timestamps
  return {
    allow(key) {
      const now = Date.now();
      const cutoff = now - opts.windowMs;
      const hits = (buckets.get(key) ?? []).filter((t) => t > cutoff);
      if (hits.length >= opts.max) {
        buckets.set(key, hits);
        return false;
      }
      hits.push(now);
      buckets.set(key, hits);
      return true;
    },
  };
}
```

- [ ] **Step 4: Run — verify pass**

```bash
npx vitest run tests/unit/rateLimiter.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rateLimiter.ts tests/unit/rateLimiter.test.ts
git commit -m "feat(lib): in-memory sliding-window rate limiter"
```

---

### Task 12: Viewer grouping unit (TDD)

**Repo:** gallery-hub
**Files:**
- Create: `src/lib/viewerGrouping.ts`
- Test: `tests/unit/viewerGrouping.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/viewerGrouping.test.ts
import { describe, it, expect } from "vitest";
import { groupFavoriteEvents } from "@/lib/viewerGrouping";

const ev = (token: string, viewer: string, at: string) => ({
  share_token: token, viewer_id: viewer, created_at: new Date(at), album_title: "X",
});

describe("groupFavoriteEvents", () => {
  it("merges events within 5 minutes for same (token,viewer)", () => {
    const out = groupFavoriteEvents([
      ev("t1", "v1", "2026-05-11T10:00:00Z"),
      ev("t1", "v1", "2026-05-11T10:02:00Z"),
      ev("t1", "v1", "2026-05-11T10:04:30Z"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].added_count).toBe(3);
    expect(out[0].viewer_id_short).toBe("v1");
  });

  it("splits when gap > 5 minutes", () => {
    const out = groupFavoriteEvents([
      ev("t1", "v1", "2026-05-11T10:00:00Z"),
      ev("t1", "v1", "2026-05-11T10:06:00Z"),
    ]);
    expect(out).toHaveLength(2);
  });

  it("separates different viewers", () => {
    const out = groupFavoriteEvents([
      ev("t1", "v1", "2026-05-11T10:00:00Z"),
      ev("t1", "v2", "2026-05-11T10:01:00Z"),
    ]);
    expect(out).toHaveLength(2);
  });

  it("returns viewer_id_short as first 8 chars", () => {
    const out = groupFavoriteEvents([
      ev("t1", "a4f12345abcdef", "2026-05-11T10:00:00Z"),
    ]);
    expect(out[0].viewer_id_short).toBe("a4f12345");
  });

  it("orders by `at` descending (most recent first)", () => {
    const out = groupFavoriteEvents([
      ev("t1", "v1", "2026-05-11T09:00:00Z"),
      ev("t2", "v2", "2026-05-11T10:00:00Z"),
    ]);
    expect(out[0].album_title).toBe("X");
    expect(out[0].at).toBe("2026-05-11T10:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
npx vitest run tests/unit/viewerGrouping.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/viewerGrouping.ts
export interface RawFavoriteEvent {
  share_token: string;
  viewer_id: string;
  created_at: Date;
  album_title: string;
}

export interface GroupedSelection {
  album_title: string;
  added_count: number;
  viewer_id_short: string;
  at: string;
}

const WINDOW_MS = 5 * 60 * 1000;

export function groupFavoriteEvents(events: RawFavoriteEvent[]): GroupedSelection[] {
  // Sort ascending by time per (token, viewer) so we can run-length group.
  const byKey = new Map<string, RawFavoriteEvent[]>();
  for (const e of events) {
    const k = `${e.share_token}|${e.viewer_id}`;
    const list = byKey.get(k) ?? [];
    list.push(e);
    byKey.set(k, list);
  }

  const groups: GroupedSelection[] = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    let bucket: RawFavoriteEvent[] = [];
    const flush = () => {
      if (bucket.length === 0) return;
      const last = bucket[bucket.length - 1];
      groups.push({
        album_title: last.album_title,
        added_count: bucket.length,
        viewer_id_short: last.viewer_id.slice(0, 8),
        at: last.created_at.toISOString(),
      });
      bucket = [];
    };
    for (const e of list) {
      if (bucket.length === 0) { bucket.push(e); continue; }
      const prev = bucket[bucket.length - 1];
      if (e.created_at.getTime() - prev.created_at.getTime() <= WINDOW_MS) {
        bucket.push(e);
      } else {
        flush();
        bucket.push(e);
      }
    }
    flush();
  }

  return groups.sort((a, b) => b.at.localeCompare(a.at));
}
```

- [ ] **Step 4: Run — verify pass**

```bash
npx vitest run tests/unit/viewerGrouping.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/viewerGrouping.ts tests/unit/viewerGrouping.test.ts
git commit -m "feat(lib): group favorite_add events into 5-min windows"
```

---

### Task 13: Widget query aggregator

**Repo:** gallery-hub
**Files:**
- Create: `src/lib/widgetQuery.ts`

- [ ] **Step 1: Implement**

```ts
// src/lib/widgetQuery.ts
import { sql } from "@/lib/db";
import { getPresignedUrl } from "@/lib/minio";
import { groupFavoriteEvents, type GroupedSelection } from "@/lib/viewerGrouping";

export interface WidgetSummary {
  stats: {
    albums_total: number;
    albums_published: number;
    photos_total: number;
    storage_bytes: number;
  };
  recent_albums: Array<{
    title: string;
    subtitle: string | null;
    cover_url: string | null;
    photo_count: number;
    favorite_count: number;
    view_count: number;
    share_url: string | null;
    status: "draft" | "published" | "archived";
    updated_at: string;
  }>;
  recent_selections: GroupedSelection[];
}

let cache: { at: number; value: WidgetSummary } | null = null;
const CACHE_MS = 60_000;

export async function loadWidgetSummary(baseUrl: string): Promise<WidgetSummary> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const [stats] = await sql<{ albums_total: bigint; albums_published: bigint; photos_total: bigint; storage_bytes: bigint }[]>`
    SELECT
      (SELECT COUNT(*) FROM albums)::bigint AS albums_total,
      (SELECT COUNT(*) FROM albums WHERE status = 'published')::bigint AS albums_published,
      (SELECT COUNT(*) FROM photos)::bigint AS photos_total,
      (SELECT COALESCE(SUM(orig_bytes), 0) FROM photos)::bigint AS storage_bytes
  `;

  const albums = await sql<{
    id: string; title: string; subtitle: string | null; cover_photo_id: string | null;
    album_id: string; status: "draft" | "published" | "archived"; updated_at: Date;
    photo_count: bigint; favorite_count: bigint; view_count: bigint; token: string | null;
  }[]>`
    SELECT a.id, a.title, a.subtitle, a.cover_photo_id, a.id AS album_id, a.status, a.updated_at,
           (SELECT COUNT(*) FROM photos WHERE album_id = a.id)::bigint AS photo_count,
           (SELECT COUNT(DISTINCT f.viewer_id)
              FROM favorites f
              JOIN share_links sl ON sl.token = f.share_token
             WHERE sl.album_id = a.id)::bigint AS favorite_count,
           (SELECT COUNT(DISTINCT v.viewer_id)
              FROM view_events v
              JOIN share_links sl ON sl.token = v.share_token
             WHERE sl.album_id = a.id AND v.event_type = 'page_view')::bigint AS view_count,
           (SELECT token FROM share_links
             WHERE album_id = a.id
               AND (expires_at IS NULL OR expires_at > now())
             ORDER BY created_at DESC LIMIT 1) AS token
      FROM albums a
     WHERE a.status = 'published'
     ORDER BY a.updated_at DESC
     LIMIT 5
  `;

  const recent_albums = await Promise.all(albums.map(async (a) => {
    let cover_url: string | null = null;
    if (a.cover_photo_id) {
      cover_url = await getPresignedUrl(
        `albums/${a.album_id}/${a.cover_photo_id}/web.webp`,
        3600,
      );
    }
    return {
      title: a.title,
      subtitle: a.subtitle,
      cover_url,
      photo_count: Number(a.photo_count),
      favorite_count: Number(a.favorite_count),
      view_count: Number(a.view_count),
      share_url: a.token ? `${baseUrl}/a/${a.token}` : null,
      status: a.status,
      updated_at: a.updated_at.toISOString(),
    };
  }));

  const rawEvents = await sql<{
    share_token: string; viewer_id: string; created_at: Date; album_title: string;
  }[]>`
    SELECT v.share_token, v.viewer_id, v.created_at, a.title AS album_title
      FROM view_events v
      JOIN share_links sl ON sl.token = v.share_token
      JOIN albums a ON a.id = sl.album_id
     WHERE v.event_type = 'favorite_add'
       AND v.created_at > now() - interval '7 days'
     ORDER BY v.created_at DESC
     LIMIT 200
  `;

  const recent_selections = groupFavoriteEvents(rawEvents).slice(0, 5);

  const value: WidgetSummary = {
    stats: {
      albums_total: Number(stats.albums_total),
      albums_published: Number(stats.albums_published),
      photos_total: Number(stats.photos_total),
      storage_bytes: Number(stats.storage_bytes),
    },
    recent_albums,
    recent_selections,
  };
  cache = { at: Date.now(), value };
  return value;
}

export function _resetWidgetCacheForTests() { cache = null; }
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/widgetQuery.ts
git commit -m "feat(widget): aggregator query with 60s in-process cache"
```

---

### Task 14: Widget API route

**Repo:** gallery-hub
**Files:**
- Create: `src/app/api/widget/summary/route.ts`
- Modify: `docker-compose.yml`
- Modify: `.env.example`

- [ ] **Step 1: Add env**

In `docker-compose.yml`, under `gallery-app.environment`:

```yaml
      WIDGET_TOKEN: ${WIDGET_TOKEN}
      PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}
```

In `.env.example`:

```
WIDGET_TOKEN=replace-me-with-32-random-chars
PUBLIC_BASE_URL=https://gallery.divass.space
```

- [ ] **Step 2: Implement route**

```ts
// src/app/api/widget/summary/route.ts
import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createRateLimiter } from "@/lib/rateLimiter";
import { loadWidgetSummary } from "@/lib/widgetQuery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ max: 6, windowMs: 60_000 });

function constantTimeMatch(a: string, b: string) {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

export async function GET(req: NextRequest) {
  const expected = process.env.WIDGET_TOKEN;
  if (!expected) return new Response("widget disabled", { status: 503 });

  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (!m || !constantTimeMatch(m[1], expected)) {
    return new Response("unauthorized", { status: 401 });
  }

  if (!limiter.allow(expected)) {
    return new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });
  }

  const baseUrl = process.env.PUBLIC_BASE_URL ?? "https://gallery.divass.space";
  const data = await loadWidgetSummary(baseUrl);
  return Response.json(data, {
    headers: { "Cache-Control": "no-store" },
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/widget/summary/route.ts docker-compose.yml .env.example
git commit -m "feat(api): /api/widget/summary bearer-authed widget endpoint"
```

---

### Task 15: Widget endpoint integration test

**Repo:** gallery-hub
**Files:**
- Create: `tests/integration/widget.summary.test.ts`

- [ ] **Step 1: Write test**

```ts
// tests/integration/widget.summary.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, stopTestApp, type TestEnv } from "./helpers/app";
import postgres from "postgres";

let env: TestEnv;

beforeAll(async () => {
  env = await startTestApp();
  // override env var for the spawned app: WIDGET_TOKEN baked in via helper

  const albumId = await env.seedAlbum("Anna & Oleh");
  await env.seedShareLink("WIDGETOK0001", albumId);

  // seed view_events for grouping
  const sql = postgres(env.pg.getConnectionUri());
  for (let i = 0; i < 3; i++) {
    await sql`
      INSERT INTO view_events (share_token, viewer_id, event_type, created_at)
      VALUES ('WIDGETOK0001', 'viewer-a4f12345', 'favorite_add', now() - interval '${i} minutes')
    `;
  }
  await sql`
    INSERT INTO view_events (share_token, viewer_id, event_type)
    VALUES ('WIDGETOK0001', 'viewer-anyone', 'page_view')
  `;
  await sql.end();
}, 120_000);

afterAll(() => stopTestApp(env), 30_000);

describe("/api/widget/summary", () => {
  it("rejects missing bearer", async () => {
    const r = await fetch(`${env.baseUrl}/api/widget/summary`);
    expect(r.status).toBe(401);
  });

  it("rejects wrong bearer", async () => {
    const r = await fetch(`${env.baseUrl}/api/widget/summary`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(r.status).toBe(401);
  });

  it("returns the spec-shaped JSON with valid bearer", async () => {
    const r = await fetch(`${env.baseUrl}/api/widget/summary`, {
      headers: { Authorization: `Bearer ${env.widgetToken}` },
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({
      stats: {
        albums_total: expect.any(Number),
        albums_published: expect.any(Number),
        photos_total: expect.any(Number),
        storage_bytes: expect.any(Number),
      },
      recent_albums: expect.any(Array),
      recent_selections: expect.any(Array),
    });
    expect(body.recent_selections[0]).toMatchObject({
      album_title: "Anna & Oleh",
      added_count: 3,
      viewer_id_short: "viewer-a",
      at: expect.any(String),
    });
  });

  it("rate-limits after 6 calls / minute", async () => {
    for (let i = 0; i < 6; i++) {
      await fetch(`${env.baseUrl}/api/widget/summary`, {
        headers: { Authorization: `Bearer ${env.widgetToken}` },
      });
    }
    const r = await fetch(`${env.baseUrl}/api/widget/summary`, {
      headers: { Authorization: `Bearer ${env.widgetToken}` },
    });
    expect(r.status).toBe(429);
  });
});
```

- [ ] **Step 2: Extend `helpers/app.ts` to plumb `WIDGET_TOKEN`**

In `tests/integration/helpers/app.ts`, set during spawn:

```ts
const widgetToken = "test-widget-token-32-chars-abc-1234567";
const app = spawn("node", [".next/standalone/server.js"], {
  env: {
    // ...existing env...
    WIDGET_TOKEN: widgetToken,
    PUBLIC_BASE_URL: `http://localhost:${port}`,
  },
  stdio: "inherit",
});
// then expose it on the TestEnv:
return { /* ...existing, */ widgetToken };
```

And update the `TestEnv` interface to include `widgetToken: string`.

- [ ] **Step 3: Run test**

```bash
npm run build && npx vitest run tests/integration/widget.summary.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add tests/integration/widget.summary.test.ts tests/integration/helpers/app.ts
git commit -m "test(widget): integration — auth, shape, rate limit"
```

---

## PART C — Widget Consumer (Repo: personal-hub)

### Task 16: Add env vars to personal-hub

**Repo:** personal-hub
**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Change directory to personal-hub**

```bash
cd C:/Users/VATS/Documents/Proj/py/personal-hub
```

- [ ] **Step 2: Append to `.env.example`**

```
# Gallery widget — read-only summary from gallery.divass.space
GALLERY_WIDGET_TOKEN=replace-with-the-same-token-as-WIDGET_TOKEN-in-gallery-hub
GALLERY_BASE_URL=https://gallery.divass.space
```

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "chore(env): document GALLERY_WIDGET_TOKEN + GALLERY_BASE_URL"
```

---

### Task 17: GalleryWidget server component

**Repo:** personal-hub
**Files:**
- Create: `src/components/dashboard/GalleryWidget.tsx`

- [ ] **Step 1: Implement component**

```tsx
// src/components/dashboard/GalleryWidget.tsx
import Link from "next/link";
import Image from "next/image";
import { Heart, Eye, Camera, ImageOff, ArrowRight } from "lucide-react";

interface RecentAlbum {
  title: string;
  subtitle: string | null;
  cover_url: string | null;
  photo_count: number;
  favorite_count: number;
  view_count: number;
  share_url: string | null;
  status: "draft" | "published" | "archived";
  updated_at: string;
}

interface RecentSelection {
  album_title: string;
  added_count: number;
  viewer_id_short: string;
  at: string;
}

interface WidgetSummary {
  stats: {
    albums_total: number;
    albums_published: number;
    photos_total: number;
    storage_bytes: number;
  };
  recent_albums: RecentAlbum[];
  recent_selections: RecentSelection[];
}

async function loadSummary(): Promise<WidgetSummary | null> {
  const base = process.env.GALLERY_BASE_URL;
  const token = process.env.GALLERY_WIDGET_TOKEN;
  if (!base || !token) return null;
  try {
    const r = await fetch(`${base}/api/widget/summary`, {
      headers: { Authorization: `Bearer ${token}` },
      next: { revalidate: 300 },
    });
    if (!r.ok) return null;
    return (await r.json()) as WidgetSummary;
  } catch {
    return null;
  }
}

function fmtGB(bytes: number) {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default async function GalleryWidget() {
  const data = await loadSummary();

  if (!data) {
    return (
      <section className="rounded-2xl bg-black/60 border border-white/5 p-6 mb-8">
        <div className="flex items-center gap-3 text-neutral-500">
          <ImageOff className="w-5 h-5" />
          <div>
            <div className="text-sm text-white/80 font-medium">Gallery offline</div>
            <div className="text-xs">Retry in 5 min</div>
          </div>
        </div>
      </section>
    );
  }

  const top3 = data.recent_albums.slice(0, 3);

  return (
    <section
      className="rounded-2xl bg-gradient-to-br from-neutral-950 to-black border border-white/5 p-6 mb-8"
      style={{ fontFamily: "Inter, system-ui, sans-serif" }}
    >
      <header className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-white text-base font-semibold tracking-wide">Gallery</h2>
          <p className="text-neutral-500 text-xs mt-0.5">
            {data.stats.albums_published} albums · {data.stats.photos_total} photos · {fmtGB(data.stats.storage_bytes)}
          </p>
        </div>
        <Link
          href={`${process.env.GALLERY_BASE_URL}/admin`}
          className="inline-flex items-center gap-1 text-rose-400 hover:text-rose-300 text-xs font-medium transition"
        >
          Open gallery <ArrowRight className="w-3 h-3" />
        </Link>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        {top3.map((a) => (
          <a
            key={a.title + a.updated_at}
            href={a.share_url ?? `${process.env.GALLERY_BASE_URL}/admin`}
            target="_blank"
            rel="noreferrer"
            className="group relative aspect-[4/3] rounded-xl overflow-hidden border border-white/5 bg-neutral-900"
          >
            {a.cover_url ? (
              <Image
                src={a.cover_url}
                alt={a.title}
                fill
                sizes="(max-width: 640px) 100vw, 33vw"
                className="object-cover transition group-hover:scale-105"
                unoptimized
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-neutral-700">
                <Camera className="w-8 h-8" />
              </div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent" />
            <div className="absolute bottom-0 inset-x-0 p-3">
              <div className="text-white text-sm font-medium truncate">{a.title}</div>
              <div className="flex items-center gap-3 text-[11px] mt-1">
                <span className="text-neutral-400 inline-flex items-center gap-1">
                  <Camera className="w-3 h-3" />{a.photo_count}
                </span>
                <span className="text-rose-400 inline-flex items-center gap-1">
                  <Heart className="w-3 h-3 fill-rose-400" />{a.favorite_count}
                </span>
                <span className="text-neutral-400 inline-flex items-center gap-1">
                  <Eye className="w-3 h-3" />{a.view_count}
                </span>
              </div>
            </div>
          </a>
        ))}
      </div>

      {data.recent_selections.length > 0 && (
        <div className="border-t border-white/5 pt-4">
          <h3 className="text-neutral-400 text-[11px] uppercase tracking-widest mb-2">Recent selections</h3>
          <ul className="space-y-1.5">
            {data.recent_selections.map((s, i) => (
              <li key={i} className="flex items-center justify-between text-xs">
                <span className="text-white/80 truncate">
                  <span className="text-rose-400 mr-1.5">+{s.added_count}</span>
                  {s.album_title}
                  <span className="text-neutral-600 ml-1.5">· {s.viewer_id_short}</span>
                </span>
                <span className="text-neutral-500 shrink-0 ml-2">{fmtRelative(s.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/dashboard/GalleryWidget.tsx
git commit -m "feat(widgets): add GalleryWidget server component (5-min revalidate)"
```

---

### Task 18: Mount widget on dashboard

**Repo:** personal-hub
**Files:**
- Modify: `src/app/dashboard/page.tsx`

- [ ] **Step 1: Edit page**

Replace the file with:

```tsx
import AppGrid from "@/components/dashboard/AppGrid";
import { Announcements } from "@/components/dashboard/Announcements";
import QuickActions from "@/components/dashboard/QuickActions";
import GalleryWidget from "@/components/dashboard/GalleryWidget";

export default function DashboardPage() {
  return (
    <div className="animate-fade-in">
      <Announcements />

      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-1">Мій Хаб</h1>
        <p className="text-gray-400">Що робимо сьогодні?</p>
      </div>

      <QuickActions />

      <GalleryWidget />

      <AppGrid />
    </div>
  );
}
```

- [ ] **Step 2: Manual smoke test**

```bash
npm run dev
# Visit http://localhost:3000/dashboard
# Confirm: widget renders with 3 album cards if endpoint reachable,
#         or "Gallery offline" panel if GALLERY_WIDGET_TOKEN is unset.
```

- [ ] **Step 3: Commit**

```bash
git add src/app/dashboard/page.tsx
git commit -m "feat(dashboard): mount GalleryWidget below QuickActions"
```

---

### Task 19: Widget snapshot test

**Repo:** personal-hub
**Files:**
- Create: `tests/components/GalleryWidget.test.tsx`

- [ ] **Step 1: Write test**

```tsx
// tests/components/GalleryWidget.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import GalleryWidget from "@/components/dashboard/GalleryWidget";

beforeEach(() => {
  process.env.GALLERY_BASE_URL = "https://gallery.test";
  process.env.GALLERY_WIDGET_TOKEN = "tok";
});

const fixture = {
  stats: { albums_total: 14, albums_published: 8, photos_total: 612, storage_bytes: 3_640_000_000 },
  recent_albums: [
    {
      title: "Anna & Oleh",
      subtitle: "Wedding · Oct 2026",
      cover_url: "https://gallery.test/img/a.webp",
      photo_count: 42, favorite_count: 12, view_count: 38,
      share_url: "https://gallery.test/a/Hk7eRq8x",
      status: "published" as const,
      updated_at: "2026-05-09T10:00:00.000Z",
    },
  ],
  recent_selections: [
    { album_title: "Anna & Oleh", added_count: 3, viewer_id_short: "a4f12345", at: new Date(Date.now() - 5 * 60_000).toISOString() },
  ],
};

describe("GalleryWidget", () => {
  it("renders the dark cinematic panel when fetch succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 })));
    const html = renderToString(await GalleryWidget());
    expect(html).toContain("Anna & Oleh");
    expect(html).toContain("Open gallery");
    expect(html).toContain("+3"); // recent selection added_count
    expect(html).toContain("8 albums · 612 photos");
    expect(html).toMatch(/text-rose-400/);
  });

  it("renders offline state on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })));
    const html = renderToString(await GalleryWidget());
    expect(html).toContain("Gallery offline");
    expect(html).toContain("Retry in 5 min");
  });

  it("renders offline state on network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const html = renderToString(await GalleryWidget());
    expect(html).toContain("Gallery offline");
  });
});
```

- [ ] **Step 2: Add `react-dom/server` if not present**

(Already shipped with React — no install needed.)

- [ ] **Step 3: Run test**

```bash
npx vitest run tests/components/GalleryWidget.test.tsx
```

Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add tests/components/GalleryWidget.test.tsx
git commit -m "test(widgets): GalleryWidget — success, 500, network-error"
```

---

## Cross-cutting cleanup

### Task 20: Verify full suite + final commit

**Repo:** gallery-hub

- [ ] **Step 1: Run all gallery-hub tests**

```bash
cd C:/Users/VATS/Documents/Proj/py/gallery-hub
npm run build
npx vitest run
```

Expected: all unit + integration tests pass.

- [ ] **Step 2: Run all personal-hub tests**

```bash
cd C:/Users/VATS/Documents/Proj/py/personal-hub
npx vitest run
```

Expected: all tests pass including the new widget snapshot tests.

- [ ] **Step 3: Manual end-to-end check**

1. `cd gallery-hub && docker compose up -d` — confirm migrations 007 + 008 applied.
2. Open `https://gallery.local/a/<token>` — Export modal shows 3 options with correct byte sizes.
3. Click Download ZIP — file downloads, opens in OS, contains photos with `001-`, `002-`, … prefixes.
4. Click Download again within 24h — second request is fast (presigned redirect).
5. `cd personal-hub && npm run dev` — dashboard shows GalleryWidget with up-to-3 albums + recent selections.
6. Stop `gallery-app` container — refresh dashboard → "Gallery offline · retry in 5 min".

- [ ] **Step 4: Tag M4**

```bash
cd C:/Users/VATS/Documents/Proj/py/gallery-hub
git tag m4-export-widget
```

---

## Self-Review

**Spec coverage:**

- Section 3 export flow: ZIP generated + cached 24h (Task 6), MinIO metadata `favorites_signature` + `expires` (Task 6), presigned GET re-use (Task 6 step 3 — `Response.redirect(presigned, 302)`), reaper for stale objects (Task 10).
- Section 6 widget endpoint: every field in spec JSON produced — `stats.*` (Task 13 stats query), `recent_albums[].cover_url` (presigned, 1h, Task 13), `photo_count`/`favorite_count`/`view_count` (Task 13 subqueries), `share_url` (active link only, Task 13), `recent_selections[]` (Tasks 12 + 13 — grouped from `view_events`). Bearer auth + rate limit + 60s cache: Tasks 11 + 14.
- M2 backfill of `web_bytes`/`large_bytes` flagged in Task 2 with `Modifies M2 file:`.
- Cross-repo work: every task has a `**Repo:**` line. Tasks 1–15 + 20 are `gallery-hub`. Tasks 16–19 are `personal-hub`.
- Concrete code (not placeholders): rate-limit algorithm (Task 11), favorites-signature hash (Task 4), stream fan-out (Task 5), widget JSX with Tailwind classes (Task 17).
- Out of scope confirmed: multi-link-per-album, email notifications — not in any task.

**Type consistency:** `ExportScope = "favorites" | "all"` and `ExportVariant = "original" | "web"` used identically in Tasks 4, 6, 9. `GroupedSelection` shape produced by Task 12 matches what Task 13 returns and Task 17 consumes.
