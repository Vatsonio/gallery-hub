"use server";

import { sql } from "@/lib/db";
import { generateShareToken, type ShareLinkRow } from "@/lib/share";
import { requireAdmin } from "@/lib/session";
import { hashPassword } from "@/lib/passwords";
import { revalidatePath } from "next/cache";

export interface CreateShareLinkInput {
  password?: string | null;
  expiresAt?: Date | null;
  allowDownload?: boolean;
}

export interface UpdateShareLinkInput {
  newPassword?: string | null;
  expiresAt?: Date | null;
  allowDownload?: boolean;
}

export async function createShareLink(albumId: string, input: CreateShareLinkInput): Promise<ShareLinkRow> {
  await requireAdmin();
  const passwordHash = input.password ? await hashPassword(input.password) : null;
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
  return rows[0];
}

export async function revokeShareLink(token: string): Promise<void> {
  await requireAdmin();
  await sql`DELETE FROM share_links WHERE token = ${token}`;
  revalidatePath(`/admin/albums`);
}
