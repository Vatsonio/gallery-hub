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

export async function listShareTokensForAlbum(albumId: string): Promise<string[]> {
  const rows = await sql<{ token: string }[]>`
    SELECT token FROM share_links WHERE album_id = ${albumId}
  `;
  return rows.map((r) => r.token);
}
