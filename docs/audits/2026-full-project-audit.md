# Gallery-Hub Full-Project Audit

**Date:** 2026-05-31

## Scope & Methodology

This report consolidates a full-project security, correctness, performance, and data-integrity audit of the **gallery-hub** Next.js codebase. Twelve area reviewers independently examined distinct slices of the system — workspace isolation, upload/storage quotas, React client hooks, export/ZIP DoS surface, workers & background jobs, settings/notifications admin, cross-cutting completeness, auth/session/middleware, SQL data layer, public-share IDOR, Next.js caching/SSR, and error-handling/type-safety. Every candidate finding was then re-examined by an adversarial verifier running on Opus that re-read the actual source, traced the full data flow, and either confirmed, adjusted severity, or rejected the finding; the verifier's reasoning is reflected in the severity assigned here (`original_severity` was revised where the verifier found the impact narrower or broader than first reported).

After verification, findings were de-duplicated across areas: several issues were reported by two reviewers from different angles (notably the `/chikaq` dashboard leak, the notifications-admin authorization gap, the `getAlbumBySlug` owner-role collision, the fan-out ZIP backpressure bug, the favorite-toggle IDOR, and the `setCover` validation gap). These have been merged below into single findings that record **both** reporting areas and retain the **higher** severity. The merge reduced 61 raw confirmed findings to **53 distinct findings**. No findings were invented or inflated; rejected candidates (4) are excluded entirely, and there were no uncertain findings to carry forward.

## Summary (distinct findings, post-merge)

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 6 |
| Medium   | 23 |
| Low      | 24 |
| **Total** | **53** |

> Raw confirmed findings before cross-area de-duplication: 61 (0 critical / 9 high / 25 medium / 27 low). Rejected by verifier: 4. Uncertain: 0.

---

## Critical

_No critical findings._

---

## High

### [HIGH] F1 — /chikaq dashboard leaks every workspace's albums, photos, view counts, storage and viewer activity to any non-owner admin
- **Area:** workspace-isolation + cross-cutting-completeness (reported by both)
- **File:** `src/app/chikaq/page.tsx:180-201` (guard at 180-181); nav gap at `src/app/admin/layout.tsx:41`; middleware gate at `src/middleware.ts:118-126`
- **Category:** Security
- **Evidence:**
  ```ts
  const auth = await requireAdminSessionFromCookies();
  if (!auth.ok) redirect("/admin/login?next=/chikaq");
  ...
  const [stats, trendRaw, topAlbums, activity, storage, tileSeries] = await Promise.all([
    loadInsightsStats(), loadViewsTrend(days), loadTopAlbums(5, days),
    loadRecentActivity24h(20), storagePromise, loadTileSparklines(days),
  ]);
  ```
- **Why it matters:** The page gates only on `requireAdminSessionFromCookies()` (any logged-in admin), never on role/owner, and the nav item lacks `ownerOnly: true` (unlike `/admin/metrics`, `/admin/users`, `/admin/settings`). Every aggregator it calls is installation-wide with no `owner_user_id` filter: `loadInsightsStats` counts all albums/photos/bytes, `loadTopAlbums`/`loadRecentActivity24h` return other admins' album titles, viewer-id prefixes and download sizes, and `getStorageUsage` reports whole-bucket/DB totals. A non-owner admin (workspace B) thus reads gallery-wide metrics plus admin A's private album titles and a live cross-workspace activity feed — a direct breach of the per-admin isolation the 021 migration established. (Downgraded critical→high: read-only aggregate metadata, not photo content/credentials/write access.)
- **Suggested fix:** Gate the page with `requireOwner()` and add `ownerOnly: true` to the nav item, OR thread an `AdminViewer` into every aggregator and add `AND a.owner_user_id = $userId` scoping for the non-owner branch.

### [HIGH] F2 — Finalize trusts client-supplied byte size; `orig_bytes` is never reconciled, defeating every quota
- **Area:** upload-storage-quota
- **File:** `src/app/api/upload/finalize/route.ts:88` (block 70-96); unreconciled at `workers/generateDerivatives.ts:88` and `src/lib/albums.ts:556-566`
- **Category:** Data-integrity
- **Evidence:**
  ```ts
  await insertPhotosBatch(sanitized.map((p) => ({ ... orig_bytes: p.size, ... })));
  ```
