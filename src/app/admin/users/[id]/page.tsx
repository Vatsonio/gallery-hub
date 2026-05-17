import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ChevronLeft, UserCog, Power, Trash2, KeyRound } from "lucide-react";
import { requireOwner } from "@/lib/auth-check";
import { getAdminSession } from "@/lib/session";
import { getUserById } from "@/lib/users";
import {
  updateUserAction,
  resetPasswordAction,
  deleteUserAction,
} from "../_actions";
import { FlashToasts } from "../_flash";
import { PasswordField } from "../_PasswordField";
import { formatAbsolute, formatRelative } from "../_format";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function EditUserPage({ params }: Props): Promise<React.JSX.Element> {
  await requireOwner();
  const { id } = await params;
  const user = await getUserById(id);
  if (!user) notFound();

  const session = await getAdminSession();
  const isSelf = session.userId === user.id;
  const isOwner = user.role === "owner";
  const disabled = user.disabled_at !== null;
  const roleEditable = !isOwner;
  const statusEditable = !isOwner;

  return (
    <div className="p-6 max-w-screen-md">
      <Suspense fallback={null}>
        <FlashToasts />
      </Suspense>

      <div className="flex items-center gap-3">
        <Link
          href="/admin/users"
          className="text-text-muted hover:text-text transition"
          aria-label="Back"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-rose-500/15 text-rose-300">
          <UserCog className="h-4 w-4" />
        </span>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-light text-white truncate">{user.email}</h1>
          <p className="text-sm text-text-muted">
            {isSelf ? "Editing your own account." : "Editing user account."} Created{" "}
            {formatAbsolute(user.created_at)} · Last login {formatRelative(user.last_login_at)}.
          </p>
        </div>
      </div>

      <section className="mt-8 rounded-xl border border-line bg-bg-elevated p-6">
        <h2 className="text-sm uppercase tracking-widest text-text-muted mb-4">Profile</h2>
        <form action={updateUserAction} className="space-y-5">
          <input type="hidden" name="id" value={user.id} />

          <label className="block">
            <span className="text-xs text-text-muted uppercase tracking-wider">Email</span>
            <input
              type="email"
              value={user.email}
              readOnly
              disabled
              className="mt-1 w-full rounded-lg bg-bg-card border border-line px-3 py-2 text-sm text-text-muted cursor-not-allowed"
            />
          </label>

          <label className="block">
            <span className="text-xs text-text-muted uppercase tracking-wider">Name</span>
            <input
              name="name"
              type="text"
              defaultValue={user.name ?? ""}
              className="mt-1 w-full rounded-lg bg-bg-card border border-line px-3 py-2 text-sm focus:outline-none focus:border-rose-accent"
            />
          </label>

          <div className="block">
            <span className="text-xs text-text-muted uppercase tracking-wider">Role</span>
            {roleEditable ? (
              <select
                name="role"
                defaultValue={user.role}
                className="mt-1 w-full rounded-lg bg-bg-card border border-line px-3 py-2 text-sm focus:outline-none focus:border-rose-accent"
              >
                <option value="admin">admin</option>
              </select>
            ) : (
              <div className="mt-1">
                <span className="inline-flex items-center rounded-full bg-rose-500/15 px-2.5 py-1 text-[11px] font-medium text-rose-300 ring-1 ring-rose-500/30">
                  owner
                </span>
                <p className="mt-1 text-[11px] text-text-muted">
                  The owner role is locked for this account.
                </p>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="submit"
              className="rounded-lg bg-rose-accent hover:bg-rose-hover transition px-4 py-2 text-sm font-medium text-white cursor-pointer"
            >
              Save changes
            </button>
          </div>
        </form>
      </section>

      <section className="mt-6 rounded-xl border border-line bg-bg-elevated p-6">
        <h2 className="text-sm uppercase tracking-widest text-text-muted mb-4 flex items-center gap-2">
          <KeyRound className="size-3.5" />
          Reset password
        </h2>
        <form action={resetPasswordAction} className="space-y-5">
          <input type="hidden" name="id" value={user.id} />
          <PasswordField name="password" label="New password" required autoComplete="new-password" />
          <label className="block">
            <span className="text-xs text-text-muted uppercase tracking-wider">Confirm password</span>
            <input
              name="confirm"
              type="password"
              required
              minLength={8}
              className="mt-1 w-full rounded-lg bg-bg-card border border-line px-3 py-2 text-sm font-mono focus:outline-none focus:border-rose-accent"
            />
          </label>
          <div className="flex items-center justify-end pt-1">
            <button
              type="submit"
              className="rounded-lg bg-bg-card hover:bg-white/10 border border-line px-4 py-2 text-sm transition cursor-pointer"
            >
              Reset password
            </button>
          </div>
        </form>
      </section>

      <section className="mt-6 rounded-xl border border-line bg-bg-elevated p-6">
        <h2 className="text-sm uppercase tracking-widest text-text-muted mb-4">Account status</h2>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm">
              {disabled ? "This user is currently disabled." : "This user is active."}
            </p>
            <p className="mt-0.5 text-xs text-text-muted">
              Disabled users cannot sign in. Live sessions are revoked within 30 seconds.
            </p>
          </div>
          {statusEditable ? (
            <form action={updateUserAction}>
              <input type="hidden" name="id" value={user.id} />
              <input type="hidden" name="disabled" value={disabled ? "0" : "1"} />
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-lg bg-bg-card hover:bg-white/10 border border-line px-3 py-2 text-sm transition cursor-pointer"
              >
                <Power className="size-3.5" />
                {disabled ? "Enable" : "Disable"}
              </button>
            </form>
          ) : (
            <span
              className="inline-flex items-center gap-1.5 rounded-lg bg-bg-card border border-line px-3 py-2 text-sm text-text-muted/50 cursor-not-allowed"
              title="owner can't be removed"
            >
              <Power className="size-3.5" />
              Disable
            </span>
          )}
        </div>
      </section>

      <section className="mt-6 rounded-xl border border-rose-500/20 bg-rose-500/5 p-6">
        <h2 className="text-sm uppercase tracking-widest text-rose-300/80 mb-4">Danger zone</h2>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm">Permanently delete this account.</p>
            <p className="mt-0.5 text-xs text-text-muted">
              {isSelf
                ? "You cannot delete your own account."
                : isOwner
                  ? "The owner account cannot be removed."
                  : "This cannot be undone."}
            </p>
          </div>
          {isOwner || isSelf ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-lg bg-bg-card border border-line px-3 py-2 text-sm text-text-muted/50 cursor-not-allowed"
              title={isSelf ? "you can't delete yourself" : "owner can't be removed"}
            >
              <Trash2 className="size-3.5" />
              Delete user
            </span>
          ) : (
            <form action={deleteUserAction}>
              <input type="hidden" name="id" value={user.id} />
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 px-3 py-2 text-sm transition cursor-pointer"
              >
                <Trash2 className="size-3.5" />
                Delete user
              </button>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
