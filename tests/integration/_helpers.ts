import { sql } from '@/lib/db';
import { generateShareToken } from '@/lib/share';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../scripts/migrate';
import { ensureTestAdminUser, TEST_ADMIN_USER_ID } from '@/lib/test-admin';

export async function setupTestDb(): Promise<void> {
  process.env.SESSION_PASSWORD ??= 'test-secret-test-secret-test-secret-1';
  await runMigrations({ databaseUrl: process.env.DATABASE_URL!, silent: true });
  // Migration 021 added albums.owner_user_id NOT NULL. Tests that bypass
  // auth still need a real admin_users row for the FK. resetTestDb does
  // NOT truncate admin_users so this insert survives across tests.
  await ensureTestAdminUser();
}

export async function teardownTestDb(): Promise<void> {
  // no-op; testcontainers handles container teardown in vitest.setup.ts
}

export async function resetTestDb(): Promise<void> {
  // Clear gallery tables (don't touch pgboss_gallery; the worker has its own lifecycle).
  await sql`TRUNCATE TABLE view_events, favorites, share_links, photos, albums RESTART IDENTITY CASCADE`;
  // notification_log is wiped too so dedup-key tests start clean.
  // notification_rules are NOT truncated — the migration seeds defaults, and
  // tests that mutate them should put them back in their afterEach.
  await sql`TRUNCATE TABLE notification_log RESTART IDENTITY`;
}

export async function seedAlbumWithPhotos(opts: {
  count: number;
  withPassword?: string | null;
  expiresAt?: Date | null;
  allowDownload?: boolean;
}): Promise<{ albumId: string; token: string; photoIds: string[] }> {
  const albumId = randomUUID();
  await sql`
    INSERT INTO albums (id, slug, title, status, owner_user_id)
    VALUES (${albumId}, ${'a-' + albumId.slice(0, 8)}, 'Test Album', 'published', ${TEST_ADMIN_USER_ID})
  `;
  const photoIds: string[] = [];
  for (let i = 0; i < opts.count; i++) {
    const id = randomUUID();
    photoIds.push(id);
    await sql`
      INSERT INTO photos (id, album_id, filename, width, height, orig_bytes, sort_order, status)
      VALUES (${id}, ${albumId}, ${`p${i}.jpg`}, 1600, 1066, 2000000, ${i}, 'ready')
    `;
  }
  const token = generateShareToken();
  await sql`
    INSERT INTO share_links (token, album_id, password_hash, expires_at, allow_download)
    VALUES (${token}, ${albumId}, ${opts.withPassword ?? null}, ${opts.expiresAt ?? null}, ${opts.allowDownload ?? true})
  `;
  return { albumId, token, photoIds };
}
