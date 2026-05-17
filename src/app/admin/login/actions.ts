"use server";

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/passwords";
import { getAdminSession } from "@/lib/session";
import { createRateLimiter } from "@/lib/rateLimiter";
import { safeCapture } from "@/lib/analytics";
import { resolveIpFromHeaders } from "@/lib/client-ip";

type AdminRow = {
  id: string;
  email: string;
  password_hash: string;
  role: "owner" | "admin";
  disabled_at: string | null;
};

export type AuthResult =
  | {
      ok: true;
      user: { id: string; email: string; role: "owner" | "admin" };
    }
  | { ok: false; error: string };

// Soft block: 10 attempts per email (case-folded) per 60s. Defends against
// targeted brute-force on a known account.
const emailLimiter = createRateLimiter({ max: 10, windowMs: 60_000 });

// Hard block: 20 attempts per IP per 60s. Defends against credential stuffing
// across many emails from one origin. On trip we add a 1s sleep to extend the
// real cost beyond Argon2's intrinsic ~200ms.
const ipLimiter = createRateLimiter({ max: 20, windowMs: 60_000 });

// Generic, identical response in all rate-limited paths so the caller cannot
// tell which limiter fired or whether the email exists.
const GENERIC_ERROR = "Invalid email or password";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

async function resolveRequestIp(): Promise<string> {
  const h = await headers();
  return resolveIpFromHeaders(h);
}

// Lazy dummy argon2 hash. Used to constant-time the user-not-found branch of
// authenticate() so an attacker can't enumerate valid admin emails via the
// response-time delta (F4 in the 2026-05-16 pentest measured ~37 ms).
// Computed once on first use to avoid baking a literal hash into source.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword("::not-a-real-password::");
  }
  return dummyHashPromise;
}

export async function authenticate(email: string, password: string): Promise<AuthResult> {
  const rows = await sql<AdminRow[]>`
    SELECT id, email, password_hash, role, disabled_at::text AS disabled_at
      FROM admin_users WHERE email = ${email} LIMIT 1
  `;
  if (rows.length === 0) {
    // Burn an argon2 verify against a fixed dummy hash so the no-user branch
    // takes the same wall-clock time as the wrong-password branch.
    const dummy = await getDummyHash();
    await verifyPassword(dummy, password);
    return { ok: false, error: GENERIC_ERROR };
  }
  const row = rows[0];
  const valid = await verifyPassword(row.password_hash, password);
  if (!valid) return { ok: false, error: GENERIC_ERROR };
  // Disabled accounts get the same generic error as bad creds. We still
  // ran verifyPassword (no timing tell) so an attacker can't distinguish
  // "disabled" from "wrong password" from "no such email".
  if (row.disabled_at !== null) {
    return { ok: false, error: GENERIC_ERROR };
  }
  // Side-effect: refresh last_login_at for the user-management table.
  await sql`UPDATE admin_users SET last_login_at = now() WHERE id = ${row.id}`
    .catch(() => undefined);
  return { ok: true, user: { id: row.id, email: row.email, role: row.role } };
}

/**
 * Production entry point for login. Layers two rate limiters around
 * `authenticate`:
 *   - per-email (case-folded) — 10 / 60s, soft block
 *   - per-IP                  — 20 / 60s, hard block + 1s sleep
 *
 * Returns the same generic error in all failure cases so a caller cannot
 * distinguish "wrong password" from "rate limited" from "no such email".
 *
 * `ipOverride` is for tests; in normal use the IP is resolved from request
 * headers. (Server-action exports must all be async; the second arg falls
 * back to live header resolution when omitted.)
 */
export async function authenticateWithLimits(
  email: string,
  password: string,
  ipOverride?: string
): Promise<AuthResult> {
  const folded = email.trim().toLowerCase();
  const ip = ipOverride ?? (await resolveRequestIp());

  if (!emailLimiter.allow(`email:${folded}`)) {
    safeCapture({
      distinctId: hashIp(ip),
      event: "login_rate_limited",
      properties: { kind: "email" },
    });
    return { ok: false, error: GENERIC_ERROR };
  }

  if (!ipLimiter.allow(`ip:${ip}`)) {
    safeCapture({
      distinctId: hashIp(ip),
      event: "login_rate_limited",
      properties: { kind: "ip" },
    });
    await sleep(1_000);
    return { ok: false, error: GENERIC_ERROR };
  }

  return authenticate(folded, password);
}

export async function loginAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/admin/albums");

  if (!email || !password) {
    redirect("/admin/login?error=missing");
  }
  const result = await authenticateWithLimits(email, password);
  if (!result.ok) {
    redirect("/admin/login?error=invalid");
  }
  const session = await getAdminSession();
  session.userId = result.user.id;
  session.email = result.user.email;
  session.role = result.user.role;
  await session.save();
  redirect(next.startsWith("/admin") ? next : "/admin/albums");
}

