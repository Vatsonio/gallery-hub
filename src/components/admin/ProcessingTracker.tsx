"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { formatEta } from "@/lib/format";
import { useCountUpInt } from "@/lib/useCountUp";

interface Props {
  /** Album slug — drives the API endpoint we poll. */
  slug: string;
  /**
   * Bumped from the parent each time a fresh upload batch finalises.
   * Triggers the tracker to begin polling. If the parent never bumps
   * this, the tracker sits silent — we don't want a perpetually-running
   * 1Hz fetch on every album-detail page view.
   */
  triggerKey: number;
}

interface StatusBody {
  total: number;
  ready: number;
  processing: number;
  uploading: number;
  median_ttr_seconds: number | null;
  eta_seconds: number | null;
}

/**
 * Floating glass card (bottom-right on desktop / full-width bottom strip
 * on mobile) showing the worker's processing progress for an album.
 *
 * The tracker activates when the parent bumps `triggerKey` after a
 * finalize, polls `/api/albums/[slug]/processing-status` at 1Hz, and
 * collapses into a "All ready" pulse the moment processing → 0. The
 * success state is held for 2s, then the tracker disposes itself.
 *
 * Why a separate poll loop and not the existing grid `status_only=1`
 * fetch: the grid component fetches the entire photo array (with imgproxy
 * URLs) every refresh, which is too heavy for a 1Hz cadence and would
 * thrash the React tree as photo URLs swap on each tick. This dedicated
 * endpoint returns four scalars in a sub-200-byte body, refreshes only
 * the tracker, and unmounts cleanly once work is done.
 */
export function ProcessingTracker({ slug, triggerKey }: Props): React.JSX.Element | null {
  const [status, setStatus] = useState<StatusBody | null>(null);
  const [active, setActive] = useState(false);
  const [allDoneAt, setAllDoneAt] = useState<number | null>(null);
  const lastTriggerRef = useRef<number>(triggerKey);

  // Begin polling when the parent bumps triggerKey. A `triggerKey===0`
  // initial value means "the parent has not requested any tracking yet"
  // — we treat that as inactive.
  useEffect(() => {
    if (triggerKey === 0 || triggerKey === lastTriggerRef.current) return;
    lastTriggerRef.current = triggerKey;
    setActive(true);
    setAllDoneAt(null);
  }, [triggerKey]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch(`/api/albums/${encodeURIComponent(slug)}/processing-status`, {
          headers: { accept: "application/json" },
        });
        if (!r.ok) return;
        const body = (await r.json()) as StatusBody;
        if (cancelled) return;
        setStatus(body);
        if (body.processing === 0 && body.uploading === 0 && body.total > 0) {
          // Mark the moment all photos go ready so we can run the
          // success animation + auto-dismiss timer.
          setAllDoneAt((prev) => prev ?? Date.now());
        }
      } catch {
        // Network blips are silent — the next tick will retry.
      }
    }
    void poll();
    const id = window.setInterval(poll, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, slug]);

  // Auto-dismiss the tracker 2s after everything completes so the user
  // sees the green tick before the chrome disappears.
  useEffect(() => {
    if (allDoneAt === null) return;
    const t = window.setTimeout(() => {
      setActive(false);
      setStatus(null);
      setAllDoneAt(null);
    }, 2000);
    return () => window.clearTimeout(t);
  }, [allDoneAt]);

  // Animated counter for the "processing" tile — bumps smoothly as the
  // worker chews through the backlog, even though the underlying data
  // updates in 1Hz steps.
  const processingTarget = status?.processing ?? 0;
  const animatedProcessing = useCountUpInt(processingTarget, { durationMs: 400 });

  if (!active || !status) return null;

  const total = status.total;
  const ready = status.ready;
  const allDone = allDoneAt !== null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-4 right-4 z-40 sm:left-auto sm:right-6 sm:bottom-6 sm:max-w-sm"
    >
      <div className="rounded-xl border border-white/10 bg-zinc-900/80 px-4 py-3 shadow-2xl backdrop-blur-md ring-1 ring-white/5 transition-all duration-300">
        {allDone ? (
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-400" aria-hidden />
            <span className="text-sm text-white/90">All ready</span>
            <span className="ml-auto text-xs tabular-nums text-white/50">
              {total} {total === 1 ? "photo" : "photos"}
            </span>
          </div>
        ) : (
          <>
            <div className="mb-1.5 flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-rose-300" aria-hidden />
              <span className="text-sm text-white/90">
                Processing{" "}
                <span className="tabular-nums font-medium text-white">{animatedProcessing}</span>{" "}
                <span className="text-white/40">of</span>{" "}
                <span className="tabular-nums font-medium text-white">{total}</span>
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
              <div
                className="h-full rounded-full bg-gradient-to-r from-rose-500 via-rose-400 to-rose-300 transition-[width] duration-500 ease-out"
                style={{ width: total > 0 ? `${(ready / total) * 100}%` : "0%" }}
              />
            </div>
            <p className="mt-2 text-xs tabular-nums text-white/55">
              {formatEta(status.eta_seconds) ?? "computing…"}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
