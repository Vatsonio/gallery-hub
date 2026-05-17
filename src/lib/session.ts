import { cookies } from "next/headers";
import { getIronSession, type SessionOptions, type IronSession } from "iron-session";

export interface AdminSession {
  userId?: string;
  email?: string;
  /**
   * Role at the moment of login. The DB is the source of truth — when an owner
   * downgrades an admin live, `lib/auth-check` re-resolves the role from the
   * DB on every request (with a short cache). This field is just a fallback
   * for the rare case the DB lookup fails.
   */
  role?: "owner" | "admin";
}

/**
 * Edge-safe session surface: cookie configuration, iron-session adapter, type
 * exports. Anything that needs a DB row check (disabled_at, live role) lives
 * in `lib/auth-check` so middleware (Edge runtime) doesn't transitively pull
 * `lib/users` → `lib/passwords` → @node-rs/argon2, which has no working Edge
 * build in this dependency tree.
 */

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
  // Next.js collects per-route module data during `next build` even when no
  // env file is present (GitHub Actions, Docker build stage). Return a
  // build-time placeholder so the route module can finish initialising —
  // production runtime never sees this because the env var is set there.
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return "build-time-placeholder-thirty-two-chars-min-do-not-use";
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

export interface AdminAuthOk {
  ok: true;
  userId: string;
  email: string;
  role: "owner" | "admin";
}
export interface AdminAuthErr { ok: false; }
export type AdminAuthResult = AdminAuthOk | AdminAuthErr;