- **Why it matters:** `finalize` writes `orig_bytes` straight from the client body with no type/finite/`<= max_file_size` check; the derivatives worker re-derives width/height but never updates `orig_bytes`, so it stays permanently client-controlled. Every quota (per-album cap, per-user total, per-user album, global `block_uploads_when_full`) and the storage dashboards sum `orig_bytes`. An admin can PUT a real 50 MB file then `finalize` with `size: 0` (unlimited uploads register as zero bytes) or `size: -1e9` (poisons the global SUM negative, masking other users' real usage).
- **Suggested fix:** Don't trust `p.size`. HeadObject the presigned key at finalize and persist real `ContentLength`, or stamp `orig_bytes` = real object length in the worker (the edit route already does `orig_bytes = outBuf.length`). At minimum validate `0 < size <= max_file_size_mb*1024*1024` and finite width/height.

### [HIGH] F3 — Notifications page + all notification actions use `requireAdmin()` not `requireOwner()`, exposing global cross-workspace data and global rule mutation to non-owner admins
- **Area:** settings-notifications-admin + cross-cutting-completeness (reported by both)
- **File:** `src/app/admin/notifications/page.tsx:49`; `src/app/admin/notifications/actions.ts:26, 64, 102, 124`
- **Category:** Security
- **Evidence:**
  ```ts
  export default async function NotificationsPage(): Promise<React.JSX.Element> {
    await requireAdmin();
  ```
- **Why it matters:** `notification_rules` and `notification_log` are global (no owner column). The page reads the last 50 log rows — including the owner's private Telegram `chat_id`, other workspaces' album titles, viewer ids and `last_error` strings — and every action (`updateRule`, `testNotification`, `replayFailed`) gates only on `requireAdmin()`. The middleware checks only `session.userId`. So any authenticated non-owner admin can read cross-workspace notification data, mutate the global rules (disable/retune alerts for the whole deployment), fire test messages to the owner's chat, and replay arbitrary dispatches — a workspace-boundary breach plus privilege escalation. (cross-cutting reported this at medium; kept at high per the higher severity.)
- **Suggested fix:** Replace `requireAdmin()` with `requireOwner()` in the page and all four actions, matching the owner-only gating already used for `/admin/settings` and `/admin/metrics`.

### [HIGH] F4 — Fan-out ZIP ignores `write()` backpressure → unbounded memory buffering (OOM DoS)
- **Area:** export-zip-dos + error-handling-typesafety (reported by both)
- **File:** `src/lib/zipStream.ts:60-67`; consumer plumbing at `src/app/api/export/[token]/route.ts:357-374, 417`
- **Category:** Performance
- **Evidence:**
  ```ts
  archive.on("data", (chunk: Buffer) => {
    toHttp.write(chunk);
    toMinio.write(chunk);
  });
  ```
- **Why it matters:** Attaching a `data` listener puts archiver in flowing mode; the handler writes each chunk to both PassThroughs but ignores the boolean return of `write()` and never pauses `archive`. The two consumers (HTTP client download vs. S3 upload) drain at independent speeds, so the slower side's PassThrough buffers without bound. A multi-GB `original` export to a slow/trickling client accumulates the un-drained ZIP in the Node heap and OOM-kills the process. The misleading comment claims backpressure "stalls the archiver", but the manual `.on('data')` pump silently buffers instead. (error-handling reported at medium; kept high.)
- **Suggested fix:** Replace the manual fan-out with `pipe()`-based plumbing, or implement a writable that pauses `archive` when either `write()` returns false and resumes on both PassThroughs' `drain`, gating progress on the slower consumer.

### [HIGH] F5 — No total-size or photo-count cap on export → resource-exhaustion DoS
- **Area:** export-zip-dos
- **File:** `src/app/api/export/[token]/route.ts:202-208` (unbounded query); gating gap at 357-390
- **Category:** Performance
- **Evidence:**
  ```sql
  SELECT id, filename, sort_order, updated_at::text AS updated_at FROM photos
   WHERE album_id = ${status.link.album_id} AND status = 'ready'
   ORDER BY sort_order ASC, created_at ASC
  ```
- **Why it matters:** The `all` scope selects every ready photo with no LIMIT and no aggregate byte ceiling. `original` streams full-res sources; `web` serially fetches one imgproxy render per photo. A 5,000-photo album produces a tens-of-GB ZIP, holding an open MinIO Upload for minutes (and combined with F4, an OOM). The route computes `SUM(orig_bytes)` but only at line 385 — *after* the build is kicked off — so it cannot gate. The per-viewer rate limiter is bypassable (see F25). Any visitor of a download-enabled share link can trigger this repeatedly.
- **Suggested fix:** Move the size + photo-count lookup *before* `createFanOutZip`; reject with 413 if either exceeds a configured `MAX_EXPORT_BYTES`/`MAX_EXPORT_PHOTOS` ceiling.

### [HIGH] F6 — Derivatives batch handler re-processes already-succeeded jobs when any sibling in the batch fails
- **Area:** workers-jobs
- **File:** `workers/index.ts:45-67` (re-throw at line 66); root cause `node_modules/pg-boss/src/manager.js:213-220`
- **Category:** Correctness
- **Evidence:**
  ```ts
  const results = await Promise.allSettled(jobs.map(async (job) => { ... }));
  const firstReject = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (firstReject) throw firstReject.reason;
  ```
- **Why it matters:** With `batchSize=6`, pg-boss completes or fails **all** fetched jobs by a single handler result. The handler runs all 6 photos then re-throws the first rejection, so one poison original (corrupt → sharp throws) fails the whole batch and requeues all 6 — including the 5 that already flipped to `status='ready'`. Those 5 get fully re-downloaded and re-processed on every retry; with immediate retries the MinIO GET / sharp / exifr / thumbhash amplification is near-instant. (Data stays correct because re-processing is idempotent; impact is wasted resources/throughput.)
- **Suggested fix:** Catch per-job inside the handler and resolve normally so pg-boss completes the batch; record failures out-of-band (one job per `boss.send`, or call `boss.fail(queue, job.id, err)` only for failed ids). Do not re-throw.

### [HIGH] F7 — Photos stuck in `status='processing'` forever after derivative retries exhaust (no dead-letter, no reconciliation)
- **Area:** workers-jobs
- **File:** `src/lib/jobs.ts:24` (queue created with no `deadLetter`); `workers/generateDerivatives.ts:67-95`; insert at `src/lib/albums.ts:332`
- **Category:** Correctness
- **Evidence:**
  ```ts
  await finalizePhotoMetadata(data.photo_id, { width, height, takenAt, thumbhash, exif });
  // insertPhotosBatch inserts status: "processing"; only finalizePhotoMetadata flips it to 'ready'
  ```
- **Why it matters:** Photos insert at `processing` and only become `ready` on a successful derivative job. The queue has no dead-letter, no alert, and nothing reconciles stuck rows. When a job fails permanently (corrupt original, sharp/exifr throw, MinIO outage outliving the retries), the photo is invisible to viewers/exports (which select `status='ready'`), shows as perpetually `processing` with null ETA in the admin tracker, and its MinIO object is stored forever for an asset that never renders.
- **Suggested fix:** Configure a dead-letter queue on `GENERATE_DERIVATIVES_QUEUE` and drain it (flip to a terminal `failed` status the UI can surface/retry, or run a periodic sweep that re-enqueues `processing` photos older than N minutes). At minimum emit an alert when a derivative job dead-letters.

---

## Medium

### [MEDIUM] F8 — Owner can be permanently locked out by disabling the owner account via a crafted request
- **Area:** auth-session-middleware
- **File:** `src/lib/users.ts:121-163` (missing guard; `disabled_at` CASE at 146-150); enabling path at `src/app/admin/users/_actions.ts:63-94`
- **Category:** Data-integrity
- **Evidence:**
  ```sql
  disabled_at = CASE
    WHEN ${input.disabled === undefined} THEN disabled_at
    WHEN ${input.disabled === true} THEN COALESCE(disabled_at, ${disabledAt})
    ELSE NULL END
  ```
- **Why it matters:** `updateUser()` guards owner demotion and `deleteUser()` guards owner deletion, but nothing prevents `disabled=true` on the owner row. The UI only hides the control client-side; `updateUserAction` forwards `disabled` with no server-side target-role re-check. A crafted POST (any authenticated owner passes `requireOwner`) disables the single owner; since login and session checks reject `disabled_at IS NOT NULL` and only owners can re-enable, this is a full, in-app-irrecoverable lockout (recovery needs direct DB access or re-running the bootstrap script). (Downgraded high→medium: requires the authenticated owner; self-inflicted, documented recovery path.)
- **Suggested fix:** Mirror the demote/delete guards: in `updateUser()`, if `current.role === 'owner' && input.disabled === true`, throw "cannot disable the owner". Also re-check target role in `updateUserAction`.

### [MEDIUM] F9 — Quota race (TOCTOU): byte caps checked at presign but only file-count re-checked at finalize
- **Area:** upload-storage-quota
- **File:** `src/app/api/upload/finalize/route.ts:50-62`; byte quotas only at `src/app/api/upload/presign/route.ts:74-167`
- **Category:** Data-integrity
- **Evidence:**
  ```ts
  const currentCount = Number(countRows[0]?.n ?? "0");
  if (currentCount + body.photos.length > settings.uploads.max_files_per_album) { ... }
  // NO re-check of orig_bytes / per-album GB / per-user quotas here
  ```
- **Why it matters:** Presign enforces per-album GB, per-user-total and per-user-album byte quotas; finalize re-checks only `max_files_per_album`. No transaction or row lock serializes the quota read+write, so N batches presigned concurrently each see the pre-batch total, all pass, and all finalize — overshooting `max_album_gb` or per-user caps. A single double-click reproduces it. Combined with F2, byte quotas are effectively advisory.
- **Suggested fix:** Re-evaluate per-album and per-user byte quotas inside finalize (after computing trustworthy sizes), within a transaction that locks the album/user counter rows; reject with 507 if the incoming bytes exceed the cap.

### [MEDIUM] F10 — Photo-edit route bypasses all storage/quota enforcement and can be looped to inflate storage
- **Area:** upload-storage-quota
- **File:** `src/app/api/photos/[id]/edit/route.ts:142-163`; guards bypassed live in `src/app/api/upload/presign/route.ts:56-168`
- **Category:** Data-integrity
- **Evidence:**
  ```ts
  await s3Client.send(new PutObjectCommand({ Bucket: BUCKET, Key: orig.key, Body: outBuf, ... }));
  // SET ... orig_bytes = ${outBuf.length}, status = 'processing' ... WHERE id = ${photoId}
  ```
- **Why it matters:** The edit route re-encodes and writes a new original plus updated `orig_bytes`, but runs no `block_uploads_when_full` check and no per-album/per-user quota check. A non-owner admin can loop edits (rotate/rotate-back) on their own photos to grow `orig_bytes` past `max_album_gb`/per-user quota and keep writing while storage is full. There is also no `sharp` `limitInputPixels`, so a very large original is fully decoded into memory on every edit.
- **Suggested fix:** Run the same `getStorageUsage()`/`block_uploads_when_full` and per-album/per-user quota checks used in presign before writing; reject with 507 over cap. Clamp source pixel dimensions (`sharp limitInputPixels`).

### [MEDIUM] F11 — `getAlbumBySlug` owner-role lookup can resolve to the wrong workspace's album
- **Area:** workspace-isolation + sql-data-layer (reported by both)
- **File:** `src/lib/albums.ts:82-89` (owner branch); routing via `src/components/admin/AlbumCard.tsx:16`, `src/app/admin/albums/[slug]/page.tsx:45`
- **Category:** Correctness
- **Evidence:**
  ```ts
  if (viewer.role === "owner") {
    const rows = await sql`SELECT * FROM albums
       WHERE slug = ${slug} AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1`;
    return rows[0] ?? null;
  }
  ```
- **Why it matters:** Migration 021 made slugs unique only per `(owner_user_id, slug)`, so two admins can both own `summer-2026`. The owner branch matches slug across all workspaces and returns the single most-recently-updated row with no owner disambiguation. Admin cards link by bare slug, so the owner clicking admin A's card may view/edit admin B's album — and any subsequent mutation (update/soft-delete/setCover) targets B's id, a destructive action against the wrong workspace.
- **Suggested fix:** Route owner-facing album detail pages by album id (or `ownerId + slug`) rather than bare slug; if slug routing stays, thread the intended `owner_user_id` so the owner branch matches the exact row instead of guessing by recency.

### [MEDIUM] F12 — Album detail page exposes whole-library storage total (`library_bytes`) to a non-owner admin
- **Area:** workspace-isolation
- **File:** `src/lib/albumStats.ts:72-75`
- **Category:** Security
- **Evidence:**
  ```ts
  const libRows = await sql`SELECT COALESCE(SUM(orig_bytes), 0)::bigint AS bytes FROM photos`;
  const libraryBytes = Number(libRows[0]?.bytes ?? 0);
  ```
- **Why it matters:** `loadAlbumStats` is reached after a correctly scoped `getAlbumBySlug`, but `library_bytes` is an unscoped SUM over all photos in the installation. It is surfaced in `StatsStrip` as "X% of library", so a non-owner admin viewing their own album can back-derive the total byte footprint of every other admin's photos combined — a cross-workspace storage disclosure (only when no per-album cap is configured).
- **Suggested fix:** Pass the `AdminViewer` into `loadAlbumStats`; for non-owners scope the query via `JOIN albums a ON a.id = p.album_id WHERE a.owner_user_id = $userId`. Owner keeps the global total.

### [MEDIUM] F13 — Unlock cookie scoped to `/a/{token}` is never sent to `/api/export/{token}` or `/api/viewer-context/{token}` (password-protected albums always 401/404)
- **Area:** public-share-idor
- **File:** `src/app/a/[token]/_actions.ts:146-152`; failures at `src/app/api/export/[token]/route.ts:129,143-148` and `src/app/api/viewer-context/[token]/route.ts:64,69-71`
- **Category:** Correctness
- **Evidence:**
  ```ts
  jar.set(unlockCookieName(token), signUnlockValue(token, Date.now()), {
    httpOnly: true, sameSite: "lax", secure: ..., path: `/a/${token}`, maxAge: UNLOCK_TTL_SECONDS,
  });
  ```
- **Why it matters:** The unlock cookie is written with `path: /a/${token}`, so per RFC 6265 the browser never sends it to the `/api/...` routes that read it. After a successful unlock, every export resolves to `locked` → 401 and viewer-context returns 404, so downloads and favorites/heart hydration silently break on **every** password-protected gallery. Fail-closed (no data exposure) but a guaranteed-broken common path.
- **Suggested fix:** Set the unlock cookie at `path: '/'` (the viewer cookie already does this); the HMAC is token-bound so widening the path is safe.

### [MEDIUM] F14 — `newViewers7d` metrics query does a full-table scan + aggregation over all `view_events`
- **Area:** sql-data-layer
- **File:** `src/lib/metrics.ts:134-142`
- **Category:** Performance
- **Evidence:**
  ```sql
  SELECT COUNT(*)::bigint AS count FROM (
    SELECT viewer_id, MIN(created_at) AS first_seen FROM view_events GROUP BY viewer_id
  ) v WHERE v.first_seen > now() - interval '7 days'
  ```
- **Why it matters:** The inner `GROUP BY viewer_id` has no WHERE clause and there is no index on `viewer_id`, so Postgres must scan + hash-aggregate the entire `view_events` table before the outer 7-day filter applies. This violates the file's own "always index-bounded" claim; on a busy site (millions of rows) every `/admin/metrics` load triggers a seq scan, and `getViewsMetrics` gates the whole `Promise.all` on this slowest query.
- **Suggested fix:** Add an index supporting the first-seen computation (on `viewer_id`), rewrite as a created-at-prunable anti-join, or precompute first-seen in a materialized rollup. At minimum correct the header comment.

### [MEDIUM] F15 — Optimistic-favorite race: rapid re-tap during in-flight request is dropped, then clobbered by the resolving response
- **Area:** react-client-hooks
- **File:** `src/components/gallery/PhotoTile.tsx:246-274` (guard at 254; clobber at 258-260)
- **Category:** Correctness
- **Evidence:**
  ```ts
  if (inflight.current) return;
  inflight.current = true;
  startTransition(async () => {
    const res = await toggleFavorite(token, photoId);
    setFavorited(res.favorited);
    toggleFavoritedId(photoId, res.favorited);
  ```
- **Why it matters:** The inflight guard drops a toggle issued while a request is pending, but the first request's response then overwrites the newer optimistic state. Reversing direction via the heart button mid-flight (tap1 favorite, tap2 un-favorite) leaves the DB at tap1's state while the user wanted tap2, and the badge ends off by one. (Downgraded high→medium: needs a deliberate direction-reversing rapid re-tap; bounded blast radius, DB self-consistent.)
- **Suggested fix:** Track the latest desired state and re-issue after the in-flight call settles if it changed, serialize toggles through a queue, or only apply the server response if it still matches the locally-recorded latest intent.

### [MEDIUM] F16 — Lightbox favorite rollback uses `!intent` instead of captured previous state, plus the same inflight-drop clobber
- **Area:** react-client-hooks
- **File:** `src/components/gallery/Lightbox.tsx:90-105` (rollback at 100; guard at 93; stale clobber at 98)
- **Category:** Correctness
- **Evidence:**
  ```ts
  function commitToggle(intent: boolean) {
    setFavorited(intent);
    if (intent) setBurst((b) => b + 1);
    if (inflight.current) return;
    inflight.current = true;
    startTransition(async () => {
      try { const res = await toggleFavorite(token, photoId); setFavorited(res.favorited); }
      catch { setFavorited(!intent); }
  ```
- **Why it matters:** Two defects: (1) on error the rollback is `setFavorited(!intent)` not the actual previous value — a double-tap-like (`intent=true`) on an already-favorited photo wrongly empties the heart on a network error; (2) the same inflight-drop-then-clobber race as F15. Because the Lightbox is a single full-screen image the wrong heart state is highly visible.
- **Suggested fix:** Capture `const prev = favorited` and roll back to `prev`; adopt the same latest-intent reconciliation recommended for F15.

### [MEDIUM] F17 — Dropzone retains every uploaded `File` in a ref Map for the component lifetime (unbounded memory under multi-batch sessions)
- **Area:** react-client-hooks
- **File:** `src/components/admin/Dropzone.tsx:240` (declaration), 330 (insert); no delete/clear anywhere
- **Category:** Performance
- **Evidence:**
  ```ts
  const fileMap = useRef<Map<string, File>>(new Map());
  // ... fileMap.current.set(id, f);  (never deleted)
  ```
- **Why it matters:** Every dropped File is inserted and never removed. Dropzone is mounted without a `key` and `onComplete` calls `router.refresh()` (no remount), so the Map survives batch after batch in one session. Under the documented heavy path (150-200 photos × multiple batches) it grows monotonically, pinning file handles/blobs and pressuring tab memory. The `measure()` object URLs are already revoked; the File refs need the same discipline.
- **Suggested fix:** Delete each entry once its row reaches a terminal (uploaded/error) state, and/or clear per-batch on completion.

### [MEDIUM] F18 — Cookieless real visitors are misclassified as "admin preview" via `ADMIN_PREVIEW_VIEWER_ID` fallback
- **Area:** nextjs-caching-ssr
- **File:** `src/app/api/viewer-context/[token]/route.ts:82-84` (gate at 91); duplicated at `src/app/a/[token]/p/[photoId]/page.tsx:64-66` and `src/app/a/[token]/favorites/page.tsx:72-74`
- **Category:** Correctness
- **Evidence:**
  ```ts
  const viewerId = isAdminPreview
    ? ADMIN_PREVIEW_VIEWER_ID
    : (jar.get(VIEWER_COOKIE)?.value ?? ADMIN_PREVIEW_VIEWER_ID);
  ```
- **Why it matters:** A real non-admin visitor with no `gh_viewer` cookie (privacy mode, cookie blockers, ITP, direct API hit) collapses onto the admin sentinel, so the `if (viewerId !== ADMIN_PREVIEW_VIEWER_ID)` block is skipped: no `page_view`, no `gallery_view`, no first-view notification, no `recordIpTokenHit`. All cookieless visitors share one id, silently corrupting per-viewer analytics. (Downgraded high→medium: the "admin preview" banner is gated on the real admin session, not cookie absence, so paying clients do not see the banner; favorites self-heal; impact is the cookieless minority.)
- **Suggested fix:** Use the sentinel only when `isAdminPreview` is true; for a cookieless non-admin mint/assign a fresh anonymous id (the repo's `resolveViewerId()` helper already does this) or short-circuit without setting `isAdminPreview` and without skipping view tracking.

### [MEDIUM] F19 — Session replay left enabled (`disable_session_recording: false`) on a private client gallery, contradicting the code's own comment
- **Area:** nextjs-caching-ssr
- **File:** `src/components/PostHogProvider.tsx:51-52`
- **Category:** Data-integrity
- **Evidence:**
  ```ts
  // Session replay is opt-in inside the PostHog UI; default off here.
  disable_session_recording: false,
  ```
- **Why it matters:** The comment says "default off" but `false` is the opposite — recording defers to PostHog remote config rather than being locally killed. The provider is mounted for every non-admin viewer of private galleries; a one-click enable of session replay in the PostHog project would start capturing DOM/screen recordings of clients browsing their own private photos, which the operator believes is disabled. Latent privacy footgun for a private-gallery SaaS.
- **Suggested fix:** Set `disable_session_recording: true`, or env-gate it (`PH_SESSION_REPLAY=1`); at minimum fix the comment/value mismatch.

### [MEDIUM] F20 — `'all'`-scope export cache is never invalidated on photo changes → stale/incorrect ZIP served
- **Area:** export-zip-dos
- **File:** `src/app/api/export/[token]/route.ts:262` (constant `all` signature), cache-hit redirect 269-300; `src/lib/exportCache.ts:28-36`; `workers/exportReaper.ts:4-39`
- **Category:** Data-integrity
- **Evidence:**
  ```ts
  const sig = scope === "favorites" ? favoritesSignature(photos.map((p) => p.id)) : "all";
  const cacheKey = buildCacheKey(token, scope, variant, new Date());
  // cachedSig === sig → serve cached blob via presigned redirect
  ```
- **Why it matters:** For `scope='all'` the signature is the literal `"all"` and the key varies only by token/variant/day, so once cached, every same-day request returns the cached blob regardless of album mutations. No mutation deletes the `exports/{token}/` cache. After an admin deletes a sensitive photo (or adds photos), a viewer who exported earlier that day keeps downloading the old ZIP for up to ~24h — a privacy-after-deletion hazard. (Favorites scope is correctly fingerprinted; `all` is not. Downgraded high→medium: bounded to one calendar day, requires a prior same-day export.)
- **Suggested fix:** Make the `all` signature content-derived (hash sorted `(photo_id, updated_at/sort_order)` tuples) and store it as the metadata signature, OR invalidate `exports/{token}/` on any album/photo mutation.

### [MEDIUM] F21 — Per-viewer rate limiter is trivially bypassable and grows unbounded (memory DoS)
- **Area:** export-zip-dos
- **File:** `src/app/api/export/[token]/route.ts:163-187` (key at 179); root cause `src/lib/rateLimiter.ts:21-42`
- **Category:** Security
- **Evidence:**
  ```ts
  let viewerId = jar.get(VIEWER_COOKIE)?.value ?? "";
  if (!viewerId) { viewerId = randomUUID(); ... }
  if (!probe && !exportLimiter.allow(`${token}|${viewerId}`)) { ... }
  ```
- **Why it matters:** The limiter key folds in a client-controlled (or freshly minted) `viewerId`, so a scripted client sending no cookie — or rotating it — gets a brand-new bucket every request and the 6/60s cap never fires. The limiter Map never evicts keys, so attacker-unique keys grow it without bound (slow memory leak). Each unmetered request can also launch a full (uncapped, F5) ZIP build.
- **Suggested fix:** Rate-limit cookieless/anon hits by a server-trusted key (client IP via the existing `client-ip.ts` resolver), don't fold a freshly-minted UUID into the limiter, and add periodic eviction of empty/expired bucket keys.

### [MEDIUM] F22 — imgproxy watermark applied at 60% opacity with no scale (≈10× stronger than intended 6%), defacing every watermarked photo
- **Area:** workers-jobs
- **File:** `src/lib/imgproxy.ts:175` (block 171-177)
- **Category:** Correctness
- **Evidence:**
  ```ts
  // Subtle bottom-right stamp with 6% opacity, 20px inset, 25% scale...
  parts.push(`watermark:0.6:soea:20:0.25`);
  ```
- **Why it matters:** imgproxy's format is `watermark:opacity:position:x_offset:y_offset:scale`. The 4-field string is parsed as opacity=0.6 (60%), position=soea, x_offset=20, y_offset=0.25 (≈0px), and **no scale** (native-size composite). The intended `0.25` scale is consumed as a fractional y-offset and opacity is ~10× the legacy 6%. Every watermarked album ships a ~50-60%-opacity, full-size wordmark on public/lightbox/cover variants — heavy defacement.
- **Suggested fix:** Use the 5-field grammar tuned for the 0.9 PNG opacity, e.g. `watermark:0.06:soea:20:20:0.25`; verify against the running imgproxy version and add a test asserting the produced options string.

### [MEDIUM] F23 — Reaper deletes album DB rows even when S3 object deletion partially failed, orphaning storage permanently
- **Area:** workers-jobs
- **File:** `workers/reaper.ts:13-30` (DeleteObjects ignores `Errors`; `hardDeleteAlbum` called unconditionally)
- **Category:** Data-integrity
- **Evidence:**
  ```ts
  await s3Client.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys, Quiet: true } }));
  for (const id of ids) { await deletePrefix(`albums/${id}/`); await hardDeleteAlbum(id); }
  ```
- **Why it matters:** `DeleteObjects` returns HTTP 200 even when individual keys fail (failures appear only in the `Errors` array, which is ignored). `handleReap` then unconditionally hard-deletes the album row; since `listSoftDeletedAlbumIds` only returns `deleted_at IS NOT NULL` rows, any objects that failed to delete are orphaned forever — no DB row points at them and no future pass revisits them, silently growing storage.
- **Suggested fix:** Inspect the `Errors` array in `deletePrefix` and throw / skip `hardDeleteAlbum` if any key failed (leaving the album soft-deleted for the next pass), or re-list the prefix and only hard-delete when empty.

### [MEDIUM] F24 — Telegram settings (token, chat_id, enabled, events) saved to `app_settings` are dead config — never read by the dispatcher or worker
- **Area:** settings-notifications-admin
- **File:** `src/app/admin/settings/_actions.ts:189-194`
- **Category:** Correctness
- **Evidence:**
  ```ts
  await saveSettings({ telegram: { bot_token, chat_id, enabled, events } }, owner.userId);
  ```
- **Why it matters:** The dispatch path reads none of this: `dispatchNotification` uses `process.env.TELEGRAM_CHAT_ID` and gates on `notification_rules.enabled`; the worker uses `process.env.TELEGRAM_BOT_TOKEN`. `settings.telegram` is only read for display. An owner who unticks "enabled" or an event sees "Saved" but alerts keep firing, because real control lives in `notification_rules` + env vars. The two event taxonomies even diverge.
- **Suggested fix:** Either wire the dispatcher/worker to read `app_settings` (falling back to env) so the UI is authoritative, or remove the non-functional fields and point operators at `/admin/notifications` + env vars. Reconcile the event-key lists either way.

### [MEDIUM] F25 — Plaintext Telegram bot token persisted at rest in `app_settings` with no consumer
- **Area:** settings-notifications-admin
- **File:** `src/app/admin/settings/_actions.ts:170-191`; plaintext JSONB write at `src/lib/settings.ts:236-244`
- **Category:** Security
- **Evidence:**
  ```ts
  let bot_token = envTokenSet ? "" : current.telegram.bot_token;
  if (!envTokenSet && replaceToken) { ... bot_token = incomingToken; }
  await saveSettings({ telegram: { bot_token, ... } }, ...);
  ```
- **Why it matters:** When `TELEGRAM_BOT_TOKEN` env is unset, the operator-pasted token is written verbatim into the `app_settings` JSONB column, unencrypted — a real secret at rest (full bot control) that a DB dump leaks — yet nothing in the dispatch/worker path ever reads it. Zero operational benefit, real exfiltration target.
- **Suggested fix:** Don't persist the bot token in `app_settings`. Make `TELEGRAM_BOT_TOKEN` env-only (reject an incoming token, or store only a non-secret "configured" flag); if DB-stored secrets are required, encrypt with a KMS/app key.

### [MEDIUM] F26 — `notification_rules.min_interval_seconds` throttle is configured but never enforced by the dispatcher
- **Area:** settings-notifications-admin
- **File:** `src/lib/notifications.ts:78-115` (`dispatchNotification`); `getRule` 62-72; NaN sub-defect at `src/app/admin/notifications/actions.ts:42`
- **Category:** Correctness
- **Evidence:**
  ```ts
  const rule = await getRule(args.event_type);
  if (!rule.enabled) return { id: null, skipped: true, skip_reason: "disabled" };
  // [no use of rule.min_interval_seconds anywhere]
  ```
- **Why it matters:** The docstring and UI present `min_interval_seconds` as a per-chat throttle the dispatcher honours, but it is never read — only the dedup key (which collapses identical tuples, not a rolling rate window). An operator setting a 600s interval to suppress export spam still gets the flood. The default seeds rely on this no-op throttle. A secondary defect: a non-numeric form value yields `NaN` written to the INT column.
- **Suggested fix:** Enforce `min_interval_seconds` before insert (skip if `now - last < interval` for the event/chat), and coerce `NaN`→0 in `updateRule`. If the throttle is intentionally unimplemented, remove the UI field and docstring claims.

### [MEDIUM] F27 — Favorite-toggle does not verify the photo belongs to the share token's album (cross-album/cross-workspace favorite injection + size/existence oracle)
- **Area:** error-handling-typesafety + public-share-idor (reported by both)
- **File:** `src/app/a/[token]/_actions.ts:87` (missing check); root insert `src/lib/favorites.ts:20-23`; leaks via `src/lib/exportSizes.ts:65-71`
- **Category:** Security
- **Evidence:**
  ```ts
  const res = await toggleFavoriteForViewer(token, photoId, viewerId);
  ```
- **Why it matters:** `toggleFavorite` validates only that the share link resolves, never that the client-supplied `photoId` belongs to `status.link.album_id`. `toggleFavoriteForViewer` does an unconditional INSERT (FK only ties to `photos(id)`, not the album), so a viewer holding any valid token can favorite any photo UUID system-wide — including another admin's private album. The pollution leaks through the unscoped `favorites→photos` joins in `computeExportSizes`/`listFavoritePhotoIds`: viewer-context returns `favoritesCount` + `favoritesOriginalBytes`, giving a cross-workspace existence + file-size oracle. Photo content is contained (export key uses the token's album id). (public-share reported at low; kept medium.)
- **Suggested fix:** Verify the photo is in the token's album before inserting (`AND EXISTS (SELECT 1 FROM photos WHERE id = photoId AND album_id = status.link.album_id)`), 404 on mismatch; also scope the favorites→photos joins in `exportSizes`/`favorites` by `album_id` so legacy polluted rows can't leak.

### [MEDIUM] F28 — Finalize route does not validate per-photo fields (`photo_id`/`width`/`height`/`size`) before DB insert
- **Area:** error-handling-typesafety
- **File:** `src/app/api/upload/finalize/route.ts:27-44` (gap); unsafe passthrough 70-96, 100-138
- **Category:** Data-integrity
- **Evidence:**
  ```ts
  body = (await req.json()) as FinalizeRequestBody;
  if (!body?.album_id || !Array.isArray(body.photos) || body.photos.length === 0) { ... }
  ```
- **Why it matters:** Only `album_id` presence and a non-empty `photos` array are checked. Each photo's `photo_id`/`width`/`height`/`size` passes straight into `insertPhotosBatch` (NOT NULL integer columns) and into `originalKey(...)` as an S3 key segment. A malformed payload (undefined/NaN size, non-UUID id) throws a raw 500 instead of a clean 400, and an arbitrary `photo_id` decouples the finalized row from any presigned upload.
- **Suggested fix:** Validate each photo (UUID id, positive finite integer width/height, non-negative finite size); reject with 400 before `insertPhotosBatch`. Optionally verify each `photo_id` matches a key actually presigned for this album.

### [MEDIUM] F29 — Share-link password unlock server action has no rate limiting (Argon2 brute-force on protected galleries)
- **Area:** cross-cutting-completeness
- **File:** `src/app/a/[token]/_actions.ts:129-143`; wrapper `src/app/a/[token]/password/page.tsx:26-36`
- **Category:** Security
- **Evidence:**
  ```ts
  const ok = await verifyPassword(link.password_hash, password);
  if (!ok) return { ok: false, error: "Incorrect password." };
  ```
- **Why it matters:** Admin login is carefully rate-limited per-email and per-IP, but the share-link password gate calls `verifyPassword` directly with no limiter and no lockout. An attacker holding a (forwardable/leakable) token can loop this action to brute-force the gallery password; the only friction is Argon2's ~200ms cost. It also reveals "Link not found." vs "Incorrect password." (token-existence oracle, F30). (Downgraded high→medium: defense-in-depth behind a ~72-bit token; in-memory limiter is single-worker only.)
- **Suggested fix:** Wrap `unlockShareLink` in a per-`(token, IP)` rate limiter (~10/min) mirroring the export limiter, returning a generic error on trip; consider collapsing "Link not found" into the same generic response.

### [MEDIUM] F30 — Export endpoint returns distinct status codes per share-link state, leaking token existence/expiry (inconsistent with the deliberately-collapsed viewer-context route)
- **Area:** cross-cutting-completeness
- **File:** `src/app/api/export/[token]/route.ts:131-148`
- **Category:** Security
- **Evidence:**
  ```ts
  if (status.kind === "not_found") return ...404...;
  if (status.kind === "expired")   return ...410...;
  if (status.kind === "locked")    return ...401...;
  ```
- **Why it matters:** The sibling viewer-context route deliberately collapses `not_found`/`expired`/`locked` into a generic 404 to stop pre-auth fingerprinting ("F9" hardening). The export route does the opposite, letting an unauthenticated caller distinguish a non-existent token (404) from a real-but-expired one (410) from a password-protected one (401) before any password gate. Combined with the `probe=1` rate-limit exclusion (F21), it is a low-cost oracle for live/password-protected tokens. (Low severity because tokens are high-entropy; the inconsistency undermines the F9 hardening.)
- **Suggested fix:** Collapse `not_found`/`expired`/`locked` into a generic 404 for the unauthenticated pre-unlock path; keep richer reason codes only after the unlock cookie validates.

### [MEDIUM] F31 — Non-owner admins can mutate global notification rules, read the global notification log, and trigger Telegram sends
- **Area:** cross-cutting-completeness
- **File:** `src/app/admin/notifications/actions.ts:26, 64, 102`; `src/app/admin/notifications/page.tsx:49`
- **Category:** Security
- **Note:** This is the same authorization root cause as **F3**; retained as a distinct medium entry because the cross-cutting reviewer independently confirmed the privilege-escalation angle (global rule mutation, test sends, arbitrary replay, cross-workspace log read incl. `chat_id`). Apply the **F3** fix (`requireAdmin()` → `requireOwner()` in the page and all actions); if non-owner admins legitimately need notifications, the rules/log must gain an `owner_user_id` scope.

---

## Low

### [LOW] F32 — Login IP rate limiter collapses to a single shared 'unknown' bucket when `TRUST_PROXY_HEADERS` is unset (the default)
- **Area:** auth-session-middleware
- **File:** `src/lib/client-ip.ts:16-30`; `src/app/admin/login/actions.ts:121`
- **Category:** Security
- **Evidence:**
  ```ts
  export function resolveIpFromHeaders(h: IpHeaderSource): string {
    const trustProxy = process.env.TRUST_PROXY_HEADERS === "1";
    if (trustProxy) { ... }
    return "unknown";
  }
  ```
- **Why it matters:** With proxy headers untrusted (the safe default), the resolver returns the literal `"unknown"`, so the per-IP login limiter keys every client on `ip:unknown` — 20 failed logins from anyone trips it for the whole deployment (a global login-DoS nuisance) and per-IP discrimination is lost. (Downgraded medium→low: deliberate documented trade-off; the shared bucket strengthens brute-force resistance against header-spoofing and the impact is bounded admin-login availability.)
- **Suggested fix:** Fall back to the socket/connection remote address for direct connections instead of the constant `"unknown"`; document that `TRUST_PROXY_HEADERS=1` must be set behind a trusted proxy.

### [LOW] F33 — In-memory rate-limiter Map grows unbounded — empty buckets and one-off keys are never evicted
- **Area:** auth-session-middleware
- **File:** `src/lib/rateLimiter.ts:22-41`
- **Category:** Performance
- **Evidence:**
  ```ts
  const buckets = new Map<string, number[]>();
  // allow(): prunes timestamps within a key but never deletes the key
  ```
- **Why it matters:** The Map adds an entry per distinct key and never deletes any (even after all timestamps age out). The login email limiter (`email:<folded>`) lets an attacker submit a unique email per request, permanently allocating a Map entry — monotonic heap growth with no TTL in the long-running Node process. The codebase's own `IP_TRACKER` already implements the missing size-cap+LRU pattern.
- **Suggested fix:** Delete the key when its pruned hit list is empty, or add a periodic sweep / LRU cap. Back the limiter with Redis/Postgres for production.

### [LOW] F34 — `updateUserAction` accepts an arbitrary `role` from form data; the owner-promotion guard lives only in `updateUser`
- **Area:** auth-session-middleware
- **File:** `src/app/admin/users/_actions.ts:71-79`
- **Category:** Maintainability
- **Evidence:**
  ```ts
  const roleRaw = String(formData.get("role") ?? "");
  const role = roleRaw === "owner" || roleRaw === "admin" ? roleRaw : undefined;
  await updateUser(id, { name, role, disabled });
  ```
- **Why it matters:** The UI only offers `admin`, but the action explicitly accepts `owner` from the POST body and forwards it. The only thing preventing an admin→owner escalation is the code guard in `updateUser` plus the DB partial-unique index. Currently sufficient, but the widened action surface becomes a role-escalation the moment that downstream guard regresses or the gate is copy-pasted elsewhere.
- **Suggested fix:** In `updateUserAction`, accept only `role === 'admin'` (map/reject `owner`); keep `updateUser`'s guard as defense-in-depth.

### [LOW] F35 — `setCoverAction`/`setCover` does not verify the photo belongs to the gated album (cross-album/cross-workspace cover pointer)
- **Area:** workspace-isolation + sql-data-layer (reported by both)
- **File:** `src/lib/albums.ts:361-363` (`setCover`); reached via `src/app/admin/albums/actions.ts:166-171`
- **Category:** Security / Data-integrity
- **Evidence:**
  ```ts
  export async function setCover(albumId: string, photoId: string): Promise<void> {
    await sql`UPDATE albums SET cover_photo_id = ${photoId}, updated_at = now() WHERE id = ${albumId}`;
  }
  ```
- **Why it matters:** `gateAlbum(albumId)` confirms album ownership but `photoId` is never validated against the album. A crafted call can set `cover_photo_id` to a photo in another workspace. The actual thumbnail leak is blunted because the imgproxy key composes the attacker's album id with the foreign photo id (key won't resolve), so impact today is a dangling/broken cover pointer rather than image exposure — but it is an unvalidated cross-workspace write and would leak if any consumer resolved the cover via the photo's own album.
- **Suggested fix:** Constrain the UPDATE: `... WHERE id = ${albumId} AND EXISTS (SELECT 1 FROM photos WHERE id = ${photoId} AND album_id = ${albumId})`, and treat zero rows updated as an error (or reuse `gatePhoto`). Matches the scoping already used by `reorderPhotos`/`bulkDeletePhotos`.

