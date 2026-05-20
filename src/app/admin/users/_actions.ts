"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner, invalidateUserStateCache } from "@/lib/auth-check";
import { getAdminSession } from "@/lib/session";
import {
  createUser,
  updateUser,
  setUserPassword,
  deleteUser,
  getUserById,
} from "@/lib/users";

function encodeMessage(msg: string): string {
  return encodeURIComponent(msg);
}

// F6: map known errors to short user-facing strings so raw Postgres /
// validation messages never reach the URL bar or access logs. Unknown
// errors collapse to a stable "internal" code; the real message stays
// in the server console.
function safeErrorMessage(err: unknown, context: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes("duplicate") || raw.includes("unique")) {
    return "An account with that email already exists";
  }
  if (raw.includes("cannot demote the only owner")) return "Cannot demote the only owner";
  if (raw.includes("cannot promote an admin to owner")) return "Cannot promote an admin to owner (one owner only)";
  if (raw.includes("cannot delete the owner")) return "Cannot delete the owner";
  if (raw.includes("invalid email")) return "Enter a valid email";
  if (raw.includes("password too short")) return "Password must be at least 8 characters";
  if (raw.includes("invalid role")) return "Invalid role";
  // eslint-disable-next-line no-console
  console.warn(`[admin/users] ${context} failed:`, raw);
  return "Could not complete the request";
}

export async function createUserAction(formData: FormData): Promise<void> {
  await requireOwner();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const nameRaw = String(formData.get("name") ?? "").trim();
  const name = nameRaw.length > 0 ? nameRaw : null;

  if (!email || !email.includes("@")) {
    redirect(`/admin/users/new?error=${encodeMessage("Enter a valid email")}`);
  }
  if (password.length < 8) {
    redirect(`/admin/users/new?error=${encodeMessage("Password must be at least 8 characters")}`);
  }

  try {
    await createUser({ email, password, name, role: "admin" });
  } catch (err) {
    redirect(`/admin/users/new?error=${encodeMessage(safeErrorMessage(err, "createUser"))}`);
  }

  revalidatePath("/admin/users");
  redirect(`/admin/users?ok=${encodeMessage("User created")}`);
}

export async function updateUserAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/admin/users");

  const hasName = formData.has("name");
  const nameRaw = String(formData.get("name") ?? "").trim();
  const name = hasName ? (nameRaw.length > 0 ? nameRaw : null) : undefined;
  const roleRaw = String(formData.get("role") ?? "");
  const disabledRaw = formData.get("disabled");
  const returnTo = String(formData.get("returnTo") ?? "");

  const role = roleRaw === "owner" || roleRaw === "admin" ? roleRaw : undefined;
  const disabled = disabledRaw === null ? undefined : disabledRaw === "1";

  try {
    await updateUser(id, { name, role, disabled });
  } catch (err) {
    const back = returnTo === "list" ? "/admin/users" : `/admin/users/${id}`;
    redirect(`${back}?error=${encodeMessage(safeErrorMessage(err, "updateUser"))}`);
  }

  // F2: live session lookups cache disabled/role for 30s — invalidate
  // immediately so the change takes effect on the next request, not in
  // up to 30 seconds.
  invalidateUserStateCache(id);
  revalidatePath("/admin/users");
  revalidatePath(`/admin/users/${id}`);
  const successBack = returnTo === "list" ? "/admin/users" : `/admin/users/${id}`;
  const okMsg = disabled === true ? "User disabled" : disabled === false ? "User enabled" : "Changes saved";
  redirect(`${successBack}?ok=${encodeMessage(okMsg)}`);
}

/**
 * Per-user quota override. GB input → bytes BIGINT on the row. An empty
 * input clears the override and reverts to the global default from
 * settings.uploads. A 0 input is treated the same as empty — "unlimited
 * for this user" only makes sense at the global-default level; clearing
 * the per-user override and trusting the default keeps the data model
 * smaller.
 */
function parseQuotaGbToBytes(raw: FormDataEntryValue | null): string | null {
  if (raw === null) return null;
  const s = String(raw).trim();
  if (s.length === 0) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  if (n === 0) return null;
  return String(n * 1_000_000_000);
}

export async function updateUserQuotaAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/admin/users");

  const quota_total_bytes = parseQuotaGbToBytes(formData.get("quota_total_gb"));
  const quota_album_bytes = parseQuotaGbToBytes(formData.get("quota_album_gb"));

  try {
    await updateUser(id, { quota_total_bytes, quota_album_bytes });
  } catch (err) {
    redirect(`/admin/users/${id}?error=${encodeMessage(safeErrorMessage(err, "updateUserQuota"))}`);
  }

  revalidatePath(`/admin/users/${id}`);
  redirect(`/admin/users/${id}?ok=${encodeMessage("Quota updated")}`);
}

export async function resetPasswordAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = String(formData.get("id") ?? "");
  const pwd = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!id) redirect("/admin/users");
  if (pwd.length < 8) {
    redirect(`/admin/users/${id}?error=${encodeMessage("Password must be at least 8 characters")}`);
  }
  if (pwd !== confirm) {
    redirect(`/admin/users/${id}?error=${encodeMessage("Passwords do not match")}`);
  }

  try {
    await setUserPassword(id, pwd);
  } catch (err) {
    redirect(`/admin/users/${id}?error=${encodeMessage(safeErrorMessage(err, "resetPassword"))}`);
  }

  revalidatePath(`/admin/users/${id}`);
  redirect(`/admin/users/${id}?ok=${encodeMessage("Password reset")}`);
}

export async function deleteUserAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/admin/users");

  const session = await getAdminSession();
  if (session.userId === id) {
    redirect(`/admin/users?error=${encodeMessage("You cannot delete your own account")}`);
  }

  const target = await getUserById(id);
  if (!target) {
    redirect(`/admin/users?error=${encodeMessage("User not found")}`);
  }

  try {
    await deleteUser(id);
  } catch (err) {
    redirect(`/admin/users?error=${encodeMessage(safeErrorMessage(err, "deleteUser"))}`);
  }

  invalidateUserStateCache(id);
  revalidatePath("/admin/users");
  redirect(`/admin/users?ok=${encodeMessage("User deleted")}`);
}
