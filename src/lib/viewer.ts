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
  void token;
  const existing = jar.get(VIEWER_COOKIE);
  if (existing?.value) return existing.value;
  const id = randomUUID();
  // Cookie path is "/" so /api/export/{token} receives the same viewer
  // cookie as /a/{token}; the previous per-token path would orphan
  // favorites when the export route minted a replacement UUID.
  jar.set(VIEWER_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return id;
}

export function readViewerId(jar: CookieJarLike): string | null {
  return jar.get(VIEWER_COOKIE)?.value ?? null;
}