### [LOW] F36 — `getAlbumStorageBreakdown` top_uploader sub-select can attribute an album to an admin in a different workspace
- **Area:** workspace-isolation
- **File:** `src/lib/metrics.ts:280-289`
- **Category:** Data-integrity
- **Evidence:**
  ```sql
  (SELECT u.email FROM photos p2
     LEFT JOIN admin_users u ON u.id = p2.created_by_user_id
    WHERE p2.album_id = a.id AND p2.created_by_user_id IS NOT NULL
    GROUP BY u.email ORDER BY COUNT(*) DESC LIMIT 1) AS top_uploader
  ```
- **Why it matters:** `top_uploader` derives from `photos.created_by_user_id`, independent of `albums.owner_user_id`. After an owner moves photos across workspaces, an album owned by A can be labeled "uploaded by B" on the storage-attribution screen. Owner-only/cosmetic today, but a latent correctness trap for any future per-workspace accounting built on `created_by_user_id`.
- **Suggested fix:** Surface `albums.owner_user_id`'s email for workspace attribution, or document that `top_uploader` is a per-photo fact; always aggregate per-workspace totals by `owner_user_id`.

### [LOW] F37 — `notifyFavoritesBurst` rolling-hour count includes cross-album injected favorites
- **Area:** public-share-idor
- **File:** `src/app/a/[token]/_actions.ts:105-110`; root cause `src/lib/favorites.ts:6-26`
- **Category:** Data-integrity
- **Evidence:**
  ```sql
  SELECT COUNT(*)::text AS n FROM favorites
   WHERE share_token = ${token} AND viewer_id = ${viewerId}
     AND created_at > NOW() - INTERVAL '1 hour'
  ```
