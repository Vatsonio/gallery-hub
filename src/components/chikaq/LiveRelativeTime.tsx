"use client";

import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/format";

interface Props {
  iso: string;
  /** Cadence at which to re-render. Default 30s — relative time changes infrequently. */
  cadenceMs?: number;
}

/**
 * Renders a "N min ago" label that re-computes on a 30s timer so the
 * activity feed stays correct without forcing the whole page to re-render.
 *
 * Server-rendered first paint uses the captured timestamp, then the
 * client takes over with live ticks. Output text is wrapped in tabular-
 * nums so the row width doesn't jitter as the label transitions from
 * "30 sec ago" → "1 min ago".
 */
export function LiveRelativeTime({ iso, cadenceMs = 30_000 }: Props): React.JSX.Element {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), cadenceMs);
    return () => window.clearInterval(id);
  }, [cadenceMs]);
  return <span className="tabular-nums">{formatRelativeTime(iso, now)}</span>;
}
