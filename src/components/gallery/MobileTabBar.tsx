"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Grid, Heart } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  token: string;
  /** Number of favorites for the current viewer (used as a badge). */
  favoritesCount?: number;
  /**
   * When a GlassDock is mounted under this tab bar on mobile, the tab bar
   * lifts up so the dock can sit flush against the safe-area-inset-bottom.
   * Approximate height of the dock (icon + label + paddings) ~ 4.5rem.
   */
  liftForDock?: boolean;
}

/**
 * Sticky bottom tab bar visible on mobile only. Hosts All / Favorites
 * tabs as glass pills, safe-area-inset-bottom aware. Hidden on sm+
 * because the desktop layout uses the inline header for navigation.
 */
export default function MobileTabBar({ token, favoritesCount = 0, liftForDock = false }: Props) {
  const pathname = usePathname();
  const isAll = pathname === `/a/${token}`;
  const isFav = pathname === `/a/${token}/favorites`;

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 sm:hidden"
      style={{
        paddingBottom: liftForDock
          ? "calc(max(0.5rem, env(safe-area-inset-bottom)) + 5rem)"
          : "max(0.75rem, env(safe-area-inset-bottom))",
      }}
      aria-label="Gallery sections"
    >
      <div className="glass-dock mx-auto flex w-[min(92vw,420px)] items-center justify-around rounded-full px-2 py-1.5">
        <Tab
          href={`/a/${token}`}
          active={isAll}
          icon={<Grid className="h-4 w-4" />}
          label="All"
        />
        <Tab
          href={`/a/${token}/favorites`}
          active={isFav}
          icon={
            <span className="relative inline-flex">
              <Heart
                className="h-4 w-4"
                fill={isFav ? "#ff4d6d" : "none"}
                color={isFav ? "#ff4d6d" : "currentColor"}
              />
              {favoritesCount > 0 && (
                <span
                  className="absolute -top-1 -right-2 min-w-[14px] h-[14px] px-1 rounded-full text-[9px] font-medium leading-[14px] text-center bg-[#ff4d6d] text-white"
                  aria-hidden
                >
                  {favoritesCount > 99 ? "99+" : favoritesCount}
                </span>
              )}
            </span>
          }
          label="Favorites"
        />
      </div>
    </nav>
  );
}

function Tab({
  href,
  active,
  icon,
  label,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex h-11 flex-col items-center justify-center gap-0.5 px-5 rounded-full transition",
        active ? "text-white" : "text-white/60 hover:text-white",
      )}
    >
      {icon}
      <span className="text-[10px] tracking-wide">{label}</span>
    </Link>
  );
}
