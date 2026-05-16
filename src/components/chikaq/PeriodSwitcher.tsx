"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

const OPTIONS: Array<{ value: "7d" | "30d" | "90d" | "all"; label: string }> = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "all" },
];

/**
 * Pill group above the /chikaq stats. Updates the `period` search param
 * via a Next.js navigation so the server-rendered page re-fetches with
 * the new window. We keep this as `Link`s (not button + router.push) so
 * each option is its own URL — bookmarkable, shareable, and the active
 * tab survives a refresh.
 */
export function PeriodSwitcher({ defaultPeriod = "30d" }: { defaultPeriod?: "7d" | "30d" | "90d" | "all" }): React.JSX.Element {
  const pathname = usePathname();
  const params = useSearchParams();
  const current = (params.get("period") ?? defaultPeriod) as typeof OPTIONS[number]["value"];

  return (
    <div role="tablist" aria-label="Period" className="inline-flex items-center gap-0.5 rounded-full border border-line bg-bg-card p-0.5">
      {OPTIONS.map((opt) => {
        const isActive = current === opt.value;
        const next = new URLSearchParams(params.toString());
        if (opt.value === "30d") next.delete("period");
        else next.set("period", opt.value);
        const href = next.toString() ? `${pathname}?${next.toString()}` : pathname;
        return (
          <Link
            key={opt.value}
            href={href}
            role="tab"
            aria-selected={isActive}
            className={
              `rounded-full px-3 py-1 text-xs tabular-nums transition-all duration-200 ` +
              (isActive
                ? "bg-rose-accent/20 text-rose-accent ring-1 ring-rose-accent/30"
                : "text-text-muted hover:text-text hover:bg-bg-elevated")
            }
          >
            {opt.label}
          </Link>
        );
      })}
    </div>
  );
}