- **Why it matters:** The burst count (which drives Telegram "favorites burst" alerts) counts every row for `(token, viewer)` regardless of album. Via the F27 injection, an attacker can inflate the count with foreign photo UUIDs and trigger spurious burst notifications to the album owner. Moot once F27 is fixed at write time.
- **Suggested fix:** Join to photos and filter by `album_id`, or rely on F27's write-time rejection so only in-album rows exist.

### [LOW] F38 — Favorites export and export-size queries join `favorites→photos` with no album filter (foreign photo byte-size/metadata leak)
- **Area:** public-share-idor
- **File:** `src/lib/exportSizes.ts:65-71`; `src/app/api/export/[token]/route.ts:195-201`
- **Category:** Security
- **Evidence:**
  ```sql
  SELECT COUNT(*)::text AS count, COALESCE(SUM(p.orig_bytes), 0)::text AS bytes
    FROM favorites f JOIN photos p ON p.id = f.photo_id
   WHERE f.share_token = ${token} AND f.viewer_id = ${viewerId}
  ```
- **Why it matters:** The favorites aggregation joins to photos filtered only by `(share_token, viewer_id)`, never `album_id`. Combined with F27, a viewer can favorite foreign photo UUIDs and read their `orig_bytes` + count back through the export-size preview — a cross-workspace size/existence oracle (random UUIDs are not enumerable, so attacker must already know the UUID; metadata-only, no content). The favorites ZIP also becomes silently incomplete.
- **Suggested fix:** Add `AND p.album_id = ${albumId}` to both the `computeExportSizes` favorites query and the export route's favorites SELECT.

