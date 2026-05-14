import Link from "next/link";
import { Activity, Bell, Heart, Images, LogOut } from "lucide-react";
import { logoutAction } from "./logout/actions";
import { getAdminSession } from "@/lib/session";

const NAV = [
  {
    title: "Workspace",
    items: [
      { href: "/admin/albums", label: "Albums", icon: Images },
    ]
  },
  {
    title: "Insights",
    items: [
      { href: "/admin/selections", label: "Client Selections", icon: Heart },
      { href: "/admin/notifications", label: "Notifications", icon: Bell },
      { href: "/chikaq", label: "Insights", icon: Activity },
    ]
  }
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  const email = session.email ?? "";

  return (
    <div className="min-h-screen flex bg-bg text-text">
      <aside className="w-60 shrink-0 border-r border-line bg-bg-elevated flex flex-col">
        <div className="px-5 py-5 border-b border-line">
          <p className="text-sm font-semibold tracking-wider">Gallery Hub</p>
          <p className="text-[11px] text-text-muted truncate">{email}</p>
        </div>
        <nav className="flex-1 px-2 py-4 space-y-6 text-sm">
          {NAV.map((section) => (
            <div key={section.title}>
              <p className="px-3 mb-2 text-[10px] uppercase tracking-widest text-text-muted">
                {section.title}
              </p>
              <ul className="space-y-0.5">
                {section.items.map((item) => {
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
          ))}
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
      </aside>
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
