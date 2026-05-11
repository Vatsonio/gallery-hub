import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Lock } from "lucide-react";
import {
  resolveShareLinkStatus,
  unlockCookieName,
} from "@/lib/share";
import { unlockShareLink } from "../_actions";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}

/**
 * Dark glass password gate. When the user submits the form we hit the
 * `unlockShareLink` server action which either sets the HMAC unlock
 * cookie + we redirect to the gallery, or we render an inline error.
 *
 * Because Next 15 server actions can return a value, we wrap with a
 * thin server action that performs the redirect after a successful
 * unlock. The "wrong password" path bounces back here with ?error=1.
 */
async function unlockAndMaybeRedirect(
  token: string,
  formData: FormData,
): Promise<void> {
  "use server";
  const res = await unlockShareLink(token, formData);
  if (res.ok) {
    redirect(`/a/${token}`);
  }
  redirect(`/a/${token}/password?error=1`);
}

export default async function PasswordGatePage({ params, searchParams }: Props) {
  const { token } = await params;
  const sp = await searchParams;

  // Already unlocked or link doesn't require a password — bounce home.
  const jar = await cookies();
  const unlocked = jar.get(unlockCookieName(token))?.value ?? null;
  const status = await resolveShareLinkStatus(token, unlocked);
  if (status.kind === "ok") {
    redirect(`/a/${token}`);
  }
  if (status.kind === "not_found") {
    redirect(`/a/${token}`); // will 404 via the gallery page
  }
  if (status.kind === "expired") {
    redirect(`/a/${token}`);
  }

  const action = unlockAndMaybeRedirect.bind(null, token);

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-black/60 p-6 backdrop-blur-xl shadow-2xl">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-[#ff4d6d]/15 text-[#ff4d6d]">
            <Lock className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-lg font-light tracking-wide text-white">
              Enter password
            </h1>
            <p className="text-xs text-white/50">This gallery is protected.</p>
          </div>
        </div>
        <form action={action} className="mt-5 space-y-3">
          <input
            type="password"
            name="password"
            autoFocus
            required
            placeholder="Password"
            autoComplete="current-password"
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white placeholder:text-white/30 outline-none focus:border-[#ff4d6d]/60 focus:bg-white/10 transition"
          />
          {sp.error && (
            <p className="text-xs text-[#ff4d6d]">Incorrect password.</p>
          )}
          <button
            type="submit"
            className="w-full cursor-pointer rounded-md bg-[#ff4d6d] hover:bg-[#ff6b85] px-4 py-2 text-sm font-medium text-white transition"
          >
            Unlock
          </button>
        </form>
      </div>
    </main>
  );
}