### [LOW] F39 — No content/magic-byte validation: presigned PUT accepts arbitrary bytes under an image content-type
- **Area:** upload-storage-quota
- **File:** `src/app/api/upload/presign/route.ts:179-197`; propagation at `src/lib/presign.ts:29-36`, `src/lib/keys.ts:18-29`
- **Category:** Security
- **Evidence:**
  ```ts
  const ext = extFromContentType(f.contentType);
  const key = originalKey(album.id, photo_id, ext);
  const put_url = await presignPut(key, f.contentType, 900);
  ```
- **Why it matters:** Validation is purely on the declared content-type string; MinIO does not validate the bytes. A caller can presign `image/jpeg` and PUT non-image content. (Downgraded medium→low: every browser-facing path is `status='ready'`-gated, downloads force `Content-Disposition: attachment`, imgproxy re-encodes, and a non-decodable file never reaches `ready`; admin-only. Residual is content-type spoofing by a trusted admin.)
- **Suggested fix:** Decode-verify in the worker before flipping to `ready` (reject + delete + mark failed when `sharp().metadata()` throws or format mismatches the extension); force a safe response content-type plus attachment disposition on original downloads.

### [LOW] F40 — `block_uploads_when_full` guard undercounts (ready-only) and relies on the spoofable `orig_bytes` sum
- **Area:** upload-storage-quota
- **File:** `src/app/api/upload/presign/route.ts:56-62`
- **Category:** Correctness
- **Evidence:**
  ```ts
  if (settings.storage.block_uploads_when_full) {
    const usage = await getStorageUsage();
    if (usage.usedBytes >= capBytes) return NextResponse.json({ reason: "storage_full" }, { status: 507 });
  }
  ```
