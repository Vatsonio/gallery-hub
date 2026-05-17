"use client";

import { useEffect, useState } from "react";
import { Camera } from "lucide-react";
import { useCountUp } from "@/lib/useCountUp";
import { formatBytes, formatCount } from "@/lib/format";

/**
 * One tile of the four-up stat strip on /chikaq. Animates from 0 to the
 * supplied value on mount (server-rendered first paint shows "0", then
 * the count-up kicks in once hydration finishes). The sparkline beneath
 * is rendered as static SVG by the parent — we only own the headline
 * number animation here so the page stays mostly server-side.
 */
interface Props {
  label: string;
  value: number;
  /** When true, render the value as a smart byte string instead of a count. */
  asBytes?: boolean;
  accent?: boolean;
  Icon: typeof Camera;
  /** Sparkline SVG (server-rendered) slotted under the headline number. */
  sparkline?: React.ReactNode;
  /** Soft hint shown when the value is zero — e.g. "No views yet". */
  emptyHint?: string;
}

export function AnimatedStatTile({ label, value, asBytes, accent, Icon, sparkline, emptyHint }: Props): React.JSX.Element {
  // We start the count-up at 0 on first mount so the user sees the tile
  // breathe. Once the animation lands, subsequent value changes animate
  // from the prior settled value.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    // Defer one frame so the static "0" paint isn't perceptually skipped.
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const animated = useCountUp(armed ? value : 0, { durationMs: 800 });
  const display = asBytes ? formatBytes(animated) : formatCount(Math.round(animated));
  const isZero = value === 0;

  return (
    <div className="group relative rounded-xl border border-line bg-bg-elevated p-4 transition-shadow duration-200 hover:shadow-[0_0_0_1.5px_rgba(255,77,109,0.18)]">
      <div className="flex items-start gap-3">
        <div className={`rounded-lg p-2 ${accent ? "bg-rose-accent/15 text-rose-accent" : "bg-bg-card text-text-muted"}`}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-widest text-text-muted">{label}</p>
          <p className={`mt-0.5 text-xl font-light tabular-nums tracking-tight truncate ${accent ? "text-rose-accent" : "text-text"}`}>
            {display}
          </p>
          {isZero && emptyHint && (
            <p className="mt-0.5 text-[10px] text-text-muted/70">{emptyHint}</p>
          )}
        </div>
      </div>
      {sparkline && (
        <div className="mt-2 -mb-1 -mx-1 h-8 overflow-hidden">
          {sparkline}
        </div>
      )}
    </div>
  );
}
