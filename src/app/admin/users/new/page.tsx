import Link from "next/link";
import { ChevronLeft, UserPlus } from "lucide-react";
import { requireOwner } from "@/lib/auth-check";
import { createUserAction } from "../_actions";
import { PasswordField } from "../_PasswordField";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ error?: string }>;
}

export default async function NewUserPage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requireOwner();
  const sp = await searchParams;
  const error = sp.error ?? null;

  return (
    <div className="p-6 max-w-screen-md">
      <div className="flex items-center gap-3">
        <Link
          href="/admin/users"
          className="text-text-muted hover:text-text transition"
          aria-label="Back"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-rose-500/15 text-rose-300">
          <UserPlus className="h-4 w-4" />
        </span>
        <div>
          <h1 className="text-2xl font-light text-white">New user</h1>
          <p className="text-sm text-text-muted">
            Create an admin account. You set the initial password directly.
          </p>
        </div>
      </div>

      <section className="mt-8 rounded-xl border border-line bg-bg-elevated p-6">
        <form action={createUserAction} className="space-y-5">
          <label className="block">
            <span className="text-xs text-text-muted uppercase tracking-wider">Email</span>
            <input
              name="email"
              type="email"
              required
              autoComplete="off"
              className="mt-1 w-full rounded-lg bg-bg-card border border-line px-3 py-2 text-sm focus:outline-none focus:border-rose-accent"
            />
          </label>

          <label className="block">
            <span className="text-xs text-text-muted uppercase tracking-wider">Name (optional)</span>
            <input
              name="name"
              type="text"
              autoComplete="off"
              className="mt-1 w-full rounded-lg bg-bg-card border border-line px-3 py-2 text-sm focus:outline-none focus:border-rose-accent"
            />
          </label>

          <div className="block">
            <span className="text-xs text-text-muted uppercase tracking-wider">Role</span>
            <div className="mt-1 inline-flex items-center rounded-full bg-white/5 px-2.5 py-1 text-[11px] font-medium text-text-muted ring-1 ring-white/10">
              admin
            </div>
            <p className="mt-1 text-[11px] text-text-muted">
              The owner role is reserved for a single account and cannot be assigned here.
            </p>
          </div>

          <PasswordField
            name="password"
            label="Password"
            required
            autoComplete="new-password"
          />

          {error ? (
            <p className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-sm text-rose-300" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Link
              href="/admin/users"
              className="rounded-lg bg-bg-card hover:bg-white/10 px-4 py-2 text-sm transition border border-line"
            >
              Cancel
            </Link>
            <button
              type="submit"
              className="rounded-lg bg-rose-accent hover:bg-rose-hover transition px-4 py-2 text-sm font-medium text-white cursor-pointer"
            >
              Create user
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
