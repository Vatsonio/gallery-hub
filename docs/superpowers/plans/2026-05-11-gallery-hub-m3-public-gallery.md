# gallery-hub M3 — Public Gallery + Lightbox + Favorites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the end-to-end client-facing experience for gallery-hub: admin generates a share link, the public visitor opens the album under `/a/{token}`, browses a dark-cinematic justified grid, opens a routed lightbox, double-clicks/taps to favorite photos, switches to a Favorites tab, and the admin sees those selections grouped by anonymous viewer.

**Architecture:** All public routes live under `src/app/a/[token]/...` and share an isolated dark layout. Token validation runs in a small per-route guard (Next 15 App Router does not allow per-segment middleware on parameterized routes via root `middleware.ts` reliably for cookie writes, so we centralize logic in `src/lib/share.ts` + a layout-level resolver). Anonymous viewers get a UUID via the `gh_viewer` HttpOnly cookie scoped to the share path. Favorites are persisted server-side keyed on `(share_token, photo_id, viewer_id)` and rendered both as overlays in the grid and as a filtered favorites page. The lightbox is a routed page (`/a/[token]/p/[photoId]`) so it is deep-linkable; closing it calls `router.back()`. Justified-row layout is computed pure-client from `{width, height}` metadata that landed in M1. Server actions handle every mutation (share-link CRUD, password unlock, toggleFavorite). E2E flows are covered by Playwright against the dev compose stack; unit tests use Vitest; server-action integration tests use Vitest + testcontainers (reusing the existing M1/M2 fixtures).

**Tech Stack:** Next.js 15 App Router, TypeScript, Tailwind 4, shadcn/ui, Lucide icons, postgres.js, MinIO/S3, iron-session, argon2, `@use-gesture/react@10`, `qrcode@1`, `@playwright/test@1`, vitest + testcontainers.

---

## File Structure

**New files:**
- `src/lib/viewer.ts` — anon viewer cookie issuing/reading.
- `src/lib/share.ts` — token resolution, expiry/password gate logic, signed-cookie helpers.
- `src/lib/share-actions.ts` — admin server actions: createShareLink / updateShareLink / revokeShareLink.
- `src/lib/favorites.ts` — `toggleFavorite`, `listFavoritesForViewer`, favorite-count aggregations.
- `src/lib/view-events.ts` — `logViewEvent(token, viewerId, type, photoId?)` helper.
- `src/lib/justified.ts` — pure justified-rows layout algorithm.
- `src/components/admin/ShareLinkCard.tsx` — rose card with copy/QR/settings.
- `src/components/admin/ShareLinkSettingsDialog.tsx`
- `src/components/admin/ShareLinkQrDialog.tsx`
- `src/components/gallery/JustifiedGrid.tsx`
- `src/components/gallery/HeartBurst.tsx`
- `src/components/gallery/HeartOverlay.tsx`
- `src/components/gallery/PhotoCard.tsx` — double-click + heart overlay container.
- `src/components/gallery/MobileTabBar.tsx`
- `src/components/gallery/GlassDock.tsx`
- `src/components/gallery/ExportModalPlaceholder.tsx`
- `src/components/gallery/Lightbox.tsx`
- `src/components/gallery/LightboxChrome.tsx`
- `src/components/gallery/LightboxFilmstrip.tsx`
- `src/app/a/[token]/layout.tsx`
- `src/app/a/[token]/page.tsx`
- `src/app/a/[token]/favorites/page.tsx`
- `src/app/a/[token]/p/[photoId]/page.tsx`
- `src/app/a/[token]/password/page.tsx`
- `src/app/a/[token]/_actions.ts` — `toggleFavorite`, `unlockShareLink` (server actions).
- `src/app/a/[token]/not-found.tsx`
- `src/app/a/[token]/gone.tsx` — rendered on 410.
- `src/app/admin/selections/page.tsx`
- `src/app/admin/selections/[albumSlug]/page.tsx` — admin preview with hearts overlay.
- `tests/unit/justified.test.ts`
- `tests/unit/viewer.test.ts`
- `tests/unit/double-tap.test.ts`
- `tests/integration/share-actions.test.ts`
- `tests/integration/favorites.test.ts`
- `tests/integration/unlock.test.ts`
- `tests/e2e/playwright.config.ts`
- `tests/e2e/fixtures/seed.ts`
- `tests/e2e/share-flow.spec.ts`
- `tests/e2e/lightbox.spec.ts`
- `tests/e2e/favorites.spec.ts`

**Modified files:**
- `src/app/admin/albums/[slug]/page.tsx` — embed `<ShareLinkCard>`.
- `src/app/admin/layout.tsx` — add "Client Selections" sidebar entry.
- `package.json` — add `qrcode`, `@use-gesture/react`, `@playwright/test`, `@types/qrcode`.
- `next.config.mjs` — add MinIO host to `images.remotePatterns`.
- `src/styles/globals.css` — heart-burst keyframes, glass-dock utility classes.

---

## Task 1: Install dependencies and Playwright scaffold

**Files:**
- Modify: `package.json`
- Create: `tests/e2e/playwright.config.ts`

- [ ] **Step 1: Install runtime + dev deps**

```bash
npm install qrcode@1 @use-gesture/react@10
npm install -D @types/qrcode @playwright/test@1
npx playwright install --with-deps chromium
```

- [ ] **Step 2: Create Playwright config**

```ts
// tests/e2e/playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium-mobile', use: { ...devices['Pixel 7'] } },
  ],
});
```

- [ ] **Step 3: Add npm scripts**

In `package.json` scripts block:

```json
"test:e2e": "playwright test -c tests/e2e/playwright.config.ts",
"test:e2e:seed": "tsx tests/e2e/fixtures/seed.ts"
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tests/e2e/playwright.config.ts
git commit -m "chore(m3): add qrcode, use-gesture, playwright deps"
```

---

## Task 2: Anonymous viewer cookie (`src/lib/viewer.ts`)

**Files:**
- Create: `src/lib/viewer.ts`
- Test: `tests/unit/viewer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/viewer.test.ts
import { describe, it, expect, vi } from 'vitest';
import { resolveViewerId, VIEWER_COOKIE } from '@/lib/viewer';

function makeCookieStore(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const writes: Array<{ name: string; value: string; opts: any }> = [];
  return {
    get: (name: string) => (store.has(name) ? { name, value: store.get(name)! } : undefined),
    set: (name: string, value: string, opts: any) => {
      store.set(name, value);
      writes.push({ name, value, opts });
    },
    writes,
  };
}

describe('resolveViewerId', () => {
  it('issues a new UUID and sets cookie when none present', () => {
    const jar = makeCookieStore();
    const id = resolveViewerId(jar as any, 'abc123', { isAdminPreview: false });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(jar.writes).toHaveLength(1);
    expect(jar.writes[0].name).toBe(VIEWER_COOKIE);
    expect(jar.writes[0].opts.httpOnly).toBe(true);
    expect(jar.writes[0].opts.sameSite).toBe('lax');
    expect(jar.writes[0].opts.path).toBe('/a/abc123');
    expect(jar.writes[0].opts.maxAge).toBe(60 * 60 * 24 * 365);
  });

  it('reuses existing cookie', () => {
    const jar = makeCookieStore({ gh_viewer: '11111111-1111-1111-1111-111111111111' });
    const id = resolveViewerId(jar as any, 'abc123', { isAdminPreview: false });
    expect(id).toBe('11111111-1111-1111-1111-111111111111');
    expect(jar.writes).toHaveLength(0);
  });

  it('returns a fixed admin-preview id and never writes for admin preview', () => {
    const jar = makeCookieStore();
    const id = resolveViewerId(jar as any, 'abc123', { isAdminPreview: true });
    expect(id).toBe('admin-preview');
    expect(jar.writes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/unit/viewer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/viewer.ts
import { randomUUID } from 'node:crypto';

export const VIEWER_COOKIE = 'gh_viewer';
export const ADMIN_PREVIEW_VIEWER_ID = 'admin-preview';

export interface CookieJarLike {
  get(name: string): { name: string; value: string } | undefined;
  set(name: string, value: string, opts: Record<string, unknown>): void;
}

export interface ResolveOpts {
  isAdminPreview: boolean;
}

export function resolveViewerId(jar: CookieJarLike, token: string, opts: ResolveOpts): string {
  if (opts.isAdminPreview) return ADMIN_PREVIEW_VIEWER_ID;
  const existing = jar.get(VIEWER_COOKIE);
  if (existing?.value) return existing.value;
  const id = randomUUID();
  jar.set(VIEWER_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: `/a/${token}`,
    maxAge: 60 * 60 * 24 * 365,
  });
  return id;
}

export function readViewerId(jar: CookieJarLike): string | null {
  return jar.get(VIEWER_COOKIE)?.value ?? null;
}
```

- [ ] **Step 4: Re-run test**

Run: `npx vitest run tests/unit/viewer.test.ts`
Expected: PASS, 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/viewer.ts tests/unit/viewer.test.ts
git commit -m "feat(m3): anonymous viewer cookie helper"
```

---

## Task 3: Share-link token resolution (`src/lib/share.ts`)

**Files:**
- Create: `src/lib/share.ts`

- [ ] **Step 1: Implement the module**

```ts
// src/lib/share.ts
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from '@/lib/db';

export interface ShareLinkRow {
  token: string;
  album_id: string;
  password_hash: string | null;
  expires_at: Date | null;
  allow_download: boolean;
  created_at: Date;
}

export type ShareLinkStatus =
  | { kind: 'ok'; link: ShareLinkRow }
  | { kind: 'not_found' }
  | { kind: 'expired'; link: ShareLinkRow }
  | { kind: 'locked'; link: ShareLinkRow };

export function generateShareToken(): string {
  // 12-char base64url. 9 raw bytes → 12 base64url chars (no padding).
  return randomBytes(9).toString('base64url').slice(0, 12);
}

