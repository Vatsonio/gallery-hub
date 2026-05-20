import Link from "next/link";
import {
  Activity,
  BarChart3,
  Bell,
  Heart,
  Images,
  LogOut,
  Settings,
  Users as UsersIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { logoutAction } from "./logout/actions";
import { getAdminSession } from "@/lib/session";
import { ToastProvider } from "@/components/ui/Toast";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  ownerOnly?: boolean;
}
interface NavSection {
  title: string;
  items: NavItem[];
}

const NAV: NavSection[] = [
  {
    title: "Workspace",
    items: [
      { href: "/admin/albums", label: "Albums", icon: Images },
    ],
  },
  {
    title: "Insights",
    items: [
      { href: "/admin/selections", label: "Client Selections", icon: Heart },
      { href: "/admin/notifications", label: "Notifications", icon: Bell },
      { href: "/admin/metrics", label: "Metrics", icon: BarChart3, ownerOnly: true },
      { href: "/chikaq", label: "PostHog", icon: Activity },
    ],
  },
  {
    title: "System",
    items: [
      { href: "/admin/users", label: "Users", icon: UsersIcon, ownerOnly: true },
      { href: "/admin/settings", label: "Settings", icon: Settings, ownerOnly: true },
    ],
  },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  const email = session.email ?? "";
  const role: "owner" | "admin" = session.role ?? "admin";
  const isOwner = role === "owner";

  return (
    <div className="min-h-screen flex bg-bg text-text">
      <aside className="w-60 shrink-0 border-r border-line bg-bg-elevated flex flex-col">
        <div className="px-5 py-5 border-b border-line">
          <p className="text-sm font-semibold tracking-wider">Gallery Hub</p>
          <p className="text-[11px] text-text-muted truncate">{email}</p>
          <p className="mt-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-text-muted">
            <span
              className={`inline-block size-1.5 rounded-full ${
                isOwner ? "bg-rose-400" : "bg-text-muted"
              }`}
            />
            {role}
          </p>
        </div>
        <nav className="flex-1 px-2 py-4 space-y-6 text-sm">
          {NAV.map((section) => {
            const visible = section.items.filter((it) => !it.ownerOnly || isOwner);
            if (visible.length === 0) return null;
            return (
              <div key={section.title}>
                <p className="px-3 mb-2 text-[10px] uppercase tracking-widest text-text-muted">
                  {section.title}
                </p>
                <ul className="space-y-0.5">
                  {visible.map((item) => {
                    const Icon = item.icon;
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-bg-card transition"
                        >
                          <Icon className="size-4 text-text-muted" />
                          <span>{item.label}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>
        <form action={logoutAction} className="p-3 border-t border-line">
          <button
            type="submit"
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-bg-card transition text-sm cursor-pointer"
          >
            <LogOut className="size-4 text-text-muted" />
            <span>Sign out</span>
          </button>
        </form>
        {isOwner ? <BuildBadge /> : null}
      </aside>
      <main className="flex-1 min-w-0">
        <ToastProvider>{children}</ToastProvider>
      </main>
    </div>
  );
}

/**
 * Owner-only build chip. Splits APP_VERSION into a label + optional short
 * SHA: "sha-abcd1234..." → label "build" / short "abcd123". For tag-style
 * versions ("smoke", "prod", "v1.2") we just show the raw value.
 */
function BuildBadge(): React.JSX.Element {
  const raw = process.env.APP_VERSION ?? "dev";
  const shaMatch = /^sha-([0-9a-f]{7,40})$/i.exec(raw);
  const short = shaMatch ? shaMatch[1].slice(0, 7) : null;
  return (
    <div
      className="border-t border-line px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-text-muted/70"
      title={`APP_VERSION=${raw}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span>version</span>
        <span className="text-text/80">{short ? `sha-${short}` : raw}</span>
      </div>
      {short ? (
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <span>build</span>
          <span className="truncate text-text/60">{shaMatch?.[1]}</span>
        </div>
      ) : null}
    </div>
  );
}
