import { NextResponse, type NextRequest } from "next/server";
import { getIronSession } from "iron-session";
import { sessionOptions, type AdminSession } from "@/lib/session";

// Hard-coded here to avoid pulling `@/lib/viewer` into the Edge bundle —
// that module imports `node:crypto`, which Edge runtime forbids. Keep this
// constant in sync with VIEWER_COOKIE in `@/lib/viewer`.
const VIEWER_COOKIE = "gh_viewer";

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
      return NextResponse.redirect(url);
    }
    return res;
  }

  // Public share routes: ensure gh_viewer cookie exists (skipped for admin previews).
  if (PUBLIC_SHARE_RE.test(pathname)) {
    const res = NextResponse.next({ request: { headers: req.headers } });
    await mintViewerCookieIfNeeded(req, res);
    return res;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/a/:path*", "/chikaq", "/chikaq/:path*"],
};
