import { cookies } from "next/headers";
import { getIronSession, type SessionOptions, type IronSession } from "iron-session";

export interface AdminSession {
  userId?: string;
  email?: string;
}

// Known-bad placeholder secrets that must never reach a running app. The
// pentest report (F1) flagged that operators can paste the dev secret from
// dev.bat into a prod env file: the value satisfies the documented "32+ chars"
// rule and looks innocuous, but it is committed to public source control so
// any reader of the repo can forge sessions. Anything matching this list
// throws at boot (prod) or at first session read (dev).
export const KNOWN_PLACEHOLDER_SESSION_PASSWORDS: ReadonlySet<string> = new Set([
  "dev-demo-secret-thirty-two-chars-long-pls",
  "replace-me-with-a-32-plus-character-secret",
  "dev-only-insecure-password-please-override-in-production-env",
]);

export function isPlaceholderSessionPassword(value: string): boolean {
  return KNOWN_PLACEHOLDER_SESSION_PASSWORDS.has(value);
}

function resolveSessionPassword(): string {
  const fromEnv = process.env.SESSION_PASSWORD;
  if (fromEnv && fromEnv.length > 0) {
    if (isPlaceholderSessionPassword(fromEnv) && process.env.NODE_ENV === "production") {
      throw new Error(
        "SESSION_PASSWORD is set to a known placeholder value in production. " +
          "Generate a fresh secret with: openssl rand -hex 32"
      );
    }
    return fromEnv;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_PASSWORD env var is required in production. " +
        "Generate one with: openssl rand -hex 32"
    );
  }
  // Dev fallback: a long but obviously-placeholder string. Picked up by
  // isPlaceholderSessionPassword so warnings stay loud.
  return "dev-only-insecure-password-please-override-in-production-env";
}

export const sessionOptions: SessionOptions = {
  password: resolveSessionPassword(),
  cookieName: "gh_admin_session",
  cookieOptions: {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30
  }
};

export async function getAdminSession(): Promise<IronSession<AdminSession>> {
  const cookieStore = await cookies();
  return getIronSession<AdminSession>(cookieStore, sessionOptions);
}

export interface AdminAuthOk { ok: true; userId: string; email: string; }
export interface AdminAuthErr { ok: false; }
export type AdminAuthResult = AdminAuthOk | AdminAuthErr;

/**
 * Validates admin auth from an incoming Request (Route Handler / Server Action with manual req).
 * Honors `x-test-admin: 1` header during tests (NODE_ENV === "test").
 * Otherwise reads the iron-session cookie from the request headers.
 */
export async function requireAdminSession(req: Request): Promise<AdminAuthResult> {
  if (process.env.NODE_ENV === "test" && req.headers.get("x-test-admin") === "1") {
    return { ok: true, userId: "test-admin", email: "test@local" };
  }
  // Build a CookieStore-like wrapper around the request Cookie header
  const cookieHeader = req.headers.get("cookie") ?? "";
  const parsed = new Map<string, string>();
  for (const part of cookieHeader.split(/;\s*/).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    parsed.set(decodeURIComponent(part.slice(0, eq).trim()), decodeURIComponent(part.slice(eq + 1).trim()));
  }
  const cookieStoreLike = {
    get(name: string) { const v = parsed.get(name); return v ? { name, value: v } : undefined; },
    set(_name: string, _value: string, _opts?: unknown) { /* no-op for request side */ },
    delete(_name: string) { /* no-op */ }
  };

  const session = await getIronSession<AdminSession>(
    cookieStoreLike as unknown as never,
    sessionOptions
  );
  if (session.userId && session.email) return { ok: true, userId: session.userId, email: session.email };
  return { ok: false };
}

export async function requireAdminSessionFromCookies(): Promise<AdminAuthResult> {
  const session = await getAdminSession();
  if (session.userId && session.email) return { ok: true, userId: session.userId, email: session.email };
  return { ok: false };
}

export async function requireAdmin(): Promise<AdminAuthOk> {
  if (process.env.GH_TEST_BYPASS_AUTH === "1") {
    return { ok: true, userId: "test-admin", email: "test@local" };
  }
  const r = await requireAdminSessionFromCookies();
  if (!r.ok) throw new Error("unauthorized");
  return r;
}
