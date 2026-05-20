import { NextResponse, type NextRequest } from "next/server";
import { getIronSession } from "iron-session";
import { sessionOptions, type AdminSession } from "@/lib/session";

// Hard-coded here to avoid pulling `@/lib/viewer` into the Edge bundle —
// that module imports `node:crypto`, which Edge runtime forbids. Keep this
// constant in sync with VIEWER_COOKIE in `@/lib/viewer`.
const VIEWER_COOKIE = "gh_viewer";

// CSP needs runtime env access (MINIO_PUBLIC_ENDPOINT etc.) — these aren't
// set during `next build` in CI, so a build-time CSP was leaving
// `connect-src 'self'` and blocking every presigned PUT to MinIO.
// Building it in middleware reads env at request time.
function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function buildCsp(): string {
  const minio = [originOf(process.env.MINIO_PUBLIC_ENDPOINT), originOf(process.env.MINIO_ENDPOINT)]
    .filter((v): v is string => v !== null);
  const imgproxy = [originOf(process.env.PUBLIC_IMGPROXY_URL), originOf(process.env.IMGPROXY_URL)]
    .filter((v): v is string => v !== null);
  // Cloudflare Insights beacon. Loaded automatically on sites behind CF
  // when "Web Analytics" is enabled. Without it browsers throw a CSP
  // violation in the console on every page.
  const cfInsights = "https://static.cloudflareinsights.com";
  const minioCsp = minio.length > 0 ? " " + minio.join(" ") : "";
  const imgproxyCsp = imgproxy.length > 0 ? " " + imgproxy.join(" ") : "";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `img-src 'self' data: blob: https:${minioCsp}${imgproxyCsp}`,
    "font-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${cfInsights}`,
    `connect-src 'self'${minioCsp}${imgproxyCsp} ${cfInsights}`,
    "upgrade-insecure-requests",
  ].join("; ");
}

let cachedCsp: string | null = null;
function getCsp(): string {
  if (cachedCsp === null) cachedCsp = buildCsp();
  return cachedCsp;
}

function applySecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set("Content-Security-Policy", getCsp());
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return res;
}

export function shouldProtect(pathname: string): boolean {
  // /chikaq is the admin-only insights surface — gate it identically to /admin/*
  // (any path inside /chikaq, but never the admin login page itself).
  if (pathname === "/admin/login") return false;
  if (pathname.startsWith("/admin")) return true;
  if (pathname === "/chikaq" || pathname.startsWith("/chikaq/")) return true;
  return false;
}

// Match `/a/<token>` and `/a/<token>/<anything>` so we can mint a gh_viewer
// cookie before the page renders. Next 15 forbids writing cookies during
// page render, so the cookie mint moves here.
const PUBLIC_SHARE_RE = /^\/a\/([^/]+)(?:\/.*)?$/;

async function mintViewerCookieIfNeeded(req: NextRequest, res: NextResponse): Promise<void> {
  const m = PUBLIC_SHARE_RE.exec(req.nextUrl.pathname);
  if (!m) return;
  // Only mint for browser navigations. Don't touch RSC / data prefetch traffic.
  if (req.method !== "GET") return;

  // Admin previews must never persist a viewer cookie — the page detects the
  // admin session and uses the ADMIN_PREVIEW_VIEWER_ID instead. We verify the
  // session here (not just the cookie's presence) so a stale / invalid
  // admin cookie still mints a viewer.
  const adminSession = await getIronSession<AdminSession>(req, res, sessionOptions);
  if (adminSession.userId) return;

  void m;
  // Always re-set the cookie at path "/". Two reasons:
  //   1. Mint a fresh UUID if the viewer hasn't been here before.
  //   2. Migrate any legacy cookie that was scoped to path "/a/{token}"
  //      (pre-2026-05 deployment) onto the wider path so /api/export/...
  //      can read it. Without this migration the first /api/export call
  //      would not receive the cookie, the route would mint a
  //      *replacement* UUID, and the viewer's existing favorites would
  //      be orphaned the moment they clicked "Download".
  // The (share_token, viewer_id) pair already scopes favorites per album,
  // so widening the cookie path doesn't cross-correlate viewers.
  const existing = req.cookies.get(VIEWER_COOKIE)?.value;
  const id = existing && existing.length > 0 ? existing : crypto.randomUUID();
  res.cookies.set(VIEWER_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  // Reflect into the request so the page-render reads the same id even
  // before the browser round-trips the new Set-Cookie.
  req.cookies.set(VIEWER_COOKIE, id);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (shouldProtect(pathname)) {
    const res = NextResponse.next();
    const session = await getIronSession<AdminSession>(req, res, sessionOptions);
    if (!session.userId) {
      const url = req.nextUrl.clone();
      url.pathname = "/admin/login";
      url.searchParams.set("next", pathname);
      return applySecurityHeaders(NextResponse.redirect(url));
    }
    return applySecurityHeaders(res);
  }

  // Public share routes: ensure gh_viewer cookie exists (skipped for admin previews).
  if (PUBLIC_SHARE_RE.test(pathname)) {
    // TODO: gate public share routes on the `maintenance.enabled` app_setting.
    // When set, return a maintenance page (or 503) instead of running the
    // viewer-cookie mint + page render. Reading app_settings from the Edge
    // runtime needs either a cached lookup outside postgres.js or a sync
    // signal pushed in at deploy time — out of scope for the settings page.
    const res = NextResponse.next({ request: { headers: req.headers } });
    await mintViewerCookieIfNeeded(req, res);
    return applySecurityHeaders(res);
  }

  return applySecurityHeaders(NextResponse.next());
}

// Match every path except Next's own asset bundles and the favicon so the
// CSP is consistently applied to every HTML response (including the
// homepage and /api/health). Static assets carry their own headers and
// don't benefit from CSP.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
