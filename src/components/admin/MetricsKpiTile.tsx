"use client";

import type { LucideIcon } from "lucide-react";

interface Props {
  label: string;
  /** Pre-formatted headline value. */
  value: string;
  subLine?: string;
  /** Optional signed delta (positive = green, negative = rose). */
  deltaPct?: number | null;
  Icon: LucideIcon;
  accent?: boolean;
}

export function MetricsKpiTile({
  label,
  value,
  subLine,
  deltaPct,
  Icon,
  accent,
}: Props): React.JSX.Element {
  const hasDelta = deltaPct !== undefined && deltaPct !== null && Number.isFinite(deltaPct);
  const sign = hasDelta && (deltaPct as number) >= 0 ? "+" : "";
  const deltaColor =
    !hasDelta
      ? "text-text-muted"
      : (deltaPct as number) >= 0
        ? "text-emerald-300"
        : "text-rose-400";

  return (
    <div className="rounded-xl border border-line bg-bg-elevated p-4 transition hover:border-rose-400/30">
      <div className="flex items-center gap-2">
        <span
          className={`grid h-8 w-8 place-items-center rounded-lg ${
            accent ? "bg-rose-500/15 text-rose-300" : "bg-bg-card text-text-muted"
          }`}
        >
          <Icon className="h-4 w-4" />
        </span>
        <p className="text-xs uppercase tracking-widest text-text-muted">{label}</p>
      </div>
      <p
        className={`mt-3 text-3xl font-light tracking-tight tabular-nums ${
          accent ? "text-rose-300" : "text-text"
        }`}
      >
        {value}
      </p>
      {(subLine || hasDelta) && (
        <p className="mt-1 text-xs text-text-muted">
          {hasDelta && (
            <span className={`tabular-nums ${deltaColor} mr-1`}>
              {sign}
              {Math.round(deltaPct as number)}%
            </span>
          )}
          {subLine}
        </p>
      )}
    </div>
  );
}