export async function loadShareLink(token: string): Promise<ShareLinkRow | null> {
  const rows = await sql<ShareLinkRow[]>`
    SELECT token, album_id, password_hash, expires_at, allow_download, created_at
    FROM share_links
    WHERE token = ${token}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export function isExpired(link: ShareLinkRow, now: Date = new Date()): boolean {
  return link.expires_at !== null && link.expires_at.getTime() <= now.getTime();
}

const UNLOCK_PREFIX = 'gh_unlocked_';
export const UNLOCK_TTL_SECONDS = 60 * 60 * 24;

function getSigningSecret(): string {
  const s = process.env.SESSION_PASSWORD;
  if (!s) throw new Error('SESSION_PASSWORD is required');
  return s;
}

export function signUnlockValue(token: string, issuedAt: number): string {
  const payload = `${issuedAt}`;
  const sig = createHmac('sha256', getSigningSecret())
    .update(`${token}.${payload}`)
    .digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyUnlockValue(token: string, value: string | undefined | null, now: number = Date.now()): boolean {
  if (!value) return false;
  const [issuedAtStr, sig] = value.split('.');
  if (!issuedAtStr || !sig) return false;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt)) return false;
  if (now - issuedAt > UNLOCK_TTL_SECONDS * 1000) return false;
  const expected = createHmac('sha256', getSigningSecret())
    .update(`${token}.${issuedAtStr}`)
    .digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

export function unlockCookieName(token: string): string {
  return `${UNLOCK_PREFIX}${token}`;
}

export async function resolveShareLinkStatus(
  token: string,
  unlockCookieValue: string | null,
): Promise<ShareLinkStatus> {
  const link = await loadShareLink(token);
  if (!link) return { kind: 'not_found' };
  if (isExpired(link)) return { kind: 'expired', link };
  if (link.password_hash && !verifyUnlockValue(token, unlockCookieValue)) {
    return { kind: 'locked', link };
  }
  return { kind: 'ok', link };
}
```

- [ ] **Step 2: Smoke-import test**

Add minimal verification to `tests/unit/viewer.test.ts` is unrelated; instead add `tests/unit/share-token.test.ts`:

```ts
// tests/unit/share-token.test.ts
import { describe, it, expect } from 'vitest';
import { generateShareToken, signUnlockValue, verifyUnlockValue } from '@/lib/share';

describe('share tokens', () => {
  it('generates 12-char url-safe tokens', () => {
    process.env.SESSION_PASSWORD = 'test-secret-test-secret-test-secret-1';
    for (let i = 0; i < 20; i++) {
      const t = generateShareToken();
      expect(t).toHaveLength(12);
      expect(t).toMatch(/^[A-Za-z0-9_-]{12}$/);
    }
  });

  it('signs and verifies unlock cookie', () => {
    process.env.SESSION_PASSWORD = 'test-secret-test-secret-test-secret-1';
    const v = signUnlockValue('abc', Date.now());
    expect(verifyUnlockValue('abc', v)).toBe(true);
    expect(verifyUnlockValue('xyz', v)).toBe(false);
  });

  it('rejects expired unlock cookies', () => {
    process.env.SESSION_PASSWORD = 'test-secret-test-secret-test-secret-1';
    const old = Date.now() - 25 * 60 * 60 * 1000;
    const v = signUnlockValue('abc', old);
    expect(verifyUnlockValue('abc', v)).toBe(false);
  });
});
```

- [ ] **Step 3: Run**

Run: `npx vitest run tests/unit/share-token.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/share.ts tests/unit/share-token.test.ts
git commit -m "feat(m3): share-link token resolution and unlock cookie signing"
```

---

## Task 4: View-event logging helper (`src/lib/view-events.ts`)

**Files:**
- Create: `src/lib/view-events.ts`

- [ ] **Step 1: Implement**

```ts
// src/lib/view-events.ts
import { sql } from '@/lib/db';
import { ADMIN_PREVIEW_VIEWER_ID } from '@/lib/viewer';

export type ViewEventType =
  | 'page_view'
  | 'photo_view'
  | 'download'
  | 'favorite_add'
  | 'favorite_remove';

export async function logViewEvent(
  token: string,
  viewerId: string,
  eventType: ViewEventType,
  photoId: string | null = null,
): Promise<void> {
  if (viewerId === ADMIN_PREVIEW_VIEWER_ID) return; // do not pollute analytics
  await sql`
    INSERT INTO view_events (share_token, viewer_id, event_type, photo_id)
    VALUES (${token}, ${viewerId}, ${eventType}, ${photoId})
  `;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/view-events.ts
git commit -m "feat(m3): view_events logger"
```

---

## Task 5: Favorites data layer (`src/lib/favorites.ts`)

**Files:**
- Create: `src/lib/favorites.ts`
- Test: `tests/integration/favorites.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/favorites.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, resetTestDb, seedAlbumWithPhotos } from './_helpers';
import { toggleFavoriteForViewer, listFavoritePhotoIds, favoriteCountsByPhoto } from '@/lib/favorites';

let token: string;
let photoIds: string[];

beforeAll(async () => { await setupTestDb(); });
afterAll(async () => { await teardownTestDb(); });
beforeEach(async () => {
  await resetTestDb();
  ({ token, photoIds } = await seedAlbumWithPhotos({ count: 3 }));
});

describe('favorites', () => {
  it('toggles a favorite on then off', async () => {
    const a = await toggleFavoriteForViewer(token, photoIds[0], 'viewer-1');
    expect(a).toEqual({ state: 'added' });
    expect(await listFavoritePhotoIds(token, 'viewer-1')).toEqual([photoIds[0]]);

    const b = await toggleFavoriteForViewer(token, photoIds[0], 'viewer-1');
    expect(b).toEqual({ state: 'removed' });
    expect(await listFavoritePhotoIds(token, 'viewer-1')).toEqual([]);
  });

  it('keeps favorites separated per viewer', async () => {
    await toggleFavoriteForViewer(token, photoIds[0], 'v1');
    await toggleFavoriteForViewer(token, photoIds[1], 'v2');
    expect(await listFavoritePhotoIds(token, 'v1')).toEqual([photoIds[0]]);
    expect(await listFavoritePhotoIds(token, 'v2')).toEqual([photoIds[1]]);
  });

  it('aggregates favorite counts per photo across viewers', async () => {
    await toggleFavoriteForViewer(token, photoIds[0], 'v1');
    await toggleFavoriteForViewer(token, photoIds[0], 'v2');
    await toggleFavoriteForViewer(token, photoIds[1], 'v1');
    const counts = await favoriteCountsByPhoto(token);
    expect(counts.get(photoIds[0])).toBe(2);
    expect(counts.get(photoIds[1])).toBe(1);
    expect(counts.get(photoIds[2])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run tests/integration/favorites.test.ts`
Expected: FAIL — `@/lib/favorites` missing.

- [ ] **Step 3: Implement**

```ts
// src/lib/favorites.ts
import { sql } from '@/lib/db';
import { logViewEvent } from '@/lib/view-events';

export interface ToggleResult { state: 'added' | 'removed' }

export async function toggleFavoriteForViewer(
  token: string,
  photoId: string,
  viewerId: string,
): Promise<ToggleResult> {
  const deleted = await sql`
    DELETE FROM favorites
    WHERE share_token = ${token} AND photo_id = ${photoId} AND viewer_id = ${viewerId}
    RETURNING photo_id
  `;
  if (deleted.length > 0) {
    await logViewEvent(token, viewerId, 'favorite_remove', photoId);
    return { state: 'removed' };
  }
  await sql`
    INSERT INTO favorites (share_token, photo_id, viewer_id)
    VALUES (${token}, ${photoId}, ${viewerId})
  `;
  await logViewEvent(token, viewerId, 'favorite_add', photoId);
  return { state: 'added' };
}

export async function listFavoritePhotoIds(token: string, viewerId: string): Promise<string[]> {
  const rows = await sql<{ photo_id: string }[]>`
    SELECT f.photo_id
    FROM favorites f
    JOIN photos p ON p.id = f.photo_id
    WHERE f.share_token = ${token} AND f.viewer_id = ${viewerId}
    ORDER BY p.sort_order ASC, p.created_at ASC
  `;
  return rows.map(r => r.photo_id);
}

export async function favoriteCountsByPhoto(token: string): Promise<Map<string, number>> {
  const rows = await sql<{ photo_id: string; n: string }[]>`
    SELECT photo_id, COUNT(*)::text AS n
    FROM favorites
    WHERE share_token = ${token}
    GROUP BY photo_id
  `;
  return new Map(rows.map(r => [r.photo_id, Number(r.n)]));
}

export async function listFavoritesByViewer(token: string): Promise<
  Map<string, { viewerId: string; photoIds: string[]; lastAt: Date }>
> {
  const rows = await sql<{ viewer_id: string; photo_id: string; created_at: Date }[]>`
    SELECT viewer_id, photo_id, created_at
    FROM favorites
    WHERE share_token = ${token}
    ORDER BY created_at DESC
  `;
  const out = new Map<string, { viewerId: string; photoIds: string[]; lastAt: Date }>();
  for (const r of rows) {
    const cur = out.get(r.viewer_id) ?? { viewerId: r.viewer_id, photoIds: [], lastAt: r.created_at };
    cur.photoIds.push(r.photo_id);
    if (r.created_at > cur.lastAt) cur.lastAt = r.created_at;
    out.set(r.viewer_id, cur);
  }
  return out;
}
```

- [ ] **Step 4: Run integration tests**

Run: `npx vitest run tests/integration/favorites.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/favorites.ts tests/integration/favorites.test.ts
git commit -m "feat(m3): favorites data layer with per-viewer toggle"
```

---

## Task 6: Test helpers for shared-link integration tests

**Files:**
- Modify: `tests/integration/_helpers.ts` (assumed exists from M1/M2; if not, create per below)

- [ ] **Step 1: Ensure `_helpers.ts` exposes `seedAlbumWithPhotos`**

If absent, append:

```ts
// tests/integration/_helpers.ts (append)
import { sql } from '@/lib/db';
import { generateShareToken } from '@/lib/share';
import { randomUUID } from 'node:crypto';

export async function seedAlbumWithPhotos(opts: {
  count: number;
  withPassword?: string | null;
  expiresAt?: Date | null;
  allowDownload?: boolean;
}): Promise<{ albumId: string; token: string; photoIds: string[] }> {
  const albumId = randomUUID();
  await sql`
    INSERT INTO albums (id, slug, title, status)
    VALUES (${albumId}, ${'a-' + albumId.slice(0, 8)}, 'Test Album', 'published')
  `;
  const photoIds: string[] = [];
  for (let i = 0; i < opts.count; i++) {
    const id = randomUUID();
    photoIds.push(id);
    await sql`
      INSERT INTO photos (id, album_id, filename, width, height, orig_bytes, sort_order, status)
      VALUES (${id}, ${albumId}, ${`p${i}.jpg`}, 1600, 1066, 2_000_000, ${i}, 'ready')
    `;
  }
  const token = generateShareToken();
  await sql`
    INSERT INTO share_links (token, album_id, password_hash, expires_at, allow_download)
    VALUES (${token}, ${albumId}, ${opts.withPassword ?? null}, ${opts.expiresAt ?? null}, ${opts.allowDownload ?? true})
  `;
  return { albumId, token, photoIds };
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/integration/_helpers.ts
git commit -m "test(m3): seedAlbumWithPhotos helper"
```

---

## Task 7: Server actions for share-link CRUD (`src/lib/share-actions.ts`)

**Files:**
- Create: `src/lib/share-actions.ts`
- Test: `tests/integration/share-actions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/share-actions.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, resetTestDb } from './_helpers';
import { sql } from '@/lib/db';
import { randomUUID } from 'node:crypto';
import { createShareLink, updateShareLink, revokeShareLink } from '@/lib/share-actions';

let albumId: string;
beforeAll(async () => { await setupTestDb(); });
afterAll(async () => { await teardownTestDb(); });
beforeEach(async () => {
  await resetTestDb();
  albumId = randomUUID();
  await sql`INSERT INTO albums (id, slug, title, status) VALUES (${albumId}, 'a', 't', 'published')`;
});

describe('share-link actions', () => {
  it('creates with optional password hashing', async () => {
    const link = await createShareLink(albumId, { password: 'hunter2', allowDownload: true });
    expect(link.token).toHaveLength(12);
    expect(link.password_hash).toMatch(/^\$argon2/);
    expect(link.allow_download).toBe(true);
  });

  it('creates with no password', async () => {
    const link = await createShareLink(albumId, { allowDownload: false });
    expect(link.password_hash).toBeNull();
    expect(link.allow_download).toBe(false);
  });

  it('updates expiry and download flag', async () => {
    const link = await createShareLink(albumId, {});
    const exp = new Date(Date.now() + 86400_000);
    const updated = await updateShareLink(link.token, { expiresAt: exp, allowDownload: false });
    expect(updated.allow_download).toBe(false);
    expect(updated.expires_at?.getTime()).toBe(exp.getTime());
  });

  it('changes password when newPassword provided, clears when null', async () => {
    const link = await createShareLink(albumId, { password: 'old' });
    const u1 = await updateShareLink(link.token, { newPassword: 'new' });
    expect(u1.password_hash).toMatch(/^\$argon2/);
    expect(u1.password_hash).not.toBe(link.password_hash);
    const u2 = await updateShareLink(link.token, { newPassword: null });
    expect(u2.password_hash).toBeNull();
  });

  it('revokes (deletes) the link', async () => {
    const link = await createShareLink(albumId, {});
    await revokeShareLink(link.token);
    const rows = await sql`SELECT 1 FROM share_links WHERE token = ${link.token}`;
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run tests/integration/share-actions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/share-actions.ts
'use server';

import argon2 from 'argon2';
import { sql } from '@/lib/db';
import { generateShareToken, type ShareLinkRow } from '@/lib/share';
import { requireAdmin } from '@/lib/session';
import { revalidatePath } from 'next/cache';

export interface CreateShareLinkInput {
  password?: string | null;
  expiresAt?: Date | null;
  allowDownload?: boolean;
}

export interface UpdateShareLinkInput {
  newPassword?: string | null; // undefined = leave alone, null = clear, string = set
  expiresAt?: Date | null;
  allowDownload?: boolean;
}

export async function createShareLink(albumId: string, input: CreateShareLinkInput): Promise<ShareLinkRow> {
  await requireAdmin();
  const passwordHash = input.password ? await argon2.hash(input.password) : null;
  // retry on token collision (extremely unlikely with 9 random bytes)
  for (let i = 0; i < 5; i++) {
    const token = generateShareToken();
    const rows = await sql<ShareLinkRow[]>`
      INSERT INTO share_links (token, album_id, password_hash, expires_at, allow_download)
      VALUES (${token}, ${albumId}, ${passwordHash}, ${input.expiresAt ?? null}, ${input.allowDownload ?? true})
      ON CONFLICT (token) DO NOTHING
      RETURNING token, album_id, password_hash, expires_at, allow_download, created_at
    `;
    if (rows[0]) {
      revalidatePath(`/admin/albums`);
      return rows[0];
    }
  }
  throw new Error('Failed to generate unique share token after 5 attempts');
}

export async function updateShareLink(token: string, input: UpdateShareLinkInput): Promise<ShareLinkRow> {
  await requireAdmin();
  let newPasswordHash: string | null | undefined = undefined;
  if (input.newPassword === null) newPasswordHash = null;
  else if (typeof input.newPassword === 'string') newPasswordHash = await argon2.hash(input.newPassword);

  const rows = await sql<ShareLinkRow[]>`
    UPDATE share_links SET
      password_hash = CASE WHEN ${newPasswordHash !== undefined} THEN ${newPasswordHash ?? null} ELSE password_hash END,
      expires_at = CASE WHEN ${input.expiresAt !== undefined} THEN ${input.expiresAt ?? null} ELSE expires_at END,
      allow_download = CASE WHEN ${input.allowDownload !== undefined} THEN ${input.allowDownload ?? true} ELSE allow_download END
    WHERE token = ${token}
    RETURNING token, album_id, password_hash, expires_at, allow_download, created_at
  `;
  if (!rows[0]) throw new Error('share link not found');
  revalidatePath(`/admin/albums`);
  return rows[0];
}

export async function revokeShareLink(token: string): Promise<void> {
  await requireAdmin();
  await sql`DELETE FROM share_links WHERE token = ${token}`;
  revalidatePath(`/admin/albums`);
}
```

> Note: For test env, `requireAdmin` must accept a test bypass. If your existing `src/lib/session.ts` doesn't expose one, the integration test should call the underlying SQL helpers directly. If `requireAdmin` blocks tests, refactor it to read `process.env.GH_TEST_BYPASS_AUTH === '1'`.

- [ ] **Step 4: Ensure `requireAdmin` has a test bypass**

In `src/lib/session.ts`, locate `requireAdmin` and prefix:

```ts
export async function requireAdmin() {
  if (process.env.GH_TEST_BYPASS_AUTH === '1') return { adminId: 'test-admin' };
  // ... existing logic
}
```

Set `GH_TEST_BYPASS_AUTH=1` in `vitest.config.ts` test env or in `_helpers.ts`'s setup.

- [ ] **Step 5: Run**

Run: `GH_TEST_BYPASS_AUTH=1 npx vitest run tests/integration/share-actions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/share-actions.ts tests/integration/share-actions.test.ts src/lib/session.ts
git commit -m "feat(m3): admin share-link CRUD server actions"
```

---

## Task 8: Admin ShareLinkCard component

**Files:**
- Create: `src/components/admin/ShareLinkCard.tsx`
- Create: `src/components/admin/ShareLinkSettingsDialog.tsx`
- Create: `src/components/admin/ShareLinkQrDialog.tsx`

- [ ] **Step 1: Implement the card**

```tsx
// src/components/admin/ShareLinkCard.tsx
'use client';

import { useState, useTransition } from 'react';
import { Copy, QrCode, Settings, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ShareLinkSettingsDialog } from './ShareLinkSettingsDialog';
import { ShareLinkQrDialog } from './ShareLinkQrDialog';

export interface ShareLinkCardProps {
  publicBaseUrl: string;
  link: {
    token: string;
    expiresAt: string | null;
    allowDownload: boolean;
    hasPassword: boolean;
    viewCount: number;
    favoriteCount: number;
  } | null;
  albumId: string;
  onCreate: () => void; // wired by parent server-component using server action
}

export function ShareLinkCard({ publicBaseUrl, link, albumId, onCreate }: ShareLinkCardProps) {
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!link) {
    return (
      <div className="rounded-2xl border border-rose-500/20 bg-gradient-to-br from-rose-500/10 to-rose-500/5 p-6">
        <h3 className="text-lg font-medium text-white">No share link yet</h3>
        <p className="mt-1 text-sm text-white/60">Generate a public URL clients can use to view this album.</p>
        <Button
          className="mt-4 cursor-pointer bg-rose-500 hover:bg-rose-400 text-white"
          disabled={pending}
          onClick={() => startTransition(() => onCreate())}
        >
          Create share link
        </Button>
      </div>
    );
  }

  const url = `${publicBaseUrl}/a/${link.token}`;
  const copy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="rounded-2xl border border-rose-500/20 bg-gradient-to-br from-rose-500/10 to-rose-500/5 p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-rose-300/80">Share link</div>
          <div className="mt-1 truncate font-mono text-lg text-white">{url}</div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="cursor-pointer text-white/80 hover:text-white" aria-label="Copy URL" onClick={copy}>
            {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" className="cursor-pointer text-white/80 hover:text-white" aria-label="Show QR code" onClick={() => setShowQr(true)}>
            <QrCode className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="cursor-pointer text-white/80 hover:text-white" aria-label="Settings" onClick={() => setShowSettings(true)}>
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 text-sm text-white/70 sm:grid-cols-4">
        <Stat label="Expires" value={link.expiresAt ? new Date(link.expiresAt).toLocaleDateString() : 'Never'} />
        <Stat label="Views" value={link.viewCount.toString()} />
        <Stat label="Favorites" value={link.favoriteCount.toString()} accent />
        <Stat label="Password" value={link.hasPassword ? 'On' : 'Off'} />
      </div>
      <ShareLinkSettingsDialog open={showSettings} onOpenChange={setShowSettings} token={link.token} initial={{
        expiresAt: link.expiresAt, allowDownload: link.allowDownload, hasPassword: link.hasPassword,
      }} />
      <ShareLinkQrDialog open={showQr} onOpenChange={setShowQr} url={url} />
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-white/40">{label}</div>
      <div className={`mt-0.5 ${accent ? 'text-rose-300' : 'text-white'}`}>{value}</div>
    </div>
  );
}
```

- [ ] **Step 2: Implement the QR dialog**

```tsx
// src/components/admin/ShareLinkQrDialog.tsx
'use client';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export function ShareLinkQrDialog({ open, onOpenChange, url }: { open: boolean; onOpenChange: (b: boolean) => void; url: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    QRCode.toDataURL(url, { margin: 1, width: 512, color: { dark: '#0a0a0a', light: '#ffffff' } }).then(setDataUrl);
  }, [open, url]);

  const download = () => {
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `share-qr.png`;
    a.click();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-neutral-950 border-white/10">
        <DialogHeader><DialogTitle className="text-white">Scan to open</DialogTitle></DialogHeader>
        <div className="flex flex-col items-center gap-4 p-2">
          {dataUrl ? <img src={dataUrl} alt="QR code" className="h-72 w-72 rounded-lg" /> : <div className="h-72 w-72 bg-white/5 rounded-lg" />}
          <Button className="cursor-pointer bg-rose-500 hover:bg-rose-400 text-white" disabled={!dataUrl} onClick={download}>Download PNG</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Implement the settings dialog**

```tsx
// src/components/admin/ShareLinkSettingsDialog.tsx
'use client';
import { useState, useTransition } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { updateShareLink, revokeShareLink } from '@/lib/share-actions';

interface Props {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  token: string;
  initial: { expiresAt: string | null; allowDownload: boolean; hasPassword: boolean };
}

export function ShareLinkSettingsDialog({ open, onOpenChange, token, initial }: Props) {
  const [allowDownload, setAllowDownload] = useState(initial.allowDownload);
  const [expiresAt, setExpiresAt] = useState<string>(initial.expiresAt ? initial.expiresAt.slice(0, 10) : '');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [pending, startTransition] = useTransition();

  const save = () => startTransition(async () => {
    await updateShareLink(token, {
      allowDownload,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      newPassword: clearPassword ? null : (password ? password : undefined),
    });
    onOpenChange(false);
  });

  const revoke = () => startTransition(async () => {
    if (!confirm('Revoke this share link? Anyone with the URL will lose access.')) return;
    await revokeShareLink(token);
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-neutral-950 border-white/10 text-white">
        <DialogHeader><DialogTitle>Share-link settings</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={allowDownload} onChange={e => setAllowDownload(e.target.checked)} />
            Allow downloads
          </label>
          <div>
            <label className="block text-sm text-white/70">Expires</label>
            <Input type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm text-white/70">Password (leave blank to keep current)</label>
            <Input type="password" value={password} disabled={clearPassword} onChange={e => setPassword(e.target.value)} />
            {initial.hasPassword && (
              <label className="mt-1 flex items-center gap-2 text-xs cursor-pointer text-white/60">
                <input type="checkbox" checked={clearPassword} onChange={e => setClearPassword(e.target.checked)} />
                Remove password protection
              </label>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" className="cursor-pointer text-rose-300 hover:text-rose-200" onClick={revoke} disabled={pending}>Revoke link</Button>
          <Button className="cursor-pointer bg-rose-500 hover:bg-rose-400 text-white" onClick={save} disabled={pending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/admin/ShareLinkCard.tsx src/components/admin/ShareLinkQrDialog.tsx src/components/admin/ShareLinkSettingsDialog.tsx
git commit -m "feat(m3): admin ShareLinkCard with copy/QR/settings"
```

---

## Task 9: Wire ShareLinkCard into the album-detail page

**Files:**
- Modify: `src/app/admin/albums/[slug]/page.tsx`

- [ ] **Step 1: Add data fetching + wiring**

At the top of the page server component, after loading the album, add:

```tsx
import { ShareLinkCard } from '@/components/admin/ShareLinkCard';
import { createShareLink } from '@/lib/share-actions';
import { sql } from '@/lib/db';

async function loadShareLinkSummary(albumId: string) {
  const rows = await sql<{
    token: string; expires_at: Date | null; allow_download: boolean; password_hash: string | null;
    views: string; favs: string;
  }[]>`
    SELECT sl.token, sl.expires_at, sl.allow_download, sl.password_hash,
      (SELECT COUNT(*) FROM view_events ve WHERE ve.share_token = sl.token AND ve.event_type = 'page_view')::text AS views,
      (SELECT COUNT(*) FROM favorites f WHERE f.share_token = sl.token)::text AS favs
    FROM share_links sl
    WHERE sl.album_id = ${albumId}
    ORDER BY sl.created_at DESC
    LIMIT 1
  `;
  const r = rows[0];
  return r ? {
    token: r.token,
    expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
    allowDownload: r.allow_download,
    hasPassword: r.password_hash !== null,
    viewCount: Number(r.views),
    favoriteCount: Number(r.favs),
  } : null;
}
```

And inside the JSX, between meta and stats strip:

```tsx
const link = await loadShareLinkSummary(album.id);
async function handleCreate() {
  'use server';
  await createShareLink(album.id, {});
}

<ShareLinkCard
  publicBaseUrl={process.env.PUBLIC_BASE_URL ?? ''}
  link={link}
  albumId={album.id}
  onCreate={handleCreate}
/>
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: SUCCESS, no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/albums/[slug]/page.tsx
git commit -m "feat(m3): embed ShareLinkCard on album detail page"
```

---

## Task 10: Justified-rows algorithm (`src/lib/justified.ts`)

**Files:**
- Create: `src/lib/justified.ts`
- Test: `tests/unit/justified.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/justified.test.ts
import { describe, it, expect } from 'vitest';
import { layoutJustifiedRows } from '@/lib/justified';

const photo = (id: string, w: number, h: number) => ({ id, width: w, height: h });

describe('layoutJustifiedRows', () => {
  it('packs photos into rows that exactly fill containerWidth', () => {
    const rows = layoutJustifiedRows({
      photos: [photo('a', 1600, 1000), photo('b', 1000, 1500), photo('c', 1200, 800), photo('d', 1500, 1000)],
      containerWidth: 1200,
      targetRowHeight: 240,
      gap: 8,
      maxLastRowScale: 1.5,
    });
    for (const r of rows.slice(0, -1)) {
      const sum = r.items.reduce((s, it) => s + it.width, 0) + (r.items.length - 1) * 8;
      expect(Math.abs(sum - 1200)).toBeLessThan(0.5);
    }
  });

  it('preserves aspect ratios', () => {
    const rows = layoutJustifiedRows({
      photos: [photo('a', 1600, 1000), photo('b', 1000, 1500), photo('c', 1200, 800)],
      containerWidth: 1200, targetRowHeight: 240, gap: 8, maxLastRowScale: 1.5,
    });
    for (const r of rows) {
      for (const it of r.items) {
        const src = [photo('a',1600,1000), photo('b',1000,1500), photo('c',1200,800)].find(p => p.id === it.id)!;
        const srcRatio = src.width / src.height;
        const itRatio = it.width / it.height;
        expect(Math.abs(srcRatio - itRatio)).toBeLessThan(0.01);
      }
    }
  });

  it('caps the last short row at maxLastRowScale * targetRowHeight', () => {
    const rows = layoutJustifiedRows({
      photos: [photo('a', 1600, 1000)],
      containerWidth: 1200, targetRowHeight: 240, gap: 8, maxLastRowScale: 1.5,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].height).toBeLessThanOrEqual(240 * 1.5 + 0.01);
  });

  it('returns empty array for empty input', () => {
    expect(layoutJustifiedRows({ photos: [], containerWidth: 1000, targetRowHeight: 240, gap: 8, maxLastRowScale: 1.5 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run tests/unit/justified.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// src/lib/justified.ts
export interface JustifiedInput {
  photos: { id: string; width: number; height: number }[];
  containerWidth: number;
  targetRowHeight: number;
  gap: number;
  maxLastRowScale: number;
}

export interface JustifiedItem { id: string; width: number; height: number }
export interface JustifiedRow { height: number; items: JustifiedItem[] }

/**
 * Greedy row-packing: accumulate photos until the sum of widths (at target height) plus gaps
 * exceeds container width. Then scale the row height so the row exactly fits.
 *
 * For the last row, if its summed ideal width < containerWidth, use natural aspect ratio
 * but cap at maxLastRowScale * targetRowHeight.
 */
export function layoutJustifiedRows(input: JustifiedInput): JustifiedRow[] {
  const { photos, containerWidth, targetRowHeight, gap, maxLastRowScale } = input;
  if (photos.length === 0) return [];

  const rows: JustifiedRow[] = [];
  let current: typeof photos = [];
  let currentRatioSum = 0;

  const ratio = (p: { width: number; height: number }) => p.width / p.height;
  const widthAtHeight = (p: { width: number; height: number }, h: number) => ratio(p) * h;

  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    const tentative = [...current, p];
    const tentativeRatioSum = currentRatioSum + ratio(p);
    const tentativeWidth = tentativeRatioSum * targetRowHeight + gap * (tentative.length - 1);

    if (tentativeWidth >= containerWidth && current.length > 0) {
      // Compare which packing is closer to containerWidth: current vs tentative.
      const currentWidth = currentRatioSum * targetRowHeight + gap * Math.max(0, current.length - 1);
      const includeNew = Math.abs(tentativeWidth - containerWidth) <= Math.abs(containerWidth - currentWidth);
      const rowPhotos = includeNew ? tentative : current;
      const rowRatioSum = includeNew ? tentativeRatioSum : currentRatioSum;
      const availableWidth = containerWidth - gap * (rowPhotos.length - 1);
      const rowHeight = availableWidth / rowRatioSum;
      rows.push({
        height: rowHeight,
        items: rowPhotos.map(rp => ({ id: rp.id, width: widthAtHeight(rp, rowHeight), height: rowHeight })),
      });
      if (includeNew) {
        current = [];
        currentRatioSum = 0;
      } else {
        current = [p];
        currentRatioSum = ratio(p);
      }
    } else {
      current = tentative;
      currentRatioSum = tentativeRatioSum;
    }
  }

  if (current.length > 0) {
    // Last row: keep natural aspect, but cap height
    let rowHeight = targetRowHeight;
    const naturalWidth = currentRatioSum * rowHeight + gap * (current.length - 1);
    if (naturalWidth < containerWidth) {
      // expand to fill, but cap
      const availableWidth = containerWidth - gap * (current.length - 1);
      const fillHeight = availableWidth / currentRatioSum;
      rowHeight = Math.min(fillHeight, targetRowHeight * maxLastRowScale);
    } else {
      // shrink to fit
      const availableWidth = containerWidth - gap * (current.length - 1);
      rowHeight = availableWidth / currentRatioSum;
    }
    rows.push({
      height: rowHeight,
      items: current.map(rp => ({ id: rp.id, width: widthAtHeight(rp, rowHeight), height: rowHeight })),
    });
  }

  return rows;
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run tests/unit/justified.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/justified.ts tests/unit/justified.test.ts
git commit -m "feat(m3): justified-row layout algorithm"
```

---

## Task 11: Double-tap detection utility

**Files:**
- Create: `src/lib/double-tap.ts`
- Test: `tests/unit/double-tap.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/double-tap.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createDoubleTapDetector } from '@/lib/double-tap';

describe('createDoubleTapDetector', () => {
  it('fires onDouble when two taps occur within window', () => {
    const onDouble = vi.fn();
    const onSingle = vi.fn();
    const d = createDoubleTapDetector({ windowMs: 300, onDouble, onSingle });
    let t = 1000;
    d.tap(t);
    d.tap(t + 200);
    expect(onDouble).toHaveBeenCalledTimes(1);
    expect(onSingle).not.toHaveBeenCalled();
  });

  it('does not fire onDouble when taps are outside window', () => {
    const onDouble = vi.fn();
    const onSingle = vi.fn();
    const d = createDoubleTapDetector({ windowMs: 300, onDouble, onSingle });
    d.tap(1000);
    d.tap(1400);
    expect(onDouble).not.toHaveBeenCalled();
  });

  it('three quick taps fire one double then start a new sequence', () => {
    const onDouble = vi.fn();
    const d = createDoubleTapDetector({ windowMs: 300, onDouble, onSingle: () => {} });
    d.tap(1000);
    d.tap(1100);
    d.tap(1200);
    expect(onDouble).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run tests/unit/double-tap.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/double-tap.ts
export interface DoubleTapOpts {
  windowMs: number;
  onDouble: () => void;
  onSingle?: () => void;
}

export interface DoubleTapDetector {
  tap(now?: number): void;
  reset(): void;
}

export function createDoubleTapDetector(opts: DoubleTapOpts): DoubleTapDetector {
  let lastTapAt = 0;
  return {
    tap(now: number = Date.now()) {
      if (now - lastTapAt <= opts.windowMs && lastTapAt !== 0) {
        opts.onDouble();
        lastTapAt = 0;
        return;
      }
      lastTapAt = now;
      if (opts.onSingle) {
        const captured = now;
        setTimeout(() => {
          if (lastTapAt === captured) {
            opts.onSingle?.();
            lastTapAt = 0;
          }
        }, opts.windowMs);
      }
    },
    reset() { lastTapAt = 0; },
  };
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run tests/unit/double-tap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/double-tap.ts tests/unit/double-tap.test.ts
git commit -m "feat(m3): double-tap detector utility"
```

---

## Task 12: Heart burst + heart overlay components

**Files:**
- Create: `src/components/gallery/HeartBurst.tsx`
- Create: `src/components/gallery/HeartOverlay.tsx`
- Modify: `src/styles/globals.css`

- [ ] **Step 1: Add keyframes**

In `src/styles/globals.css`, append:

```css
@keyframes heart-burst {
  0%   { transform: scale(0.4) rotate(-8deg); opacity: 0; }
  30%  { transform: scale(1.2) rotate(0deg); opacity: 1; }
  60%  { transform: scale(1.0) rotate(2deg); opacity: 1; }
  100% { transform: scale(1.4) rotate(0deg); opacity: 0; }
}
.heart-burst-anim { animation: heart-burst 600ms ease-out forwards; }

.glass-dock {
  background: rgba(20, 20, 24, 0.72);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
```

- [ ] **Step 2: Implement HeartBurst**

```tsx
// src/components/gallery/HeartBurst.tsx
'use client';
import { Heart } from 'lucide-react';
import { useEffect, useState } from 'react';

export function HeartBurst({ trigger }: { trigger: number }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (trigger === 0) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 650);
    return () => clearTimeout(t);
  }, [trigger]);
  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden>
      <Heart className="h-32 w-32 fill-rose-500 stroke-rose-300 drop-shadow-2xl heart-burst-anim" />
    </div>
  );
}
```

- [ ] **Step 3: Implement HeartOverlay (the small corner toggle)**

```tsx
// src/components/gallery/HeartOverlay.tsx
'use client';
import { Heart } from 'lucide-react';
import { cn } from '@/lib/utils';

export function HeartOverlay({ liked, onClick, className }: { liked: boolean; onClick: (e: React.MouseEvent) => void; className?: string }) {
  return (
    <button
      type="button"
      aria-label={liked ? 'Remove from favorites' : 'Add to favorites'}
      aria-pressed={liked}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      className={cn(
        'absolute right-2 top-2 inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-full transition',
        'bg-black/50 backdrop-blur hover:bg-black/70 active:scale-95',
        className,
      )}
    >
      <Heart className={cn('h-5 w-5', liked ? 'fill-rose-500 stroke-rose-300' : 'stroke-white/90')} />
    </button>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/gallery/HeartBurst.tsx src/components/gallery/HeartOverlay.tsx src/styles/globals.css
git commit -m "feat(m3): heart-burst + heart-overlay components"
```

---

## Task 13: Server actions for public routes (`src/app/a/[token]/_actions.ts`)

**Files:**
- Create: `src/app/a/[token]/_actions.ts`
- Test: `tests/integration/unlock.test.ts`

- [ ] **Step 1: Write the failing test for unlock**

```ts
// tests/integration/unlock.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, resetTestDb, seedAlbumWithPhotos } from './_helpers';
import argon2 from 'argon2';
import { sql } from '@/lib/db';
import { verifyUnlockPassword } from '@/lib/share-public'; // pure helper, see below

beforeAll(async () => { await setupTestDb(); });
afterAll(async () => { await teardownTestDb(); });
beforeEach(async () => { await resetTestDb(); });

describe('verifyUnlockPassword', () => {
  it('accepts the correct password', async () => {
    const hash = await argon2.hash('hunter2');
    const { token } = await seedAlbumWithPhotos({ count: 1, withPassword: hash });
    const ok = await verifyUnlockPassword(token, 'hunter2');
    expect(ok).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await argon2.hash('hunter2');
    const { token } = await seedAlbumWithPhotos({ count: 1, withPassword: hash });
    const ok = await verifyUnlockPassword(token, 'wrong');
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Create the pure helper**

```ts
// src/lib/share-public.ts
import argon2 from 'argon2';
import { loadShareLink } from '@/lib/share';

export async function verifyUnlockPassword(token: string, password: string): Promise<boolean> {
  const link = await loadShareLink(token);
  if (!link?.password_hash) return false;
  try {
    return await argon2.verify(link.password_hash, password);
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: Run**

Run: `npx vitest run tests/integration/unlock.test.ts`
Expected: PASS.

- [ ] **Step 4: Build the server actions file**

```ts
// src/app/a/[token]/_actions.ts
'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { resolveShareLinkStatus, unlockCookieName, signUnlockValue, UNLOCK_TTL_SECONDS } from '@/lib/share';
import { verifyUnlockPassword } from '@/lib/share-public';
import { toggleFavoriteForViewer } from '@/lib/favorites';
import { resolveViewerId, ADMIN_PREVIEW_VIEWER_ID } from '@/lib/viewer';
import { getCurrentAdmin } from '@/lib/session';

async function getViewer(token: string, isAdminPreview: boolean) {
  const jar = await cookies();
  const jarLike = {
    get: (n: string) => jar.get(n),
    set: (n: string, v: string, opts: any) => jar.set(n, v, opts),
  };
  return resolveViewerId(jarLike as any, token, { isAdminPreview });
}

export async function toggleFavorite(token: string, photoId: string): Promise<{ liked: boolean }> {
  const jar = await cookies();
  const unlocked = jar.get(unlockCookieName(token))?.value ?? null;
  const status = await resolveShareLinkStatus(token, unlocked);
  if (status.kind !== 'ok') throw new Error(`share link not accessible: ${status.kind}`);

  const admin = await getCurrentAdmin().catch(() => null);
  const isAdminPreview = admin !== null;
  if (isAdminPreview) {
    // admin preview: do NOT persist
    return { liked: false };
  }
  const viewerId = await getViewer(token, false);
  const res = await toggleFavoriteForViewer(token, photoId, viewerId);
  revalidatePath(`/a/${token}`);
  revalidatePath(`/a/${token}/favorites`);
  return { liked: res.state === 'added' };
}

export async function unlockShareLink(token: string, formData: FormData): Promise<void> {
  const password = String(formData.get('password') ?? '');
  const ok = await verifyUnlockPassword(token, password);
  if (!ok) {
    redirect(`/a/${token}/password?error=1`);
  }
  const jar = await cookies();
  jar.set(unlockCookieName(token), signUnlockValue(token, Date.now()), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: `/a/${token}`,
    maxAge: UNLOCK_TTL_SECONDS,
  });
  redirect(`/a/${token}`);
}
```

- [ ] **Step 5: Commit**

```bash
git add src/app/a/[token]/_actions.ts src/lib/share-public.ts tests/integration/unlock.test.ts
git commit -m "feat(m3): public share-link server actions (unlock, toggleFavorite)"
```

---

## Task 14: Public layout (`src/app/a/[token]/layout.tsx`)

**Files:**
- Create: `src/app/a/[token]/layout.tsx`
- Create: `src/app/a/[token]/not-found.tsx`
- Create: `src/app/a/[token]/gone.tsx`

- [ ] **Step 1: Implement the layout**

```tsx
// src/app/a/[token]/layout.tsx
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { resolveShareLinkStatus, unlockCookieName } from '@/lib/share';
import { resolveViewerId } from '@/lib/viewer';
import { getCurrentAdmin } from '@/lib/session';
import { redirect } from 'next/navigation';
import Gone from './gone';

export const dynamic = 'force-dynamic';

export default async function PublicShareLayout({
  children,
  params,
}: { children: ReactNode; params: Promise<{ token: string }> }) {
  const { token } = await params;
  const jar = await cookies();
  const unlocked = jar.get(unlockCookieName(token))?.value ?? null;
  const status = await resolveShareLinkStatus(token, unlocked);

  if (status.kind === 'not_found') notFound();
  if (status.kind === 'expired') return <Gone />;
  if (status.kind === 'locked') {
    redirect(`/a/${token}/password`);
  }

  // ok — issue viewer cookie unless admin preview
  const admin = await getCurrentAdmin().catch(() => null);
  const isAdminPreview = admin !== null;
  resolveViewerId(
    { get: (n) => jar.get(n), set: (n, v, o) => jar.set(n, v, o) } as any,
    token,
    { isAdminPreview },
  );

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white antialiased">
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Not-found page**

```tsx
// src/app/a/[token]/not-found.tsx
export default function NotFound() {
  return (
    <html lang="en"><body className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center">
      <div className="text-center">
        <div className="text-6xl font-light tracking-wide">404</div>
        <div className="mt-2 text-white/60">This share link doesn't exist.</div>
      </div>
    </body></html>
  );
}
```

- [ ] **Step 3: Gone page**

```tsx
// src/app/a/[token]/gone.tsx
export default function Gone() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center">
      <div className="text-center">
        <div className="text-6xl font-light tracking-wide">410</div>
        <div className="mt-2 text-white/60">This share link has expired.</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/a/[token]/layout.tsx src/app/a/[token]/not-found.tsx src/app/a/[token]/gone.tsx
git commit -m "feat(m3): public share layout with token gating"
```

---

## Task 15: Password gate page

**Files:**
- Create: `src/app/a/[token]/password/page.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/app/a/[token]/password/page.tsx
import { unlockShareLink } from '../_actions';

export default async function PasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const action = unlockShareLink.bind(null, token);
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] text-white">
      <form action={action} className="w-full max-w-sm space-y-4 p-6">
        <h1 className="text-2xl font-light">Enter password</h1>
        <p className="text-sm text-white/60">This gallery is protected.</p>
        <input
          type="password"
          name="password"
          autoFocus
          required
          className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 outline-none focus:border-rose-500/60"
          placeholder="Password"
        />
        {sp.error && <div className="text-sm text-rose-400">Incorrect password.</div>}
        <button className="w-full cursor-pointer rounded-md bg-rose-500 px-4 py-2 font-medium hover:bg-rose-400">Unlock</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/a/[token]/password/page.tsx
git commit -m "feat(m3): password gate page with server-action unlock"
```

---

## Task 16: JustifiedGrid component

**Files:**
- Create: `src/components/gallery/JustifiedGrid.tsx`
- Create: `src/components/gallery/PhotoCard.tsx`

- [ ] **Step 1: Implement PhotoCard**

```tsx
// src/components/gallery/PhotoCard.tsx
'use client';
import Image from 'next/image';
import Link from 'next/link';
import { useRef, useState, useTransition } from 'react';
import { createDoubleTapDetector } from '@/lib/double-tap';
import { HeartOverlay } from './HeartOverlay';
import { HeartBurst } from './HeartBurst';
import { toggleFavorite } from '@/app/a/[token]/_actions';

export interface PhotoCardProps {
  token: string;
  photo: { id: string; width: number; height: number };
  webSrc: string;
  isLiked: boolean;
  href: string;
  renderWidth: number;
  renderHeight: number;
}

export function PhotoCard({ token, photo, webSrc, isLiked, href, renderWidth, renderHeight }: PhotoCardProps) {
  const [liked, setLiked] = useState(isLiked);
  const [burstId, setBurstId] = useState(0);
  const [, startTransition] = useTransition();
  const detectorRef = useRef(
    createDoubleTapDetector({
      windowMs: 300,
      onDouble: () => fireToggle(),
    })
  );
  const fireToggle = () => {
    setLiked(prev => !prev);
    setBurstId(b => b + 1);
    startTransition(() => { toggleFavorite(token, photo.id); });
  };
  return (
    <div className="relative overflow-hidden rounded-lg bg-white/5"
         style={{ width: renderWidth, height: renderHeight }}
         onClick={(e) => {
           // double-tap detection on the wrapper; single-tap = navigate via Link below.
           detectorRef.current.tap();
         }}>
      <Link href={href} prefetch={false} className="block h-full w-full">
        <Image
          src={webSrc}
          alt=""
          width={Math.round(renderWidth)}
          height={Math.round(renderHeight)}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          sizes={`${Math.round(renderWidth)}px`}
        />
      </Link>
      <HeartOverlay liked={liked} onClick={fireToggle} />
      <HeartBurst trigger={burstId} />
    </div>
  );
}
```

> Note: The double-tap handler and the `<Link>` both receive the click. Because `<Link>` navigates synchronously on click, on a single click the lightbox opens (intended). On a fast double-click, the detector triggers `fireToggle`, but the first click also navigates. To prevent navigation on the second click of a double-tap, change Link's click handler to call `preventDefault()` if a tap has been recorded within the last 50ms. Implement that with an explicit `onClickCapture`:

Replace the wrapper's `onClick` and the `<Link>` with:

```tsx
const lastTapRef = useRef(0);
return (
  <div className="relative overflow-hidden rounded-lg bg-white/5"
       style={{ width: renderWidth, height: renderHeight }}>
    <Link
      href={href}
      prefetch={false}
      onClick={(e) => {
        const now = Date.now();
        if (now - lastTapRef.current < 300) {
          e.preventDefault();
          fireToggle();
          lastTapRef.current = 0;
          return;
        }
        lastTapRef.current = now;
      }}
      className="block h-full w-full"
    >
      <Image
        src={webSrc} alt="" width={Math.round(renderWidth)} height={Math.round(renderHeight)}
        loading="lazy" decoding="async" className="h-full w-full object-cover"
        sizes={`${Math.round(renderWidth)}px`}
      />
    </Link>
    <HeartOverlay liked={liked} onClick={fireToggle} />
    <HeartBurst trigger={burstId} />
  </div>
);
```

(Drop the `createDoubleTapDetector` import for this component — it's not used in this final variant.)

- [ ] **Step 2: Implement JustifiedGrid**

```tsx
// src/components/gallery/JustifiedGrid.tsx
'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { layoutJustifiedRows } from '@/lib/justified';
import { PhotoCard } from './PhotoCard';

export interface JustifiedGridPhoto {
  id: string;
  width: number;
  height: number;
  webUrl: string;
}

export interface JustifiedGridProps {
  token: string;
  photos: JustifiedGridPhoto[];
  favoriteIds: Set<string>;
  hrefForPhoto: (photoId: string) => string;
  desktopTargetHeight?: number;
  mobileTargetHeight?: number;
  gap?: number;
}

export function JustifiedGrid(props: JustifiedGridProps) {
  const { token, photos, favoriteIds, hrefForPhoto } = props;
  const desktopTarget = props.desktopTargetHeight ?? 240;
  const mobileTarget = props.mobileTargetHeight ?? 130;
  const gap = props.gap ?? 8;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number>(0);
  const [isMobile, setIsMobile] = useState<boolean>(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        setWidth(e.contentRect.width);
        setIsMobile(e.contentRect.width < 640);
      }
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    setIsMobile(el.clientWidth < 640);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => {
    if (width === 0) return [];
    return layoutJustifiedRows({
      photos,
      containerWidth: width,
      targetRowHeight: isMobile ? mobileTarget : desktopTarget,
      gap,
      maxLastRowScale: 1.5,
    });
  }, [photos, width, isMobile, desktopTarget, mobileTarget, gap]);

  return (
    <div ref={containerRef} className="w-full">
      {rows.map((row, ri) => (
        <div key={ri} className="flex" style={{ gap, marginBottom: gap }}>
          {row.items.map(item => {
            const photo = photos.find(p => p.id === item.id)!;
            return (
              <PhotoCard
                key={item.id}
                token={token}
                photo={photo}
                webSrc={photo.webUrl}
                isLiked={favoriteIds.has(item.id)}
                href={hrefForPhoto(item.id)}
                renderWidth={item.width}
                renderHeight={item.height}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/gallery/JustifiedGrid.tsx src/components/gallery/PhotoCard.tsx
git commit -m "feat(m3): JustifiedGrid + PhotoCard with double-tap to like"
```

---

## Task 17: Mobile tab bar + glass dock + export modal placeholder

**Files:**
- Create: `src/components/gallery/MobileTabBar.tsx`
- Create: `src/components/gallery/GlassDock.tsx`
- Create: `src/components/gallery/ExportModalPlaceholder.tsx`

- [ ] **Step 1: MobileTabBar**

```tsx
// src/components/gallery/MobileTabBar.tsx
'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Grid, Heart, Download } from 'lucide-react';
import { cn } from '@/lib/utils';

export function MobileTabBar({ token, onExportClick }: { token: string; onExportClick: () => void }) {
  const pathname = usePathname();
  const isAll = pathname === `/a/${token}`;
  const isFav = pathname === `/a/${token}/favorites`;
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 md:hidden">
      <div className="glass-dock mx-auto mb-4 flex w-[min(92vw,420px)] items-center justify-around rounded-full px-4 py-2.5">
        <Tab href={`/a/${token}`} active={isAll} icon={<Grid className="h-5 w-5" />} label="All" />
        <Tab href={`/a/${token}/favorites`} active={isFav} icon={<Heart className="h-5 w-5" />} label="Favorites" />
        <button onClick={onExportClick} className="flex h-11 flex-col items-center justify-center gap-0.5 px-3 cursor-pointer text-white/70 hover:text-white" aria-label="Export">
          <Download className="h-5 w-5" />
          <span className="text-[10px]">Export</span>
        </button>
      </div>
    </nav>
  );
}

function Tab({ href, active, icon, label }: { href: string; active: boolean; icon: React.ReactNode; label: string }) {
  return (
    <Link href={href} className={cn('flex h-11 flex-col items-center justify-center gap-0.5 px-3', active ? 'text-rose-300' : 'text-white/70 hover:text-white')}>
      {icon}
      <span className="text-[10px]">{label}</span>
    </Link>
  );
}
```

- [ ] **Step 2: GlassDock**

```tsx
// src/components/gallery/GlassDock.tsx
'use client';
import { ChevronRight, Download } from 'lucide-react';

export function GlassDock({ count, sizeLabel, onClick }: { count: number; sizeLabel: string; onClick: () => void }) {
  if (count === 0) return null;
  return (
    <button
      onClick={onClick}
      className="glass-dock fixed bottom-24 left-1/2 z-30 flex w-[min(92vw,480px)] -translate-x-1/2 items-center gap-3 rounded-2xl px-4 py-3 text-left cursor-pointer hover:bg-white/5 md:bottom-8"
    >
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-rose-500 to-rose-700">
        <Download className="h-5 w-5 text-white" />
      </span>
      <span className="flex-1">
        <span className="block text-sm font-medium text-white">Export favorites</span>
        <span className="block text-xs text-white/60">{count} photos · {sizeLabel} · ZIP</span>
      </span>
      <ChevronRight className="h-5 w-5 text-white/60" />
    </button>
  );
}
```

- [ ] **Step 3: ExportModalPlaceholder**

```tsx
// src/components/gallery/ExportModalPlaceholder.tsx
'use client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function ExportModalPlaceholder({ open, onOpenChange }: { open: boolean; onOpenChange: (b: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-neutral-950 border-white/10 text-white">
        <DialogHeader><DialogTitle>Export</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2 text-sm text-white/70">
          <p>Three export options will land in M4:</p>
          <ul className="list-disc pl-5">
            <li>Favorites only (originals)</li>
            <li>Whole album (web-size, 2400px max)</li>
            <li>Whole album (originals)</li>
          </ul>
          <p className="text-xs text-white/40">ZIPs are cached for 24h after first generation.</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/gallery/MobileTabBar.tsx src/components/gallery/GlassDock.tsx src/components/gallery/ExportModalPlaceholder.tsx
git commit -m "feat(m3): mobile tabbar, glass dock CTA, export modal placeholder"
```

---

## Task 18: Gallery page (`/a/[token]/page.tsx`)

**Files:**
- Create: `src/app/a/[token]/page.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/app/a/[token]/page.tsx
import { cookies } from 'next/headers';
import { sql } from '@/lib/db';
import { resolveShareLinkStatus, unlockCookieName } from '@/lib/share';
import { resolveViewerId } from '@/lib/viewer';
import { listFavoritePhotoIds } from '@/lib/favorites';
import { logViewEvent } from '@/lib/view-events';
import { getCurrentAdmin } from '@/lib/session';
import { JustifiedGrid, type JustifiedGridPhoto } from '@/components/gallery/JustifiedGrid';
import { GalleryClientShell } from './_gallery-shell';
import { presignedGetUrl } from '@/lib/minio';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function GalleryPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const jar = await cookies();
  const unlocked = jar.get(unlockCookieName(token))?.value ?? null;
  const status = await resolveShareLinkStatus(token, unlocked);
  if (status.kind !== 'ok') notFound();
  const link = status.link;

  const admin = await getCurrentAdmin().catch(() => null);
  const isAdminPreview = admin !== null;
  const viewerId = resolveViewerId({ get: (n) => jar.get(n), set: (n, v, o) => jar.set(n, v, o) } as any, token, { isAdminPreview });

  // load album + photos + favorites in parallel
  const [albumRows, photoRows, favoriteIds] = await Promise.all([
    sql<{ id: string; title: string; subtitle: string | null; cover_photo_id: string | null }[]>`
      SELECT id, title, subtitle, cover_photo_id FROM albums WHERE id = ${link.album_id} LIMIT 1
    `,
    sql<{ id: string; width: number; height: number }[]>`
      SELECT id, width, height FROM photos
      WHERE album_id = ${link.album_id} AND status = 'ready'
      ORDER BY sort_order ASC, created_at ASC
    `,
    listFavoritePhotoIds(token, viewerId),
  ]);
  const album = albumRows[0];
  if (!album) notFound();

  await logViewEvent(token, viewerId, 'page_view');

  const photos: JustifiedGridPhoto[] = await Promise.all(
    photoRows.map(async p => ({
      id: p.id,
      width: p.width,
      height: p.height,
      webUrl: await presignedGetUrl(`albums/${link.album_id}/${p.id}/web.webp`),
    })),
  );

  let coverUrl: string | null = null;
  if (album.cover_photo_id) {
    coverUrl = await presignedGetUrl(`albums/${link.album_id}/${album.cover_photo_id}/large.webp`);
  } else if (photoRows[0]) {
    coverUrl = await presignedGetUrl(`albums/${link.album_id}/${photoRows[0].id}/large.webp`);
  }

  return (
    <GalleryClientShell token={token} coverUrl={coverUrl} title={album.title} subtitle={album.subtitle ?? ''}>
      <JustifiedGrid
        token={token}
        photos={photos}
        favoriteIds={new Set(favoriteIds)}
        hrefForPhoto={(pid) => `/a/${token}/p/${pid}`}
      />
    </GalleryClientShell>
  );
}
```

- [ ] **Step 2: Implement the client shell that hosts the hero + tab bar + modal**

```tsx
// src/app/a/[token]/_gallery-shell.tsx
'use client';
import { useState } from 'react';
import { MobileTabBar } from '@/components/gallery/MobileTabBar';
import { ExportModalPlaceholder } from '@/components/gallery/ExportModalPlaceholder';

export function GalleryClientShell({ token, coverUrl, title, subtitle, children }: {
  token: string; coverUrl: string | null; title: string; subtitle: string; children: React.ReactNode;
}) {
  const [exportOpen, setExportOpen] = useState(false);
  return (
    <>
      <header className="relative aspect-[16/9] w-full overflow-hidden">
        {coverUrl && <img src={coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />}
        <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0a] via-[#0a0a0a]/40 to-transparent" />
        <div className="absolute bottom-6 left-6 right-6">
          <h1 className="text-3xl font-light tracking-wide text-white md:text-5xl">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-white/70 md:text-base">{subtitle}</p>}
        </div>
      </header>
      <main className="px-3 pb-28 pt-6 md:px-6">{children}</main>
      <MobileTabBar token={token} onExportClick={() => setExportOpen(true)} />
      <ExportModalPlaceholder open={exportOpen} onOpenChange={setExportOpen} />
    </>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/a/[token]/page.tsx src/app/a/[token]/_gallery-shell.tsx
git commit -m "feat(m3): public gallery page with hero, justified grid, tab bar"
```

---

## Task 19: Favorites page (`/a/[token]/favorites/page.tsx`)

**Files:**
- Create: `src/app/a/[token]/favorites/page.tsx`
- Create: `src/app/a/[token]/favorites/_shell.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/app/a/[token]/favorites/page.tsx
import { cookies } from 'next/headers';
import { sql } from '@/lib/db';
import { resolveShareLinkStatus, unlockCookieName } from '@/lib/share';
import { resolveViewerId } from '@/lib/viewer';
import { listFavoritePhotoIds } from '@/lib/favorites';
import { getCurrentAdmin } from '@/lib/session';
import { JustifiedGrid, type JustifiedGridPhoto } from '@/components/gallery/JustifiedGrid';
import { FavoritesShell } from './_shell';
import { presignedGetUrl } from '@/lib/minio';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function FavoritesPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const jar = await cookies();
  const unlocked = jar.get(unlockCookieName(token))?.value ?? null;
  const status = await resolveShareLinkStatus(token, unlocked);
  if (status.kind !== 'ok') notFound();
  const link = status.link;
  const admin = await getCurrentAdmin().catch(() => null);
  const viewerId = resolveViewerId({ get: (n) => jar.get(n), set: (n, v, o) => jar.set(n, v, o) } as any, token, { isAdminPreview: admin !== null });

  const favIds = await listFavoritePhotoIds(token, viewerId);
  if (favIds.length === 0) {
    return (
      <>
        <Header title="Favorites" token={token} />
        <main className="px-3 pb-28 pt-6 md:px-6">
          <div className="flex flex-col items-center justify-center py-24 text-center text-white/60">
            <div className="text-lg">No favorites yet</div>
            <div className="mt-1 text-sm">Double-tap photos to heart them.</div>
            <Link href={`/a/${token}`} className="mt-6 cursor-pointer rounded-full bg-rose-500 px-5 py-2 text-sm text-white hover:bg-rose-400">Browse album</Link>
          </div>
        </main>
        <FavoritesShell token={token} count={0} sizeLabel="0 MB" />
      </>
    );
  }

  const rows = await sql<{ id: string; width: number; height: number; orig_bytes: string }[]>`
    SELECT id, width, height, orig_bytes::text FROM photos WHERE id = ANY(${favIds})
  `;
  // preserve favorites ordering
  const ordered = favIds.map(id => rows.find(r => r.id === id)!).filter(Boolean);
  const bytes = ordered.reduce((s, r) => s + Number(r.orig_bytes), 0);

  const photos: JustifiedGridPhoto[] = await Promise.all(
    ordered.map(async p => ({
      id: p.id, width: p.width, height: p.height,
      webUrl: await presignedGetUrl(`albums/${link.album_id}/${p.id}/web.webp`),
    })),
  );

  return (
    <>
      <Header title="Favorites" token={token} />
      <main className="px-3 pb-32 pt-6 md:px-6">
        <JustifiedGrid
          token={token}
          photos={photos}
          favoriteIds={new Set(favIds)}
          hrefForPhoto={(pid) => `/a/${token}/p/${pid}`}
          desktopTargetHeight={170}
          mobileTargetHeight={130}
        />
      </main>
      <FavoritesShell token={token} count={photos.length} sizeLabel={`${(bytes / 1_000_000).toFixed(0)} MB`} />
    </>
  );
}

function Header({ title, token }: { title: string; token: string }) {
  return (
    <header className="flex items-center gap-3 px-4 py-4 md:px-6">
      <Link href={`/a/${token}`} className="cursor-pointer text-white/70 hover:text-white" aria-label="Back to gallery">
        <ChevronLeft className="h-6 w-6" />
      </Link>
      <h1 className="text-xl font-light tracking-wide">{title}</h1>
    </header>
  );
}
```

- [ ] **Step 2: Favorites shell (mounts dock + tabbar + modal)**

```tsx
// src/app/a/[token]/favorites/_shell.tsx
'use client';
import { useState } from 'react';
import { MobileTabBar } from '@/components/gallery/MobileTabBar';
import { GlassDock } from '@/components/gallery/GlassDock';
import { ExportModalPlaceholder } from '@/components/gallery/ExportModalPlaceholder';

export function FavoritesShell({ token, count, sizeLabel }: { token: string; count: number; sizeLabel: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <GlassDock count={count} sizeLabel={sizeLabel} onClick={() => setOpen(true)} />
      <MobileTabBar token={token} onExportClick={() => setOpen(true)} />
      <ExportModalPlaceholder open={open} onOpenChange={setOpen} />
    </>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/a/[token]/favorites/page.tsx src/app/a/[token]/favorites/_shell.tsx
git commit -m "feat(m3): favorites page with sticky glass-dock CTA"
```

---

## Task 20: Lightbox component (skeleton + keyboard nav)

**Files:**
- Create: `src/components/gallery/Lightbox.tsx`
- Create: `src/components/gallery/LightboxChrome.tsx`
- Create: `src/components/gallery/LightboxFilmstrip.tsx`

- [ ] **Step 1: LightboxFilmstrip**

```tsx
// src/components/gallery/LightboxFilmstrip.tsx
'use client';
import Link from 'next/link';
import { cn } from '@/lib/utils';

export interface FilmstripPhoto { id: string; thumbUrl: string }

export function LightboxFilmstrip({ token, photos, currentId }: { token: string; photos: FilmstripPhoto[]; currentId: string }) {
  return (
    <div className="hidden md:flex absolute inset-x-0 bottom-6 justify-center gap-2 px-6">
      {photos.map(p => (
        <Link
          key={p.id}
          href={`/a/${token}/p/${p.id}`}
          className={cn('h-16 w-16 overflow-hidden rounded-md border', p.id === currentId ? 'border-rose-500' : 'border-white/10 opacity-70 hover:opacity-100')}
        >
          <img src={p.thumbUrl} alt="" className="h-full w-full object-cover" />
        </Link>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: LightboxChrome (top action cluster, side arrows, mobile bottom bar)**

```tsx
// src/components/gallery/LightboxChrome.tsx
'use client';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, X, Heart, Download, Share2, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

export function LightboxChrome({ token, photoId, prevId, nextId, liked, onLike, onDownload, allowDownload, visible }: {
  token: string; photoId: string; prevId: string | null; nextId: string | null;
  liked: boolean; onLike: () => void; onDownload: () => void; allowDownload: boolean; visible: boolean;
}) {
  return (
    <div className={cn('pointer-events-none absolute inset-0 transition-opacity', visible ? 'opacity-100' : 'opacity-0')}>
      <div className="pointer-events-auto absolute right-4 top-4 flex items-center gap-1">
        <button className="grid h-11 w-11 cursor-pointer place-items-center rounded-full bg-black/50 text-white hover:bg-black/70" aria-label="Info"><Info className="h-5 w-5" /></button>
        {allowDownload && (
          <button onClick={onDownload} className="grid h-11 w-11 cursor-pointer place-items-center rounded-full bg-black/50 text-white hover:bg-black/70" aria-label="Download"><Download className="h-5 w-5" /></button>
        )}
        <button onClick={onLike} className="grid h-11 w-11 cursor-pointer place-items-center rounded-full bg-black/50 hover:bg-black/70" aria-label={liked ? 'Unlike' : 'Like'} aria-pressed={liked}>
          <Heart className={cn('h-5 w-5', liked ? 'fill-rose-500 stroke-rose-300' : 'stroke-white')} />
        </button>
        <Link href={`/a/${token}`} className="grid h-11 w-11 cursor-pointer place-items-center rounded-full bg-black/50 text-white hover:bg-black/70" aria-label="Close"><X className="h-5 w-5" /></Link>
      </div>
      {prevId && (
        <Link href={`/a/${token}/p/${prevId}`} className="pointer-events-auto absolute left-4 top-1/2 hidden -translate-y-1/2 cursor-pointer rounded-full bg-black/50 p-3 text-white hover:bg-black/70 md:block" aria-label="Previous">
          <ChevronLeft className="h-6 w-6" />
        </Link>
      )}
      {nextId && (
        <Link href={`/a/${token}/p/${nextId}`} className="pointer-events-auto absolute right-4 top-1/2 hidden -translate-y-1/2 cursor-pointer rounded-full bg-black/50 p-3 text-white hover:bg-black/70 md:block" aria-label="Next">
          <ChevronRight className="h-6 w-6" />
        </Link>
      )}
      <div className="pointer-events-auto absolute inset-x-0 bottom-0 flex items-center justify-around bg-black/60 px-4 py-3 backdrop-blur md:hidden">
        <button onClick={onLike} className="flex h-11 cursor-pointer flex-col items-center gap-0.5 text-white" aria-label="Like"><Heart className={cn('h-5 w-5', liked && 'fill-rose-500 stroke-rose-300')} /><span className="text-[10px]">Like</span></button>
        {allowDownload && <button onClick={onDownload} className="flex h-11 cursor-pointer flex-col items-center gap-0.5 text-white" aria-label="Save"><Download className="h-5 w-5" /><span className="text-[10px]">Save</span></button>}
        <button className="flex h-11 cursor-pointer flex-col items-center gap-0.5 text-white" aria-label="Share"><Share2 className="h-5 w-5" /><span className="text-[10px]">Share</span></button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Lightbox**

```tsx
// src/components/gallery/Lightbox.tsx
'use client';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useGesture } from '@use-gesture/react';
import { toggleFavorite } from '@/app/a/[token]/_actions';
import { LightboxChrome } from './LightboxChrome';
import { LightboxFilmstrip, type FilmstripPhoto } from './LightboxFilmstrip';
import { HeartBurst } from './HeartBurst';

export interface LightboxProps {
  token: string;
  photoId: string;
  largeUrl: string;
  prev: { id: string; largeUrl: string } | null;
  next: { id: string; largeUrl: string } | null;
  filmstrip: FilmstripPhoto[];
  initialLiked: boolean;
  allowDownload: boolean;
  downloadUrl: string | null;
}

export function Lightbox(props: LightboxProps) {
  const { token, photoId, largeUrl, prev, next, filmstrip, initialLiked, allowDownload, downloadUrl } = props;
  const router = useRouter();
  const [liked, setLiked] = useState(initialLiked);
  const [burstId, setBurstId] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tapTimeRef = useRef(0);

  const fireLike = () => {
    setLiked(p => !p);
    setBurstId(b => b + 1);
    startTransition(() => { toggleFavorite(token, photoId); });
  };

  const navigatePrev = () => { if (prev) router.push(`/a/${token}/p/${prev.id}`); };
  const navigateNext = () => { if (next) router.push(`/a/${token}/p/${next.id}`); };
  const close = () => { router.push(`/a/${token}`); };
  const download = () => {
    if (!downloadUrl) return;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = '';
    a.click();
  };
  const onlyFavorites = () => router.push(`/a/${token}/favorites`);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') navigatePrev();
      else if (e.key === 'ArrowRight') navigateNext();
      else if (e.key === 'l' || e.key === 'L') fireLike();
      else if (e.key === 'd' || e.key === 'D') download();
      else if (e.key === 'f' || e.key === 'F') onlyFavorites();
      else if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prev?.id, next?.id, liked, photoId]);

  // Mobile gestures
  useGesture(
    {
      onDrag: ({ swipe: [sx, sy], cancel }) => {
        if (sx === -1) { navigateNext(); cancel(); }
        else if (sx === 1) { navigatePrev(); cancel(); }
        else if (sy === 1) { close(); cancel(); }
      },
    },
    { target: containerRef, drag: { swipe: { distance: 50, velocity: 0.3 } } },
  );

  const handleTap = () => {
    const now = Date.now();
    if (now - tapTimeRef.current < 300) {
      fireLike();
      tapTimeRef.current = 0;
    } else {
      tapTimeRef.current = now;
      setTimeout(() => {
        if (tapTimeRef.current === now) {
          setChromeVisible(v => !v);
          tapTimeRef.current = 0;
        }
      }, 320);
    }
  };

  return (
    <div ref={containerRef} className="fixed inset-0 z-50 bg-black" style={{ touchAction: 'pinch-zoom' }} onClick={handleTap}>
      {prev && <link rel="preload" as="image" href={prev.largeUrl} />}
      {next && <link rel="preload" as="image" href={next.largeUrl} />}
      <img src={largeUrl} alt="" className="absolute inset-0 m-auto max-h-full max-w-full select-none" draggable={false} />
      <HeartBurst trigger={burstId} />
      <LightboxChrome
        token={token}
        photoId={photoId}
        prevId={prev?.id ?? null}
        nextId={next?.id ?? null}
        liked={liked}
        onLike={fireLike}
        onDownload={download}
        allowDownload={allowDownload}
        visible={chromeVisible}
      />
      <LightboxFilmstrip token={token} photos={filmstrip} currentId={photoId} />
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/gallery/Lightbox.tsx src/components/gallery/LightboxChrome.tsx src/components/gallery/LightboxFilmstrip.tsx
git commit -m "feat(m3): lightbox with keyboard + gesture nav, double-tap like, filmstrip"
```

---

## Task 21: Lightbox route (`/a/[token]/p/[photoId]/page.tsx`)

**Files:**
- Create: `src/app/a/[token]/p/[photoId]/page.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/app/a/[token]/p/[photoId]/page.tsx
import { cookies } from 'next/headers';
import { sql } from '@/lib/db';
import { resolveShareLinkStatus, unlockCookieName } from '@/lib/share';
import { resolveViewerId } from '@/lib/viewer';
import { listFavoritePhotoIds } from '@/lib/favorites';
import { logViewEvent } from '@/lib/view-events';
import { getCurrentAdmin } from '@/lib/session';
import { presignedGetUrl } from '@/lib/minio';
import { Lightbox } from '@/components/gallery/Lightbox';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function LightboxRoute({ params }: { params: Promise<{ token: string; photoId: string }> }) {
  const { token, photoId } = await params;
  const jar = await cookies();
  const unlocked = jar.get(unlockCookieName(token))?.value ?? null;
  const status = await resolveShareLinkStatus(token, unlocked);
  if (status.kind !== 'ok') notFound();
  const link = status.link;
  const admin = await getCurrentAdmin().catch(() => null);
  const viewerId = resolveViewerId({ get: (n) => jar.get(n), set: (n, v, o) => jar.set(n, v, o) } as any, token, { isAdminPreview: admin !== null });

  const photoRows = await sql<{ id: string; sort_order: number }[]>`
    SELECT id, sort_order FROM photos
    WHERE album_id = ${link.album_id} AND status = 'ready'
    ORDER BY sort_order ASC, created_at ASC
  `;
  const idx = photoRows.findIndex(p => p.id === photoId);
  if (idx === -1) notFound();
  const prevId = idx > 0 ? photoRows[idx - 1].id : null;
  const nextId = idx < photoRows.length - 1 ? photoRows[idx + 1].id : null;

  const [largeUrl, prevLargeUrl, nextLargeUrl, favIds] = await Promise.all([
    presignedGetUrl(`albums/${link.album_id}/${photoId}/large.webp`),
    prevId ? presignedGetUrl(`albums/${link.album_id}/${prevId}/large.webp`) : Promise.resolve(null),
    nextId ? presignedGetUrl(`albums/${link.album_id}/${nextId}/large.webp`) : Promise.resolve(null),
    listFavoritePhotoIds(token, viewerId),
  ]);

  // filmstrip: 6 neighbors centered on current
  const start = Math.max(0, idx - 3);
  const end = Math.min(photoRows.length, start + 6);
  const filmstripRows = photoRows.slice(start, end);
  const filmstrip = await Promise.all(
    filmstripRows.map(async p => ({
      id: p.id,
      thumbUrl: await presignedGetUrl(`albums/${link.album_id}/${p.id}/thumb.webp`),
    })),
  );

  const downloadUrl = link.allow_download
    ? await presignedGetUrl(`albums/${link.album_id}/${photoId}/original.jpg`)
    : null;

  await logViewEvent(token, viewerId, 'photo_view', photoId);

  return (
    <Lightbox
      token={token}
      photoId={photoId}
      largeUrl={largeUrl}
      prev={prevId && prevLargeUrl ? { id: prevId, largeUrl: prevLargeUrl } : null}
      next={nextId && nextLargeUrl ? { id: nextId, largeUrl: nextLargeUrl } : null}
      filmstrip={filmstrip}
      initialLiked={favIds.includes(photoId)}
      allowDownload={link.allow_download}
      downloadUrl={downloadUrl}
    />
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/a/[token]/p/[photoId]/page.tsx
git commit -m "feat(m3): routed lightbox page with prev/next + filmstrip"
```

---

## Task 22: Admin Client Selections page

**Files:**
- Create: `src/app/admin/selections/page.tsx`
- Modify: `src/app/admin/layout.tsx`

- [ ] **Step 1: Add sidebar entry**

In `src/app/admin/layout.tsx`, in the "Insights" group sidebar list, add:

```tsx
<SidebarLink href="/admin/selections" icon={<Heart className="h-4 w-4" />} label="Client Selections" />
```

(import `Heart` from `lucide-react` if not already imported.)

- [ ] **Step 2: Implement the selections page**

```tsx
// src/app/admin/selections/page.tsx
import Link from 'next/link';
import { sql } from '@/lib/db';
import { requireAdmin } from '@/lib/session';

interface SelectionRow {
  share_token: string;
  album_id: string;
  album_title: string;
  album_slug: string;
  viewer_id: string;
  photo_count: string;
  last_at: Date;
}

export const dynamic = 'force-dynamic';

export default async function SelectionsPage() {
  await requireAdmin();
  const rows = await sql<SelectionRow[]>`
    SELECT
      f.share_token,
      a.id AS album_id,
      a.title AS album_title,
      a.slug AS album_slug,
      f.viewer_id,
      COUNT(*)::text AS photo_count,
      MAX(f.created_at) AS last_at
    FROM favorites f
    JOIN share_links sl ON sl.token = f.share_token
    JOIN albums a ON a.id = sl.album_id
    GROUP BY f.share_token, a.id, a.title, a.slug, f.viewer_id
    ORDER BY MAX(f.created_at) DESC
    LIMIT 50
  `;
  return (
    <div className="p-6">
      <h1 className="text-2xl font-light text-white">Client Selections</h1>
      <p className="mt-1 text-sm text-white/60">Recent favorite events grouped by viewer.</p>
      <div className="mt-6 overflow-hidden rounded-xl border border-white/10">
        <table className="w-full text-sm">
          <thead className="bg-white/5 text-white/60">
            <tr>
              <th className="px-4 py-3 text-left">Album</th>
              <th className="px-4 py-3 text-left">Viewer</th>
              <th className="px-4 py-3 text-left">Photos hearted</th>
              <th className="px-4 py-3 text-left">Last activity</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="text-white/90">
            {rows.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-12 text-center text-white/40">No client selections yet.</td></tr>
            ) : rows.map(r => (
              <tr key={`${r.share_token}-${r.viewer_id}`} className="border-t border-white/5">
                <td className="px-4 py-3">{r.album_title}</td>
                <td className="px-4 py-3 font-mono text-xs">{r.viewer_id.slice(0, 8)}…</td>
                <td className="px-4 py-3 text-rose-300">{r.photo_count}</td>
                <td className="px-4 py-3 text-white/60">{new Date(r.last_at).toLocaleString()}</td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/admin/selections/${r.album_slug}?viewer=${r.viewer_id}`}
                    className="cursor-pointer rounded-md bg-white/5 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
                  >
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Implement the admin album preview with hearts overlay**

```tsx
// src/app/admin/selections/[albumSlug]/page.tsx
import { sql } from '@/lib/db';
import { requireAdmin } from '@/lib/session';
import { notFound } from 'next/navigation';
import { presignedGetUrl } from '@/lib/minio';
import { Heart } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function SelectionsAlbumPage({
  params,
  searchParams,
}: {
  params: Promise<{ albumSlug: string }>;
  searchParams: Promise<{ viewer?: string }>;
}) {
  await requireAdmin();
  const { albumSlug } = await params;
  const { viewer } = await searchParams;
  if (!viewer) notFound();

  const albumRows = await sql<{ id: string; title: string }[]>`
    SELECT id, title FROM albums WHERE slug = ${albumSlug} LIMIT 1
  `;
  const album = albumRows[0];
  if (!album) notFound();

  const tokenRow = await sql<{ token: string }[]>`
    SELECT token FROM share_links WHERE album_id = ${album.id} LIMIT 1
  `;
  const photoRows = await sql<{ id: string }[]>`
    SELECT id FROM photos WHERE album_id = ${album.id} AND status = 'ready'
    ORDER BY sort_order ASC, created_at ASC
  `;
  const favoriteRows = tokenRow[0] ? await sql<{ photo_id: string }[]>`
    SELECT photo_id FROM favorites WHERE share_token = ${tokenRow[0].token} AND viewer_id = ${viewer}
  ` : [];
  const liked = new Set(favoriteRows.map(r => r.photo_id));

  const tiles = await Promise.all(photoRows.map(async p => ({
    id: p.id,
    thumbUrl: await presignedGetUrl(`albums/${album.id}/${p.id}/thumb.webp`),
    liked: liked.has(p.id),
  })));

  return (
    <div className="p-6">
      <h1 className="text-2xl font-light text-white">{album.title}</h1>
      <p className="mt-1 text-sm text-white/60">Viewer <span className="font-mono">{viewer.slice(0, 8)}…</span> — {liked.size} of {tiles.length} hearted.</p>
      <div className="mt-6 grid grid-cols-3 gap-2 md:grid-cols-6">
        {tiles.map(t => (
          <div key={t.id} className="relative aspect-square overflow-hidden rounded-md">
            <img src={t.thumbUrl} alt="" className="h-full w-full object-cover" />
            {t.liked && (
              <span className="absolute right-1.5 top-1.5 grid h-8 w-8 place-items-center rounded-full bg-rose-500/90 text-white">
                <Heart className="h-4 w-4 fill-white" />
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/admin/selections/page.tsx src/app/admin/selections/[albumSlug]/page.tsx src/app/admin/layout.tsx
git commit -m "feat(m3): admin Client Selections list + album preview with hearts overlay"
```

---

## Task 23: Next.js image remotePatterns for MinIO

**Files:**
- Modify: `next.config.mjs`

- [ ] **Step 1: Add remote pattern**

Edit `next.config.mjs`:

```js
images: {
  remotePatterns: [
    {
      protocol: process.env.MINIO_ENDPOINT?.startsWith('https') ? 'https' : 'http',
      hostname: new URL(process.env.MINIO_ENDPOINT ?? 'http://localhost:9000').hostname,
      port: new URL(process.env.MINIO_ENDPOINT ?? 'http://localhost:9000').port || undefined,
      pathname: '/**',
    },
  ],
},
```

- [ ] **Step 2: Commit**

```bash
git add next.config.mjs
git commit -m "chore(m3): allow MinIO host in next/image"
```

---

## Task 24: E2E seed script

**Files:**
- Create: `tests/e2e/fixtures/seed.ts`

- [ ] **Step 1: Implement**

```ts
// tests/e2e/fixtures/seed.ts
/**
 * Seeds the running dev stack with:
 * - 1 admin user
 * - 1 album with 6 photos (downloads sample assets to MinIO via presigned PUT? — simpler: copy local sample files to MinIO using AWS SDK directly)
 * - 1 share link without password, no expiry
 *
 * Usage: GH_E2E=1 tsx tests/e2e/fixtures/seed.ts
 * Outputs: TOKEN=<token> on stdout (read by Playwright via dotenv or fs).
 */
import { sql } from '../../../src/lib/db';
import argon2 from 'argon2';
import { randomUUID, randomBytes } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const ADMIN_EMAIL = 'e2e-admin@test.local';
const ADMIN_PASSWORD = 'e2epassword';

async function main() {
  // 1. Reset relevant tables
  await sql`DELETE FROM favorites`;
  await sql`DELETE FROM view_events`;
  await sql`DELETE FROM share_links`;
  await sql`DELETE FROM photos`;
  await sql`DELETE FROM albums`;
  await sql`DELETE FROM admin_users`;

  // 2. Admin
  const adminId = randomUUID();
  await sql`
    INSERT INTO admin_users (id, email, password_hash)
    VALUES (${adminId}, ${ADMIN_EMAIL}, ${await argon2.hash(ADMIN_PASSWORD)})
  `;

  // 3. Album
  const albumId = randomUUID();
  await sql`
    INSERT INTO albums (id, slug, title, subtitle, status)
    VALUES (${albumId}, 'e2e-demo', 'E2E Demo Album', 'Playwright fixture', 'published')
  `;

  // 4. S3 client
  const s3 = new S3Client({
    endpoint: process.env.MINIO_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.MINIO_ACCESS_KEY!, secretAccessKey: process.env.MINIO_SECRET_KEY! },
  });
  const bucket = process.env.MINIO_BUCKET ?? 'gallery';

  // 5. 6 generated test photos (solid colors via sharp)
  const colors: [number, number, number][] = [[200,80,100],[80,160,200],[180,200,80],[120,80,200],[200,160,80],[80,200,160]];
  const photoIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const id = randomUUID();
    photoIds.push(id);
    const width = 1600;
    const height = i % 2 === 0 ? 1066 : 2000; // mix landscape/portrait
    const png = await sharp({ create: { width, height, channels: 3, background: { r: colors[i][0], g: colors[i][1], b: colors[i][2] } } }).jpeg({ quality: 80 }).toBuffer();
    const web = await sharp(png).resize(1600).webp().toBuffer();
    const large = await sharp(png).resize(2400).webp().toBuffer();
    const thumb = await sharp(png).resize(400).webp().toBuffer();

    for (const [name, body, contentType] of [
      ['original.jpg', png, 'image/jpeg'],
      ['web.webp', web, 'image/webp'],
      ['large.webp', large, 'image/webp'],
      ['thumb.webp', thumb, 'image/webp'],
    ] as const) {
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: `albums/${albumId}/${id}/${name}`, Body: body, ContentType: contentType,
      }));
    }

    await sql`
      INSERT INTO photos (id, album_id, filename, width, height, orig_bytes, sort_order, status)
      VALUES (${id}, ${albumId}, ${`photo-${i}.jpg`}, ${width}, ${height}, ${png.length}, ${i}, 'ready')
    `;
  }
  await sql`UPDATE albums SET cover_photo_id = ${photoIds[0]} WHERE id = ${albumId}`;

  // 6. Share link
  const token = randomBytes(9).toString('base64url').slice(0, 12);
  await sql`
    INSERT INTO share_links (token, album_id, allow_download)
    VALUES (${token}, ${albumId}, true)
  `;

  // 7. Emit token to file for Playwright
  writeFileSync(join(process.cwd(), 'tests/e2e/.fixture.json'), JSON.stringify({ token, albumId, photoIds, adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASSWORD }, null, 2));
  // eslint-disable-next-line no-console
  console.log('SEED_OK token=' + token);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Document preconditions**

Add a comment block at the top:

```
# Preconditions for E2E:
# 1. `docker compose up -d gallery-postgres gallery-minio` running
# 2. Migrations applied: `npm run migrate`
# 3. `npm run dev` running on port 3000
# 4. `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET`, `MINIO_ENDPOINT`, `DATABASE_URL`, `SESSION_PASSWORD` set
# 5. `npm run test:e2e:seed` produces tests/e2e/.fixture.json
```

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/fixtures/seed.ts
git commit -m "test(m3): e2e seed script with admin + album + 6 photos + share link"
```

---

## Task 25: E2E test — share flow + favorites persistence

**Files:**
- Create: `tests/e2e/share-flow.spec.ts`

- [ ] **Step 1: Implement**

```ts
// tests/e2e/share-flow.spec.ts
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixture = JSON.parse(readFileSync(join(process.cwd(), 'tests/e2e/.fixture.json'), 'utf-8'));
const TOKEN = fixture.token as string;

test('open share link, like 3 photos, reload, hearts persist', async ({ page, context }) => {
  await context.clearCookies();
  await page.goto(`/a/${TOKEN}`);
  await expect(page.getByRole('heading', { name: 'E2E Demo Album' })).toBeVisible();

  // double-click 3 photo links
  const links = page.locator(`a[href^="/a/${TOKEN}/p/"]`);
  await expect(links.first()).toBeVisible();
  const count = Math.min(3, await links.count());
  for (let i = 0; i < count; i++) {
    await links.nth(i).dblclick();
    // a small delay to let optimistic UI flush
    await page.waitForTimeout(250);
  }

  // verify hearts are filled (aria-pressed=true on overlay buttons)
  const liked = page.locator('button[aria-pressed="true"]');
  await expect(liked).toHaveCount(count);

  await page.reload();
  await expect(page.locator('button[aria-pressed="true"]')).toHaveCount(count);
});

test('admin preview does not write viewer cookie', async ({ page, context }) => {
  // login as admin
  await page.goto('/admin/login');
  await page.getByLabel(/email/i).fill(fixture.adminEmail);
  await page.getByLabel(/password/i).fill(fixture.adminPassword);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page).toHaveURL(/\/admin/);

  // visit the public share — but should not get a gh_viewer cookie
  await page.goto(`/a/${TOKEN}`);
  const cookies = await context.cookies();
  expect(cookies.find(c => c.name === 'gh_viewer')).toBeUndefined();
});
```

- [ ] **Step 2: Run**

Run (after seeding): `npm run test:e2e -- share-flow.spec.ts --project=chromium-desktop`
Expected: 2 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/share-flow.spec.ts
git commit -m "test(m3): e2e — share flow + hearts persistence + admin preview cookie"
```

---

## Task 26: E2E test — lightbox

**Files:**
- Create: `tests/e2e/lightbox.spec.ts`

- [ ] **Step 1: Implement**

```ts
// tests/e2e/lightbox.spec.ts
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixture = JSON.parse(readFileSync(join(process.cwd(), 'tests/e2e/.fixture.json'), 'utf-8'));
const TOKEN = fixture.token as string;
const PHOTO0 = fixture.photoIds[0] as string;

test('open lightbox, arrow nav, close with Esc', async ({ page }) => {
  await page.goto(`/a/${TOKEN}/p/${PHOTO0}`);
  await expect(page.locator('img').first()).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.waitForURL(/\/p\//);
  expect(page.url()).not.toContain(PHOTO0);
  await page.keyboard.press('Escape');
  await page.waitForURL(`**/a/${TOKEN}`);
});

test('keyboard L toggles like', async ({ page }) => {
  await page.goto(`/a/${TOKEN}/p/${PHOTO0}`);
  await page.locator('button[aria-label="Like"], button[aria-label="Unlike"]').first().waitFor();
  const before = await page.locator('button[aria-pressed]').first().getAttribute('aria-pressed');
  await page.keyboard.press('l');
  await page.waitForTimeout(300);
  const after = await page.locator('button[aria-pressed]').first().getAttribute('aria-pressed');
  expect(before).not.toBe(after);
});

test('mobile swipe-down closes lightbox', async ({ browser }) => {
  const context = await browser.newContext({ ...{ viewport: { width: 375, height: 800 }, hasTouch: true, isMobile: true } });
  const page = await context.newPage();
  await page.goto(`/a/${TOKEN}/p/${PHOTO0}`);
  await page.locator('img').first().waitFor();
  // synthesize a swipe-down gesture
  const box = await page.locator('img').first().boundingBox();
  if (!box) throw new Error('no box');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + 50);
  // Playwright's touchscreen lacks a multi-step gesture API; emulate via dispatch
  await page.evaluate(() => {
    const el = document.body;
    const t = (type: string, y: number) => {
      const ev = new TouchEvent(type, { bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientX: 187, clientY: y })] as any,
      });
      el.dispatchEvent(ev);
    };
    t('touchstart', 100);
    t('touchmove', 600);
    t('touchend', 600);
  });
  await page.waitForURL(`**/a/${TOKEN}`, { timeout: 2000 }).catch(() => {});
  expect(page.url().endsWith(`/a/${TOKEN}`)).toBeTruthy();
  await context.close();
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/lightbox.spec.ts
git commit -m "test(m3): e2e — lightbox keyboard + swipe-down + like toggle"
```

---

## Task 27: E2E test — favorites tab

**Files:**
- Create: `tests/e2e/favorites.spec.ts`

- [ ] **Step 1: Implement**

```ts
// tests/e2e/favorites.spec.ts
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixture = JSON.parse(readFileSync(join(process.cwd(), 'tests/e2e/.fixture.json'), 'utf-8'));
const TOKEN = fixture.token as string;

test('favorites tab shows only liked photos', async ({ page, context }) => {
  await context.clearCookies();
  await page.goto(`/a/${TOKEN}`);
  const links = page.locator(`a[href^="/a/${TOKEN}/p/"]`);
  await links.first().waitFor();
  // like first 2
  await links.nth(0).dblclick();
  await page.waitForTimeout(250);
  await links.nth(1).dblclick();
  await page.waitForTimeout(250);

  await page.goto(`/a/${TOKEN}/favorites`);
  const favLinks = page.locator(`a[href^="/a/${TOKEN}/p/"]`);
  await expect(favLinks).toHaveCount(2);
});

test('empty favorites view shows browse CTA', async ({ page, context }) => {
  await context.clearCookies();
  await page.goto(`/a/${TOKEN}/favorites`);
  await expect(page.getByText(/no favorites yet/i)).toBeVisible();
  await expect(page.getByRole('link', { name: /browse album/i })).toBeVisible();
});

test('glass dock visible only when favorites > 0 (desktop)', async ({ page, context }) => {
  await context.clearCookies();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/a/${TOKEN}/favorites`);
  await expect(page.getByRole('button', { name: /export favorites/i })).toHaveCount(0);

  await page.goto(`/a/${TOKEN}`);
  const links = page.locator(`a[href^="/a/${TOKEN}/p/"]`);
  await links.first().dblclick();
  await page.waitForTimeout(250);

  await page.goto(`/a/${TOKEN}/favorites`);
  await expect(page.getByRole('button', { name: /export favorites/i })).toBeVisible();
});
```

- [ ] **Step 2: Run all e2e**

Run: `npm run test:e2e`
Expected: 3 favorites + 3 lightbox + 2 share-flow = 8 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/favorites.spec.ts
git commit -m "test(m3): e2e — favorites tab, empty state, glass dock visibility"
```

---

## Task 28: Final smoke-test + acceptance review

**Files:**
- N/A

- [ ] **Step 1: Run full test suite**

Run:
```
GH_TEST_BYPASS_AUTH=1 npx vitest run
npm run test:e2e:seed
npm run test:e2e
```
Expected: All vitest + Playwright tests PASS.

- [ ] **Step 2: Manual checklist (verify against spec §7)**

- [ ] Admin can generate a share link with optional password and expiry (Tasks 8-9)
- [ ] Admin can copy URL + download QR code (Task 8)
- [ ] Public visitor sees dark-cinematic justified grid with hero header (Task 18)
- [ ] Public visitor double-clicks/taps to favorite. Hearts persist across reload (Tasks 16, 25)
- [ ] Public visitor opens lightbox, navigates arrows/swipe, double-clicks/taps, closes Esc/swipe-down (Tasks 20-21, 26)
- [ ] Public visitor switches to Favorites tab — only hearted photos shown (Task 19, 27)
- [ ] Admin views all favorited photos by viewer grouped per share link (Task 22)
- [ ] Mobile 375px width — no horizontal scroll (Task 19's responsive layout; Task 26 mobile project)
- [ ] Lightbox preloads neighbors (Task 20: `<link rel="preload">`)
- [ ] All admin pages have cursor-pointer + focus states + 4.5:1 contrast (Tasks 8, 22)

- [ ] **Step 3: Commit any docstrings/fixes from manual review**

```bash
git add -A
git commit -m "chore(m3): post-acceptance polish"
```

---

## Out-of-scope reminders (handled in M4)

- ZIP export real implementation (`/api/export/{token}` + archiver streaming).
- `/api/widget/summary` endpoint for personal-hub integration.
- Personal-hub side widget component.
- `download` view_event type logging (lightbox's download button currently triggers a presigned URL fetch but does not write the `download` event; this is fine — the spec scopes that to M4).

---

## Self-review notes

**Spec §7 coverage:** All M3-relevant acceptance items map to specific tasks above (admin login/album CRUD/upload/cover/reorder are M1/M2). ZIP export and widget endpoint are deferred to M4 per the milestone scope.

**Placeholders:** none — `layoutJustifiedRows`, `createDoubleTapDetector`, `resolveViewerId`, `toggleFavorite`, `unlockShareLink`, `Lightbox`, `JustifiedGrid`, and `PhotoCard` all include full bodies.

**Type consistency:** `toggleFavorite(token: string, photoId: string)` returns `{ liked: boolean }` server-side (Task 13) but is called from `PhotoCard.tsx` and `Lightbox.tsx` (Tasks 16, 20) with the same signature; both consume only fire-and-forget within a `startTransition`, so the boolean return is intentionally unused — optimistic UI is the source of truth and revalidation refreshes server data. `toggleFavoriteForViewer` (data-layer, Task 5) returns `{ state: 'added' | 'removed' }`; the action layer adapts it to `{ liked }`. No name drift.

**Mobile/desktop parity:** like (desktop double-click in PhotoCard + Lightbox; mobile double-tap via same handler), navigate (desktop arrows + filmstrip; mobile swipe), close (desktop Esc/close button; mobile swipe-down/close button), download (desktop top cluster; mobile bottom bar) — each has both variants covered.