- **Why it matters:** `getStorageUsage` sums `orig_bytes` only for `status='ready'`, so an in-flight `processing` burst is invisible to the full-storage guard; the check also never adds `incomingBytes` (it only blocks when already at/over cap), and the sum is the client-spoofable value (F2). Net: `max_gb` is consistently overshootable — though only when the guard is enabled and bounded by `max_file_size_mb`.
- **Suggested fix:** Count `ready` + `processing`, test `usedBytes + incomingBytes >= capBytes` (mirroring the per-album cap), and base the global cap on a trustworthy byte source.

### [LOW] F41 — Finalize does not verify the presigned object was actually uploaded (phantom rows)
- **Area:** upload-storage-quota
- **File:** `src/app/api/upload/finalize/route.ts:70-112`; supporting `src/lib/albums.ts:309-354`, `workers/generateDerivatives.ts:70-74`, `src/app/api/albums/[slug]/processing-status/route.ts:49-66`
- **Category:** Data-integrity
- **Evidence:**
  ```ts
  await insertPhotosBatch(sanitized.map((p) => ({ id: p.photo_id, album_id: album.id, ... })));
  const jobs = sanitized.map((p) => ({ ..., key: originalKey(album.id, p.photo_id, inferExt(p.filename)) }));
  ```
- **Why it matters:** Finalize never HEADs the object and trusts client `photo_id`s not bound to a prior presign, so a client can finalize ids never PUT — creating `processing` rows with arbitrary `orig_bytes` that count toward quotas/dashboards but back no object; the worker then throws on the missing key and the rows stick in `processing` forever (F7). Also the job key ext is re-inferred from the filename, not the presigned content-type, so a JPEG presigned as `.jpg` but finalized as `x.png` enqueues a job for a non-existent key.
- **Suggested fix:** HEAD each presigned key during finalize (or reconcile in the worker) and skip ids with no backing object; bind `photo_id` to the presign result and derive the storage ext from the presigned content-type, not the filename.

