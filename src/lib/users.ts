import { sql } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/passwords";

export type UserRole = "owner" | "admin";

export interface AdminUser {
  id: string;
  email: string;
  role: UserRole;
  name: string | null;
  created_at: string;
  last_login_at: string | null;
  disabled_at: string | null;
}

interface AdminUserRow extends AdminUser {
  password_hash: string;
}

const SELECT_PUBLIC = `id, email, role, name, created_at::text AS created_at,
       last_login_at::text AS last_login_at,
       disabled_at::text AS disabled_at`;

/**
 * Verify an email+password pair against admin_users. Constant-time for the
 * no-user branch (the caller's existing login flow already burns a dummy
 * argon2 verify when this returns null). Disabled users are treated as
 * "no such user" so the response time and surface match.
 */
export async function verifyLogin(
  email: string,
  password: string,
): Promise<AdminUser | null> {
  const rows = await sql<AdminUserRow[]>`
    SELECT ${sql.unsafe(SELECT_PUBLIC)}, password_hash
      FROM admin_users
     WHERE email = ${email}
       AND disabled_at IS NULL
     LIMIT 1
  `;
  if (rows.length === 0) return null;
  const row = rows[0];
  const ok = await verifyPassword(row.password_hash, password);
  if (!ok) return null;
  // Caller saves the session; this side-effect just keeps the
  // "last seen this human" column fresh.
  await sql`UPDATE admin_users SET last_login_at = now() WHERE id = ${row.id}`
    .catch(() => undefined);
  return stripHash(row);
}

function stripHash(row: AdminUserRow): AdminUser {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    name: row.name,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
    disabled_at: row.disabled_at,
  };
}

export async function getUserById(id: string): Promise<AdminUser | null> {
  const rows = await sql<AdminUser[]>`
    SELECT ${sql.unsafe(SELECT_PUBLIC)} FROM admin_users WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listUsers(): Promise<AdminUser[]> {
  return sql<AdminUser[]>`
    SELECT ${sql.unsafe(SELECT_PUBLIC)} FROM admin_users
     ORDER BY (role = 'owner') DESC, lower(email) ASC
  `;
}

export interface CreateUserInput {
  email: string;
  password: string;
  name?: string | null;
  role: UserRole;
}

export async function createUser(input: CreateUserInput): Promise<AdminUser> {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) throw new Error("invalid email");
  if (input.password.length < 8) throw new Error("password too short");
  if (input.role !== "owner" && input.role !== "admin") throw new Error("invalid role");
  const hash = await hashPassword(input.password);
  const rows = await sql<AdminUser[]>`
    INSERT INTO admin_users (email, password_hash, role, name)
    VALUES (${email}, ${hash}, ${input.role}, ${input.name ?? null})
    RETURNING ${sql.unsafe(SELECT_PUBLIC)}
  `;
  return rows[0];
}

export interface UpdateUserInput {
  name?: string | null;
  role?: UserRole;
  disabled?: boolean;
}

export async function updateUser(id: string, input: UpdateUserInput): Promise<AdminUser | null> {
  const current = await getUserById(id);
  if (!current) return null;
  // Prevent demoting the sole owner — DB unique-partial-index already
  // blocks a second owner, but a transition owner → admin would leave
  // zero owners and lock the system.
  if (current.role === "owner" && input.role === "admin") {
    throw new Error("cannot demote the only owner");
  }
  // F11: code-level symmetry with the DB partial-unique index on owner.
  // Without this, the failure surface is a raw 23505 propagating up to
  // the operator.
  if (current.role === "admin" && input.role === "owner") {
    throw new Error("cannot promote an admin to owner (one owner only)");
  }
  const disabledAt =
    input.disabled === undefined
      ? null
      : input.disabled
        ? new Date().toISOString()
        : null;
  const rows = await sql<AdminUser[]>`
    UPDATE admin_users
       SET name        = COALESCE(${input.name ?? null}, name),
           role        = COALESCE(${input.role ?? null}, role),
           disabled_at = CASE
             WHEN ${input.disabled === undefined} THEN disabled_at
             WHEN ${input.disabled === true} THEN COALESCE(disabled_at, ${disabledAt})
             ELSE NULL
           END
     WHERE id = ${id}
     RETURNING ${sql.unsafe(SELECT_PUBLIC)}
  `;
  return rows[0] ?? null;
}

export async function setUserPassword(id: string, newPassword: string): Promise<void> {
  if (newPassword.length < 8) throw new Error("password too short");
  const hash = await hashPassword(newPassword);
  await sql`UPDATE admin_users SET password_hash = ${hash} WHERE id = ${id}`;
}

export async function deleteUser(id: string): Promise<void> {
  // Owner protection — the DB partial-unique-index allows deleting an owner,
  // but doing so would brick admin login until the next bootstrap script run.
  const current = await getUserById(id);
  if (!current) return;
  if (current.role === "owner") {
    throw new Error("cannot delete the owner");
  }
  await sql`DELETE FROM admin_users WHERE id = ${id}`;
}

export async function getOwner(): Promise<AdminUser | null> {
  const rows = await sql<AdminUser[]>`
    SELECT ${sql.unsafe(SELECT_PUBLIC)} FROM admin_users WHERE role = 'owner' LIMIT 1
  `;
  return rows[0] ?? null;
}
