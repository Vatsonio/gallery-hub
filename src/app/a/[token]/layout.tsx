import type { ReactNode } from "react";
import { cookies } from "next/headers";
import PostHogProvider from "@/components/PostHogProvider";
import { VIEWER_COOKIE } from "@/lib/viewer";
import { requireAdminSessionFromCookies } from "@/lib/auth-check";

export const dynamic = "force-dynamic";

export default async function PublicShareLayout({
  children,
}: {
  children: ReactNode;
}): Promise<React.JSX.Element> {
  // Admin previews must not pollute viewer analytics. We resolve the admin
  // session server-side so the client SDK is never even initialized for them.
  const adminSession = await requireAdminSessionFromCookies().catch(() => ({
    ok: false as const,
  }));
  const jar = await cookies();
  const distinctId = adminSession.ok
    ? null
    : (jar.get(VIEWER_COOKIE)?.value ?? null);

  // NEXT_PUBLIC_* env is inlined at build time. Both unset → provider is a no-op.
  const apiKey = adminSession.ok ? null : process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white antialiased">
      <PostHogProvider apiKey={apiKey} host={host} distinctId={distinctId}>
        {children}
      </PostHogProvider>
    </div>
  );
}
