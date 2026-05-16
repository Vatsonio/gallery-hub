/**
 * Origin / Referer same-origin check for state-mutating JSON API routes.
 *
 * F3 pentest finding (2026-05-16): `/api/upload/presign`, `/api/upload/finalize`
 * and `/api/photos/<id>/edit` accepted admin-cookied requests from any
 * origin. SameSite=Lax cookies + CORS preflight currently block the
 * practical exploit in real browsers, but the moment any of those
 * pre-conditions weaken, the endpoints become open. This helper is the
 * defense-in-depth server-side check.
 *
 * Policy: read `Origin` (preferred — set unambiguously by browsers on
 * state-changing fetches) and fall back to the URL portion of `Referer`.
 * Compare against the expected origin (PUBLIC_BASE_URL by default). Mismatch
 * → 403. Missing header → 403 (modern browsers always send Origin on a POST).
 */

export interface OriginCheckOptions {
  /** Override the expected origin. Defaults to PUBLIC_BASE_URL. */
  expected?: string;
}

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export function expectedOrigin(): string | null {
  return originOf(process.env.PUBLIC_BASE_URL);
}

/**
 * Returns `true` if the request's Origin (or Referer URL host) matches the
 * expected origin. Returns `false` on any mismatch — including missing
 * headers, malformed values, or absent PUBLIC_BASE_URL configuration.
 *
 * Tests (NODE_ENV === "test") that supply the bypass header `x-test-admin: 1`
 * also skip the check so existing same-origin admin-test scaffolding keeps
 * working without setting Origin manually.
 */
export function isSameOrigin(req: Request, opts: OriginCheckOptions = {}): boolean {
  if (
    process.env.NODE_ENV === "test" &&
    req.headers.get("x-test-admin") === "1"
  ) {
    return true;
  }
  const expected = opts.expected ?? expectedOrigin();
  if (!expected) return false;

  const origin = req.headers.get("origin");
  if (origin) return originOf(origin) === expected;

  const referer = req.headers.get("referer");
  if (referer) return originOf(referer) === expected;

  return false;
}