### [LOW] F42 — `activeViewers7d` distinct-viewer query cannot use the `(event_type, created_at)` index
- **Area:** sql-data-layer
- **File:** `src/lib/metrics.ts:129-133`
- **Category:** Performance
- **Evidence:**
  ```sql
  SELECT COUNT(DISTINCT viewer_id)::bigint AS count FROM view_events
   WHERE created_at > now() - interval '7 days'
  ```
- **Why it matters:** The only date-bearing indexes lead with `event_type` or `share_token`; this query filters only on `created_at` with no leading-column predicate, so neither composite index supports a range scan and Postgres falls back to a seq scan. Degrades the (owner-only) metrics page as `view_events` grows into the millions; contradicts the module's index-bounded invariant.
- **Suggested fix:** Add a standalone index on `view_events(created_at)` (or `(created_at, viewer_id)`), or scope the query by `event_type`.

### [LOW] F43 — Concurrent finalize requests for the same album can compute identical `sort_order` base (duplicate ordering)
- **Area:** sql-data-layer
- **File:** `src/lib/albums.ts:320-322` (same class at 292)
- **Category:** Correctness
- **Evidence:**
  ```ts
  const maxRows = await sql`SELECT COALESCE(MAX(sort_order) + 1, 0)::int AS next FROM photos WHERE album_id = ${albumId}`;
  const base = maxRows[0]?.next ?? 0;
  ```
- **Why it matters:** The `MAX(sort_order)+1` read and the multi-row INSERT are separate statements with no transaction/row lock. Two overlapping finalize calls on the same album read the same base and assign overlapping `sort_order`. No unique constraint, so not corruption — but duplicate `sort_order` and non-deterministic order (tie-broken by `created_at`) until a manual reorder.
- **Suggested fix:** Compute base and insert in a single transaction with `SELECT ... FOR UPDATE` on the album row (or an advisory lock), or assign `sort_order` via a window function in the INSERT.

### [LOW] F44 — `setCover` does not verify the photo belongs to the album, allowing a dangling/cross-album cover pointer
- **Area:** sql-data-layer
- **File:** `src/lib/albums.ts:361-363`; missing guard in `src/app/admin/albums/actions.ts:166-171`
- **Category:** Data-integrity
- **Note:** Same root cause as **F35** (reported separately by the SQL-data-layer reviewer with the data-integrity framing). Apply the F35 fix (constrain the UPDATE with an `EXISTS` photo-in-album check and reject on zero rows affected).

### [LOW] F45 — PhotoGrid 2s reload interval races with optimistic drag reorder, snapping tiles back to stale server order
- **Area:** react-client-hooks
- **File:** `src/components/admin/PhotoGrid.tsx:103-115` (polling), 117-129 (onDragEnd)
- **Category:** Correctness
- **Evidence:**
  ```ts
  if (anyProcessing) { const t = setInterval(reload, 2000); return () => clearInterval(t); }
  async function onDragEnd(e) { setOrder(next); try { await reorderPhotosAction(...); } catch { setOrder(prev); } }
  ```
- **Why it matters:** While any photo is processing the grid polls `reload()` every 2s, which wholesale-replaces `order` from the server. If a tick lands after the optimistic `setOrder(next)` but before the reorder write commits, the dragged tile snaps back then jumps forward on the next poll. Self-correcting visual glitch, gated to the post-upload processing window (exactly when admins reorder). (Downgraded medium→low.)
- **Suggested fix:** Suspend the interval while a reorder is in flight (ref flag set/cleared in `onDragEnd`), or merge server data into the existing order rather than replacing it wholesale.

### [LOW] F46 — ExportModal resets the user's selection whenever the options array identity changes while open
- **Area:** react-client-hooks
- **File:** `src/components/gallery/ExportModal.tsx:130-138`
- **Category:** Correctness
- **Evidence:**
  ```ts
  useEffect(() => {
    if (open) { const target = preselect && options.some(...) ? preselect : firstEnabled; setSelected(target); }
  }, [open, firstEnabled, preselect, options]);
  ```
- **Why it matters:** The effect lists `options`/`firstEnabled` as deps; the parent rebuilds `options` via `useMemo` keyed on `[exportSizes, liveFavoritesCount]`, whose identity changes when viewer-context hydration lands. If that happens while the modal is open after the user picked an option, the effect resets `selected`, discarding the choice and running probe/download against the reset value. Brief open-before-hydration window; radios visibly re-render.
- **Suggested fix:** Reset only on the open transition (gate on `open` + a previous-open ref), or compute the reset target from a stable signal without listing `options`.

### [LOW] F47 — PhotoGrid tile lookup inside row render is O(n²) and re-runs on every ResizeObserver width change
- **Area:** react-client-hooks
- **File:** `src/components/admin/PhotoGrid.tsx:330` (within `row.items.map` at 329-355)
- **Category:** Performance
- **Evidence:**
  ```ts
  {row.items.map((item) => {
    const tile = tiles.find((t) => t.id === item.id);
    if (!tile) return null;
  ```
