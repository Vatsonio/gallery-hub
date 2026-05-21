import { getIronSession } from "iron-session";
import { redirect } from "next/navigation";
import {
  type AdminAuthResult,
  type AdminAuthOk,
  type AdminSession,
  getAdminSession,
  sessionOptions,
} from "@/lib/session";
import { getUserById } from "@/lib/users";

/**
 * Node-only auth checks. Lives in a separate module from `session.ts` so the
 * Edge-runtime middleware (which imports `sessionOptions` + the `AdminSession`
 * type) doesn't pull `lib/users` → `lib/passwords` → @node-rs/argon2 into the
 * Edge bundle. Argon2's Edge build references a wasm fallback that isn't
 * installed, so static imports here would break `next build`.
 *
 * Every admin request re-checks the DB row so disabled_at / deletion takes
 * effect on next request and so the in-cookie role can be refreshed from the
 * live DB value. A 30 s in-process cache keeps the per-request cost off the
 * hot path; an owner who disables a hostile admin waits at most one cache
 * window for revocation.
 */
interface UserStateEntry {
  expiresAt: number;
  disabled: boolean;
  role: "owner" | "admin" | null;
}
const USER_STATE_TTL_MS = 30_000;
const userStateCache = new Map<string, UserStateEntry>();

async function resolveLiveUserState(userId: string): Promise<UserStateEntry> {
  const now = Date.now();
  const hit = userStateCache.get(userId);
  if (hit && hit.expiresAt > now) return hit;
  const row = await getUserById(userId).catch(() => null);
  const entry: UserStateEntry = {
    expiresAt: now + USER_STATE_TTL_MS,
    disabled: row === null || row.disabled_at !== null,
    role: row?.role ?? null,
  };
  userStateCache.set(userId, entry);
  return entry;
}

export function invalidateUserStateCache(userId?: string): void {
  if (userId) userStateCache.delete(userId);
  else userStateCache.clear();
}

export function isOwner(r: AdminAuthResult): boolean {
  return r.ok && r.role === "owner";
}

/**
 * Validates admin auth from an incoming Request (Route Handler / Server Action
 * with manual req). Honors `x-test-admin: 1` header during tests
 * (NODE_ENV === "test"). Otherwise reads the iron-session cookie from the
 * request headers and re-checks the DB row for disabled/deleted users.
 */
export async function requireAdminSession(req: Request): Promise<AdminAuthResult> {
  if (process.env.NODE_ENV === "test" && req.headers.get("x-test-admin") === "1") {
    return { ok: true, userId: "test-admin", email: "test@local", role: "owner" };
  }
  const cookieHeader = req.headers.get("cookie") ?? "";
  const parsed = new Map<string, string>();
  for (const part of cookieHeader.split(/;\s*/).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    parsed.set(
      decodeURIComponent(part.slice(0, eq).trim()),
      decodeURIComponent(part.slice(eq + 1).trim()),
    );
  }
  const cookieStoreLike = {
    get(name: string) {
      const v = parsed.get(name);
      return v ? { name, value: v } : undefined;
    },
    set(_name: string, _value: string, _opts?: unknown) {
      /* no-op for request side */
    },
    delete(_name: string) {
      /* no-op */
    },
  };
  const session = await getIronSession<AdminSession>(
    cookieStoreLike as unknown as never,
    sessionOptions,
  );
  if (session.userId && session.email) {
    const live = await resolveLiveUserState(session.userId);
    if (live.disabled) return { ok: false };
    return {
      ok: true,
      userId: session.userId,
      email: session.email,
      role: live.role ?? session.role ?? "admin",
    };
  }
  return { ok: false };
}

export async function requireAdminSessionFromCookies(): Promise<AdminAuthResult> {
  const session = await getAdminSession();
  if (session.userId && session.email) {
    const live = await resolveLiveUserState(session.userId);
    if (live.disabled) return { ok: false };
    return {
      ok: true,
      userId: session.userId,
      email: session.email,
      role: live.role ?? session.role ?? "admin",
    };
  }
  return { ok: false };
}

export async function requireAdmin(): Promise<AdminAuthOk> {
  if (process.env.GH_TEST_BYPASS_AUTH === "1") {
    return { ok: true, userId: "test-admin", email: "test@local", role: "owner" };
  }
  const r = await requireAdminSessionFromCookies();
  if (!r.ok) {
    // Server actions hitting this branch used to throw `Error("unauthorized")`,
    // which Next masks in prod builds as a generic "Server Components render"
    // toast — the operator was left staring at a useless message after their
    // session quietly expired on an already-rendered page. redirect() is
    // intercepted by Next and routed as a real navigation to the login page.
    redirect("/admin/login");
  }
  return r;
}

export async function requireOwner(): Promise<AdminAuthOk> {
  const r = await requireAdmin();
  if (r.role !== "owner") throw new Error("forbidden: owner only");
  return r;
}
