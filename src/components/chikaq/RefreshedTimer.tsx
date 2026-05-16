"use client";

import { useEffect, useState, useTransition } from "react";
import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { formatRelativeTime } from "@/lib/format";

interface Props {
  /** ISO timestamp captured server-side at page render time. */
  renderedAtIso: string;
}

/**
 * Live "Refreshed N seconds ago" indicator plus a discreet refresh button.
 *
 * The number ticks every second up to the one-minute mark, then drops to
 * once-per-30s. router.refresh() re-fetches the server component without
 * a full page reload, so clicking the button feels instant.
 */
export function RefreshedTimer({ renderedAtIso }: Props): React.JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    // We tick every second for the first minute (so the label feels live),
    // then once per 30s. The cadence is selected based on the current
    // delta — if the delta jumps (e.g. user clicked Refresh), we re-pick
    // the cadence at the next tick.
    let interval = 1000;
    const id = window.setInterval(() => {
      setNow((cur) => {
        const next = Date.now();
        const elapsedSec = (next - new Date(renderedAtIso).getTime()) / 1000;
        const newInterval = elapsedSec < 60 ? 1000 : 30_000;
        if (newInterval !== interval) {
          interval = newInterval;
        }
        return next;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [renderedAtIso]);

  function onRefresh() {
    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <span className="inline-flex items-center gap-2 text-xs text-text-muted">
      <span className="tabular-nums">Refreshed {formatRelativeTime(renderedAtIso, now)}</span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={isPending}
        className={
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors duration-200 " +
          (isPending
            ? "cursor-wait text-text-muted/60"
            : "hover:bg-bg-elevated hover:text-text cursor-pointer")
        }
        aria-label="Refresh now"
      >
        <RotateCcw className={`size-3 ${isPending ? "animate-spin" : ""}`} aria-hidden />
        <span className="sr-only sm:not-sr-only">Refresh</span>
      </button>
    </span>
  );
}