- **Why it matters:** `tiles.find(...)` for every item in every row is O(n²) in album size, and an undebounced ResizeObserver recomputes `rows` and re-runs the full render on any width change (sidebar collapse, resize). Measurable on hundreds of photos; admin-only.
- **Suggested fix:** Build a tiles-by-id map and look up via `map.get(item.id)` instead of `find`; consider debouncing the ResizeObserver width updates.

### [LOW] F48 — BulkActionsBar album picker caches the album list forever after first successful fetch
- **Area:** react-client-hooks
- **File:** `src/components/admin/BulkActionsBar.tsx:39-44`
- **Category:** Correctness
- **Evidence:**
  ```ts
  useEffect(() => {
    if (!moveOpen || albums) return;
    listAlbumsForPickerAction().then(setAlbums).catch((e) => setErr((e as Error).message));
  }, [moveOpen, albums]);
  ```
- **Why it matters:** Once `albums` is populated the guard prevents any refetch for the component's lifetime; a freshly created album won't appear as a move target until remount. (Narrower than first reported: the component unmounts when leaving selection mode, so the stale cache lasts one continuous selection session, not until a full page reload.)
- **Suggested fix:** Refetch when the dialog opens (clear `albums` on close), or add a manual refresh affordance.

### [LOW] F49 — Route-level `revalidate = 60` and the documented full-route/CDN caching are inert because the page reads cookies (forced dynamic); PPR is not enabled
- **Area:** nextjs-caching-ssr
- **File:** `src/app/a/[token]/page.tsx:32-47`; PPR-absent config at `next.config.mjs:39-55`
- **Category:** Performance
- **Evidence:**
  ```ts
  export const revalidate = 60;
  const jar = await cookies();
  const unlockCookie = jar.get(unlockCookieName(token))?.value ?? null;
  ```
- **Why it matters:** The comments claim a CDN-cached static shell + PPR dynamic island, but calling `cookies()` opts the whole route into dynamic rendering (no full-route/ISR/CDN HTML cache) and PPR is not enabled in config. Only the `shareLoader` `unstable_cache` (DB reads) provides caching, so the justified-rows layout + HTML render run per request. Performance + documentation-accuracy issue (DB reads are still cached); the misleading comments are the larger practical risk.
- **Suggested fix:** Either enable PPR and move the cookie-dependent lock check out of the static segment, or drop the misleading `revalidate`/CDN comments and document that only `shareLoader`'s `unstable_cache` caches.

### [LOW] F50 — Favorites export cache blob is keyed per-token (not per-viewer); concurrent different-favorites downloads thrash/overwrite the shared object
- **Area:** nextjs-caching-ssr
- **File:** `src/lib/exportCache.ts:28-36`; consuming logic at `src/app/api/export/[token]/route.ts:262-303, 361-377`
- **Category:** Performance
- **Evidence:**
  ```ts
  export function buildCacheKey(token, scope, variant, now = new Date()): string {
    const ymd = now.toISOString().slice(0, 10);
    return `exports/${token}/${scope}-${variant}-${ymd}.zip`;
  }
  ```
- **Why it matters:** For `scope=favorites` the key is shared by all viewers but favorites sets are per-viewer, so distinct viewers miss each other's signature and each rebuild + overwrite the same MinIO object — last-write-wins, so the cache rarely hits for multi-viewer albums and burns CPU re-generating ZIPs. The served body is always the requester's own stream, so no cross-viewer content leak.
- **Suggested fix:** Fold the favorites signature (or viewer id) into the key, e.g. `exports/${token}/${scope}-${variant}-${sig}-${ymd}.zip`; keep `ymd` for the reaper. `all` scope can keep the token-only key.

### [LOW] F51 — Reported export byte total uses `orig_bytes` for the web variant — wrong size logged/notified
- **Area:** export-zip-dos
- **File:** `src/app/api/export/[token]/route.ts:385-413`
- **Category:** Correctness
- **Evidence:**
  ```sql
  SELECT COALESCE(SUM(orig_bytes), 0)::text AS total FROM photos WHERE id = ANY(${...}::uuid[])
  -- totalBytes → logExport / export_completed analytics / notifyExportCompleted
  ```
- **Why it matters:** The web variant streams imgproxy-re-encoded JPEGs (~22% of originals) but `totalBytes` is always `SUM(orig_bytes)`, so the download row, analytics event, and Telegram message report ~4-5× the true bytes. The cache-hit branch instead uses real `ContentLength`, so the same export reports wildly different totals on miss vs hit. Logging/metrics-only (the value gates nothing).
- **Suggested fix:** Track actual emitted bytes (count fan-out chunks, or read the cache object's `ContentLength` after `upload.done()`), or at least apply `WEB_VARIANT_RATIO` for web; keep miss/hit consistent.

### [LOW] F52 — `exportReaper` deletes objects one-at-a-time and never times out — slow/partial sweep under load
- **Area:** export-zip-dos
- **File:** `workers/exportReaper.ts:28-37`; unused batching helper `src/lib/minio.ts:135-159`; schedule `workers/index.ts:75-78, 104`
- **Category:** Performance
- **Evidence:**
  ```ts
  for (const obj of page.Contents ?? []) {
    if (obj.LastModified.getTime() < cutoff) {
      await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
    }
  }
  ```
- **Why it matters:** Serialized DELETE-per-object (no batching, no try/catch) against MinIO is slow at high object counts, and any single throw aborts the run mid-page so stale objects survive until the next 6-hourly pass. Idempotent/self-healing; throughput + robustness only.
- **Suggested fix:** Collect stale keys per page and batch-delete via `DeleteObjectsCommand` (reuse the existing `deleteObjectsByPrefix` chunking), wrap individual deletes in catch, and optionally cap per-run work.

### [LOW] F53 — imgproxy web-export fetch has no timeout — a single wedged render stalls the whole stream
- **Area:** export-zip-dos
- **File:** `src/app/api/export/[token]/route.ts:324-334`; consumed via for-await in `src/lib/zipStream.ts:71`
- **Category:** Performance
- **Evidence:**
  ```ts
  const res = await fetch(url, { headers: { accept: "image/jpeg", "user-agent": "gallery-hub-export/1" } });
  ```
- **Why it matters:** The web-variant export fetches each photo from imgproxy serially with no `AbortSignal`/timeout (unlike `warmImgproxyVariants`, which wraps every fetch in `AbortSignal.timeout(30_000)`). If imgproxy hangs on one photo, the await never resolves and the archiver build, HTTP response, and background MinIO Upload all stall indefinitely. Only the web branch is affected; requires a valid share token.
- **Suggested fix:** Wrap the export imgproxy fetch in `AbortSignal.timeout(...)` and fail the entry on timeout so the stream tears down; consider bounding concurrency/total time.

---

## Uncertain / needs manual verification

No uncertain findings remained after adversarial verification. All 61 raw confirmed findings were either retained (and merged where duplicated across areas) or had their severity adjusted with documented reasoning; 4 candidate findings were rejected by the verifier and are not included here.

---

## Methodology

- **Reviewers (12 areas):** workspace-isolation, upload-storage-quota, react-client-hooks, export-zip-dos, workers-jobs, settings-notifications-admin, cross-cutting-completeness, auth-session-middleware, sql-data-layer, public-share-idor, nextjs-caching-ssr, error-handling-typesafety.
- **Adversarial verification (Opus):** every candidate finding was independently re-read against the source, with the verifier tracing the full call/data flow and either confirming, adjusting severity (up or down with reasoning), or rejecting it. Severities in this report reflect the post-verification values, not the reviewers' initial ratings.
- **De-duplication:** findings reported by two areas with the same file + root cause were merged, retaining the higher severity and recording both reporting areas (F1, F3, F4, F11, F27, F35; F31 and F44 are cross-referenced to F3 and F35 respectively to preserve the distinct angle each reviewer raised).
- **Counts:** 61 raw confirmed → 53 distinct after merge (0 critical / 6 high / 23 medium / 24 low). 4 rejected, 0 uncertain.
- **Faithfulness:** no findings were invented and no severities inflated; evidence quotes are excerpted directly from the source and kept short. Cross-finding relationships (e.g., F2↔F9/F40, F4↔F5↔F21, F7↔F41, F27↔F37/F38) are noted inline where one issue compounds another.
