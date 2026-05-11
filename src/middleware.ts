import { NextResponse, type NextRequest } from "next/server";
import { getIronSession } from "iron-session";
import { sessionOptions, type AdminSession } from "@/lib/session";

// Hard-coded here to avoid pulling `@/lib/viewer` into the Edge bundle —
// that module imports `node:crypto`, which Edge runtime forbids. Keep this
// constant in sync with VIEWER_COOKIE in `@/lib/viewer`.
const VIEWER_COOKIE = "gh_viewer";

export function shouldProtect(pathname: string): boolean {
  if (!pathname.startsWith("/admin")) return false;
  if (pathname === "/admin/login") return false;
  return true;
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
  const existing = req.cookies.get(VIEWER_COOKIE)?.value;
  if (existing) return;

  // Admin previews must never persist a viewer cookie — the page detects the
  // admin session and uses the ADMIN_PREVIEW_VIEWER_ID instead. We verify the
  // session here (not just the cookie's presence) so a stale / invalid
  // admin cookie still mints a viewer.
  const adminSession = await getIronSession<AdminSession>(req, res, sessionOptions);
  if (adminSession.userId) return;

  const token = m[1];
  const id = crypto.randomUUID();
  res.cookies.set(VIEWER_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: `/a/${token}`,
    maxAge: 60 * 60 * 24 * 365,
  });
  // Also reflect into the request so the page-render reads the same id.
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
  matcher: ["/admin/:path*", "/a/:path*"],
};
