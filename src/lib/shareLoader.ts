import { unstable_cache, revalidateTag } from "next/cache";
import { resolveShareLinkStatus } from "@/lib/share";
import { getAlbumById, listPhotos, getAlbumWatermark } from "@/lib/albums";
import { computeStaticExportSizes } from "@/lib/exportSizes";
import type { AlbumRow, PhotoRow } from "@/lib/types";
import type { ExportSizes } from "@/lib/exportSizes";

export function shareCacheTag(token: string): string {
  return `share:${token}`;
}

/**
 * Bust the cached share-page render for one token. Admin actions that
 * change album content (cover swap, watermark toggle, photo add/delete,
 * share link revoke) call this so viewers don't wait up to 60 s for the
 * change to surface.
 */
export function revalidateShareLink(token: string): void {
  revalidateTag(shareCacheTag(token));
}

export type ShareData =
  | { kind: "ok"; album: AlbumRow; photos: PhotoRow[]; watermarkEnabled: boolean; staticSizes: ExportSizes }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "locked" };

async function loadShareDataUncached(token: string): Promise<ShareData> {
  const status = await resolveShareLinkStatus(token, null);
  if (status.kind !== "ok") return { kind: status.kind };
  const albumId = status.link.album_id;
  const [album, allPhotos, watermark, staticSizes] = await Promise.all([
    getAlbumById(albumId),
    listPhotos(albumId),
    getAlbumWatermark(albumId),
    computeStaticExportSizes(albumId),
  ]);
  if (!album) return { kind: "not_found" };
  return {
    kind: "ok",
    album,
    photos: allPhotos.filter((p) => p.status === "ready"),
    watermarkEnabled: watermark.enabled,
    staticSizes,
  };
}

/**
 * Per-token cached loader. Wrapping in `unstable_cache` is what actually
 * applies the route-level `revalidate = 60` — postgres.js `sql\`\`` is not
 * Next's `fetch`, so without this wrapper Next falls back to "fully
 * dynamic" and re-runs every query on every request.
 *
 * Each token gets its own tag (`share:<token>`) so `revalidateShareLink`
 * busts exactly that token's cache. The factory is memoised per process
 * to avoid re-wrapping on every page render.
 */
const cachedByToken = new Map<string, () => Promise<ShareData>>();

export function loadShareData(token: string): Promise<ShareData> {
  let fn = cachedByToken.get(token);
  if (!fn) {
    fn = unstable_cache(
      () => loadShareDataUncached(token),
      ["share-data-v1", token],
      { revalidate: 60, tags: [shareCacheTag(token), "share-page"] },
    );
    cachedByToken.set(token, fn);
  }
  return fn();
}
