"use server";

import { cookies } from "next/headers";
import {
  resolveShareLinkStatus,
  unlockCookieName,
  signUnlockValue,
  loadShareLink,
  UNLOCK_TTL_SECONDS,
} from "@/lib/share";
import { verifyPassword } from "@/lib/passwords";
import { toggleFavoriteForViewer } from "@/lib/favorites";
import { ADMIN_PREVIEW_VIEWER_ID, VIEWER_COOKIE } from "@/lib/viewer";
import { requireAdminSessionFromCookies } from "@/lib/session";
import { safeCapture } from "@/lib/analytics";
import { notifyFavoritesBurst } from "@/lib/notifications";
import { sql } from "@/lib/db";
import { getAlbumById } from "@/lib/albums";
import { randomUUID } from "node:crypto";

export interface ToggleFavoriteResult {
  favorited: boolean;
}

export interface UnlockResult {
  ok: boolean;
  error?: string;
}

async function isAdminPreview(): Promise<boolean> {
  const r = await requireAdminSessionFromCookies().catch(() => ({
    ok: false as const,
  }));
  return r.ok;
}

/**
 * Toggle a favorite for the current viewer. Cookie is created lazily
 * if absent. Returns the *new* favorited state for the client to
 * commit its optimistic UI against (or roll back on error).
 *
 * We deliberately do NOT revalidatePath here — the page snapshot does
 * not need to be refetched server-side just to flip a heart icon. The
 * client toggles optimistically and trusts the boolean we return.
 */
export async function toggleFavorite(
  token: string,
  photoId: string,
): Promise<ToggleFavoriteResult> {
  const jar = await cookies();
  const unlocked = jar.get(unlockCookieName(token))?.value ?? null;
  const status = await resolveShareLinkStatus(token, unlocked);
  if (status.kind !== "ok") {
    throw new Error(`share link not accessible: ${status.kind}`);
  }

  const adminPreview = await isAdminPreview();
  if (adminPreview) {
    // Admin preview: never persist viewer state. Return current persisted
    // favourited state for the admin-preview viewer if any (it stays empty
    // because we don't write).
    return { favorited: false };
  }

  // Inline cookie issuance (resolveViewerId helper uses a sync jar shape
  // that doesn't line up cleanly with the next/headers cookie store
  // typing, so we replicate its logic explicitly here). Cookie path is
  // "/" so the same UUID is sent to /api/export/{token} — otherwise the
  // export route would mint a replacement and orphan the viewer's
  // favorites.
  let viewerId = jar.get(VIEWER_COOKIE)?.value ?? null;
  if (!viewerId) {
    viewerId = randomUUID();
    jar.set(VIEWER_COOKIE, viewerId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  if (viewerId === ADMIN_PREVIEW_VIEWER_ID) {
    return { favorited: false };
  }

  const res = await toggleFavoriteForViewer(token, photoId, viewerId);
  safeCapture({
    distinctId: viewerId,
    event: res.state === "added" ? "favorite_added" : "favorite_removed",
    properties: {
      share_token: token,
      album_id: status.link.album_id,
      photo_id: photoId,
    },
  });

  // Notify on a burst of likes. Threshold logic lives in
  // notifyFavoritesBurst — it queries the rule row + the rolling-hour
  // count itself. We only run when the toggle ADDED (not on remove)
  // and dedup_key collapses repeats inside the hour bucket.
  if (res.state === "added") {
    const album = await getAlbumById(status.link.album_id).catch(() => null);
    if (album) {
      const countRows = await sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n
          FROM favorites
         WHERE share_token = ${token}
           AND viewer_id = ${viewerId}
           AND created_at > NOW() - INTERVAL '1 hour'
      `.catch(() => [{ n: "0" }] as { n: string }[]);
      const count = Number(countRows[0]?.n ?? "0");
      void notifyFavoritesBurst({
        album_title: album.title,
        share_token: token,
        viewer_id: viewerId,
        count,
      });
    }
  }
  return { favorited: res.state === "added" };
}

/**
 * Verify the share link password, set the signed unlock cookie on
 * success. Used by the password gate page; returns plain JSON so the
 * page can render an inline error without a redirect dance.
 */
export async function unlockShareLink(
  token: string,
  formData: FormData,
): Promise<UnlockResult> {
  const password = String(formData.get("password") ?? "");
  if (!password) return { ok: false, error: "Enter a password." };

  const link = await loadShareLink(token);
  if (!link) return { ok: false, error: "Link not found." };
  if (!link.password_hash) {
    // Already public — nothing to unlock; just succeed.
    return { ok: true };
  }
  const ok = await verifyPassword(link.password_hash, password);
  if (!ok) return { ok: false, error: "Incorrect password." };

  const jar = await cookies();
  jar.set(unlockCookieName(token), signUnlockValue(token, Date.now()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: `/a/${token}`,
    maxAge: UNLOCK_TTL_SECONDS,
  });
  const viewerForCapture = jar.get(VIEWER_COOKIE)?.value ?? "anonymous";
  safeCapture({
    distinctId: viewerForCapture,
    event: "share_unlocked",
    properties: { share_token: token, album_id: link.album_id },
  });
  return { ok: true };
}
