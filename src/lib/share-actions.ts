"use server";

import { sql } from "@/lib/db";
import { generateShareToken, listShareTokensForAlbum, type ShareLinkRow } from "@/lib/share";
import { requireAdmin } from "@/lib/auth-check";
import { hashPassword } from "@/lib/passwords";
import { loadSettings } from "@/lib/settings";
import { revalidatePath } from "next/cache";

// F5: the /a/[token] page is ISR-cached for `revalidate = 60`. Without
// explicit invalidation, a share-link revocation / password add / photo
// delete stays invisible to viewers for up to 60 s. revalidateShareToken
// is the single chokepoint admin mutations should call.
export async function revalidateShareToken(token: string): Promise<void> {
  revalidatePath(`/a/${token}`);
}

export async function revalidateAlbumShareTokens(albumId: string): Promise<void> {
  const tokens = await listShareTokensForAlbum(albumId);
  for (const t of tokens) revalidatePath(`/a/${t}`);
}

export interface CreateShareLinkInput {
  password?: string | null;
  expiresAt?: Date | null;
  allowDownload?: boolean;
}

function addDaysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export interface UpdateShareLinkInput {
  newPassword?: string | null;
  expiresAt?: Date | null;
  allowDownload?: boolean;
}

export async function createShareLink(albumId: string, input: CreateShareLinkInput): Promise<ShareLinkRow> {
  await requireAdmin();
  // F4: fall back to settings.share_links.default_* when the caller
  // omits a field. The previous code hard-defaulted to "no expiry,
  // download on, no password" regardless of operator settings.
  const settings = await loadSettings();
  const defaults = settings.share_links;
  if (input.password === undefined && defaults.default_require_password) {
    throw new Error("password required by default share-link settings");
  }
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const expiresAt =
    input.expiresAt !== undefined
      ? input.expiresAt
      : defaults.default_expiry_days !== null
        ? addDaysFromNow(defaults.default_expiry_days)
        : null;
  const allowDownload =
    input.allowDownload !== undefined ? input.allowDownload : defaults.default_allow_download;
  for (let i = 0; i < 5; i++) {
    const token = generateShareToken();
    const rows = await sql<ShareLinkRow[]>`
      INSERT INTO share_links (token, album_id, password_hash, expires_at, allow_download)
      VALUES (${token}, ${albumId}, ${passwordHash}, ${expiresAt}, ${allowDownload})
      ON CONFLICT (token) DO NOTHING
      RETURNING token, album_id, password_hash, expires_at, allow_download, created_at
    `;
    if (rows[0]) {
      revalidatePath(`/admin/albums`);
      revalidatePath(`/a/${rows[0].token}`);
      return rows[0];
    }
  }
  throw new Error("Failed to generate unique share token after 5 attempts");
}

export async function updateShareLink(token: string, input: UpdateShareLinkInput): Promise<ShareLinkRow> {
  await requireAdmin();
  let newPasswordHash: string | null | undefined = undefined;
  if (input.newPassword === null) newPasswordHash = null;
  else if (typeof input.newPassword === "string") newPasswordHash = await hashPassword(input.newPassword);

  const rows = await sql<ShareLinkRow[]>`
    UPDATE share_links SET
      password_hash = CASE WHEN ${newPasswordHash !== undefined} THEN ${newPasswordHash ?? null} ELSE password_hash END,
      expires_at = CASE WHEN ${input.expiresAt !== undefined} THEN ${input.expiresAt ?? null} ELSE expires_at END,
      allow_download = CASE WHEN ${input.allowDownload !== undefined} THEN ${input.allowDownload ?? true} ELSE allow_download END
    WHERE token = ${token}
    RETURNING token, album_id, password_hash, expires_at, allow_download, created_at
  `;
  if (!rows[0]) throw new Error("share link not found");
  revalidatePath(`/admin/albums`);
  revalidatePath(`/a/${token}`);
  return rows[0];
}

export async function revokeShareLink(token: string): Promise<void> {
  await requireAdmin();
  await sql`DELETE FROM share_links WHERE token = ${token}`;
  revalidatePath(`/admin/albums`);
  revalidatePath(`/a/${token}`);
}
