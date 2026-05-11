"use server";

import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { verifyPassword } from "@/lib/passwords";
import { getAdminSession } from "@/lib/session";

type AdminRow = { id: string; email: string; password_hash: string };

export type AuthResult =
  | { ok: true; user: { id: string; email: string } }
  | { ok: false; error: string };

export async function authenticate(email: string, password: string): Promise<AuthResult> {
  const rows = await sql<AdminRow[]>`
    SELECT id, email, password_hash FROM admin_users WHERE email = ${email} LIMIT 1
  `;
  if (rows.length === 0) return { ok: false, error: "Invalid email or password" };
  const row = rows[0];
  const valid = await verifyPassword(row.password_hash, password);
  if (!valid) return { ok: false, error: "Invalid email or password" };
  return { ok: true, user: { id: row.id, email: row.email } };
}

export async function loginAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/admin/albums");

  if (!email || !password) {
    redirect("/admin/login?error=missing");
  }
  const result = await authenticate(email, password);
  if (!result.ok) {
    redirect("/admin/login?error=invalid");
  }
  const session = await getAdminSession();
  session.userId = result.user.id;
  session.email = result.user.email;
  await session.save();
  redirect(next.startsWith("/admin") ? next : "/admin/albums");
}
