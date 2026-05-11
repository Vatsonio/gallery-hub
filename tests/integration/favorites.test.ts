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
