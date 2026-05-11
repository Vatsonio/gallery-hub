import { NextResponse, type NextRequest } from "next/server";
import { getIronSession } from "iron-session";
import { sessionOptions, type AdminSession } from "@/lib/session";

export function shouldProtect(pathname: string): boolean {
  if (!pathname.startsWith("/admin")) return false;
  if (pathname === "/admin/login") return false;
  return true;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!shouldProtect(pathname)) return NextResponse.next();

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

export const config = {
  matcher: ["/admin/:path*"]
};
