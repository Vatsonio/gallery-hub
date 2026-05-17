import Link from "next/link";
import { Suspense } from "react";
import { Users as UsersIcon, Plus, Pencil, Power, Trash2 } from "lucide-react";
import { requireOwner } from "@/lib/auth-check";
import { getAdminSession } from "@/lib/session";
import { listUsers, type AdminUser } from "@/lib/users";
import { updateUserAction, deleteUserAction } from "./_actions";
import { FlashToasts } from "./_flash";
import { formatRelative, formatAbsolute } from "./_format";

export const dynamic = "force-dynamic";

function RoleBadge({ role }: { role: AdminUser["role"] }): React.JSX.Element {
  if (role === "owner") {
    return (
      <span className="inline-flex items-center rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] font-medium text-rose-300 ring-1 ring-rose-500/30">
        owner
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-medium text-text-muted ring-1 ring-white/10">
      admin
    </span>
  );
}

function StatusPill({ disabled }: { disabled: boolean }): React.JSX.Element {
  return disabled ? (
    <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
      <span className="size-1.5 rounded-full bg-text-muted" />
      Disabled
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
      <span className="size-1.5 rounded-full bg-emerald-400" />
      Active
    </span>
  );
}

export default async function UsersListPage(): Promise<React.JSX.Element> {
  await requireOwner();
  const session = await getAdminSession();
  const currentUserId = session.userId ?? "";

  const users = await listUsers();

  return (
    <div className="p-6 max-w-screen-xl">
      <Suspense fallback={null}>
        <FlashToasts />
      </Suspense>

      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-rose-500/15 text-rose-300">
          <UsersIcon className="h-4 w-4" />
        </span>
        <div className="flex-1">
          <h1 className="text-2xl font-light text-white">Users</h1>
          <p className="text-sm text-text-muted">
            Manage admins who can sign in to Gallery Hub.
          </p>
        </div>
        <Link
          href="/admin/users/new"
          className="inline-flex items-center gap-2 rounded-lg bg-rose-accent hover:bg-rose-hover transition px-3 py-2 text-sm font-medium text-white"
        >
          <Plus className="size-4" />
          New user
        </Link>
      </div>

      <section className="mt-8">
        <div className="overflow-hidden rounded-xl border border-line bg-bg-elevated">
          <table className="w-full text-sm">
            <thead className="bg-bg-card text-text-muted">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Email</th>
                <th className="px-4 py-3 text-left font-medium">Name</th>
                <th className="px-4 py-3 text-left font-medium">Role</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Last login</th>
                <th className="px-4 py-3 text-left font-medium">Created</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="text-text">
              {users.length <= 1 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-text-muted">
                    {users.length === 0 ? (
                      "No users yet."
                    ) : (
                      <>
                        <p className="text-sm">
                          Only one user so far — that&apos;s you.
                        </p>
                        <p className="mt-1 text-xs">
                          Add admins from the button above.
                        </p>
                      </>
                    )}
                  </td>
                </tr>
              ) : null}
              {users.map((u) => {
                const isOwner = u.role === "owner";
                const isSelf = u.id === currentUserId;
                const disabled = u.disabled_at !== null;
                return (
                  <tr key={u.id} className="border-t border-line align-middle">
                    <td className="px-4 py-3 font-medium">
                      <Link href={`/admin/users/${u.id}`} className="hover:text-rose-300 transition">
                        {u.email}
                      </Link>
                      {isSelf ? (
                        <span className="ml-2 text-[10px] uppercase tracking-widest text-text-muted">
                          you
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-text-muted">
                      {u.name ?? <span className="text-text-muted/60">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <RoleBadge role={u.role} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill disabled={disabled} />
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted tabular-nums">
                      {formatRelative(u.last_login_at)}
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted tabular-nums">
                      {formatAbsolute(u.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          href={`/admin/users/${u.id}`}
                          className="inline-flex items-center gap-1 rounded-md bg-bg-card hover:bg-white/10 px-2 py-1 text-xs transition"
                          aria-label="Edit"
                        >
                          <Pencil className="size-3" />
                          Edit
                        </Link>
                        {isOwner ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-md bg-bg-card px-2 py-1 text-xs text-text-muted/50 cursor-not-allowed"
                            title="owner can't be removed"
                          >
                            <Power className="size-3" />
                            Disable
                          </span>
                        ) : (
                          <form action={updateUserAction}>
                            <input type="hidden" name="id" value={u.id} />
                            <input type="hidden" name="disabled" value={disabled ? "0" : "1"} />
                            <input type="hidden" name="returnTo" value="list" />
                            <button
                              type="submit"
                              className="inline-flex items-center gap-1 rounded-md bg-bg-card hover:bg-white/10 px-2 py-1 text-xs transition cursor-pointer"
                            >
                              <Power className="size-3" />
                              {disabled ? "Enable" : "Disable"}
                            </button>
                          </form>
                        )}
                        {isOwner ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-md bg-bg-card px-2 py-1 text-xs text-text-muted/50 cursor-not-allowed"
                            title="owner can't be removed"
                          >
                            <Trash2 className="size-3" />
                            Delete
                          </span>
                        ) : (
                          <form action={deleteUserAction}>
                            <input type="hidden" name="id" value={u.id} />
                            <button
                              type="submit"
                              className="inline-flex items-center gap-1 rounded-md bg-bg-card hover:bg-rose-500/20 hover:text-rose-300 px-2 py-1 text-xs transition cursor-pointer"
                            >
                              <Trash2 className="size-3" />
                              Delete
                            </button>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
