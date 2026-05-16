"use client";

/**
 * Full-page splash overlay that hides the staggered tile fade-in
 * behind a single cinematic curtain.
 *
 * The first paint of /a/<token> renders the cover hero plus a grid of
 * ThumbHash placeholders. Watching every tile pop in one by one feels
 * busy and amateur, especially on cold imgproxy where the first
 * 400-600ms is dominated by HTML hydration + image-decode jitter. The
 * splash holds a calm dark surface over the whole viewport until the
 * cover hero and the first ~8 above-the-fold tiles have landed, then
 * fades out over 400ms.
 *
 * Visual: black background, a rose-tinted dual-ring spinner with a soft
 * glow that gently pulses, plus the wordmark below. The pulse is
 * suppressed under `prefers-reduced-motion: reduce` — the rings still
 * appear, they just don't breathe.
 *
 * Coordination — the splash subscribes to PageLoadProgress (which is
 * mounted higher in the gallery shell). The provider pushes counter
 * snapshots through `subscribe(listener)`; the splash combines those
 * with a wall-clock since mount and feeds both into the pure
 * `shouldDismissSplash` predicate. When the predicate flips to true the
 * splash schedules its fade-out and unmounts.
 *
 * Hard ceiling: 6 seconds. The splash will never trap a viewer behind a
 * blank page if imgproxy stalls. Minimum visible: 350ms so cached
 * repeat visits get a deliberate-feeling pause rather than a flash.
 *
 * Empty-album shortcut: when `enabled` is false (album has no photos)
 * the splash renders nothing — there's no critical-render work to hide.
 */

import { useEffect, useRef, useState } from "react";
import {
  shouldDismissSplash,
  usePhotoLoadProgress,
  INITIAL_COUNTER,
  SPLASH_CRITICAL_TILE_TARGET,
} from "./PageLoadProgress";

interface Props {
  /**
   * False when the page has no photos at all (empty album). The splash
   * renders nothing in that case — there's no asynchronous work to hide
   * and showing a spinner over a "no photos" message would be confusing.
   */
  enabled: boolean;
}

/**
 * Minimum time the splash stays visible, in ms. Picked so that on a
 * cached / bfcache restore — where every image is instantly `.complete`
 * — the splash still has presence. Without this floor the user sees a
 * 30ms-flash that reads as glitchy.
 */
const MIN_VISIBLE_MS = 350;

/**
 * Hard ceiling. If imgproxy stalls or the cover never fires onLoad, the
 * splash dismisses anyway after this many ms. Generous enough that a
 * cold-cache cover on slow 3G has a chance to land naturally (~2-3s
 * typical), but bounded enough that a viewer behind a dead network
 * isn't trapped.
 */
const HARD_TIMEOUT_MS = 6_000;

/**
 * Fade duration after dismissal. Matches the cinematic feel of the
 * cover ken-burns + tile stagger — long enough to read as deliberate.
 */
const FADE_MS = 400;

export default function PageSplash({ enabled }: Props) {
  const progress = usePhotoLoadProgress();
  const [dismissed, setDismissed] = useState(false);
  const [removed, setRemoved] = useState(false);
  const mountedAtRef = useRef<number>(Date.now());
  const counterRef = useRef(INITIAL_COUNTER);

  // Empty-album shortcut: nothing to hide, render nothing. We still
  // call the hook above (rules-of-hooks) but skip every effect by
  // returning early below the hook block.
  useEffect(() => {
    if (!enabled) {
      // Even when disabled we mark the splash as fully gone so the SSR
      // overlay (rendered server-side as #gh-splash) is removed promptly
      // and doesn't intercept clicks while the rest of the page hydrates.
      setDismissed(true);
      setRemoved(true);
      return;
    }

    // Drive the dismiss decision off both counter pushes (from
    // PageLoadProgress.subscribe) AND a periodic re-evaluation (so the
    // min-visible-time and hard-timeout fire even when no counter
    // update arrives — e.g. when nothing has registered yet).
    let raf = 0;
    const evaluate = (): void => {
      const now = Date.now();
      const elapsed = now - mountedAtRef.current;
      const shouldDismiss = shouldDismissSplash({
        enabled,
        counter: counterRef.current,
        msSinceMount: elapsed,
        minVisibleMs: MIN_VISIBLE_MS,
        hardTimeoutMs: HARD_TIMEOUT_MS,
        criticalTileTarget: SPLASH_CRITICAL_TILE_TARGET,
      });
      if (shouldDismiss) {
        setDismissed(true);
        return;
      }
      // Re-evaluate on the next animation frame. This keeps the cost
      // negligible (1 predicate call per frame) and ensures we honor
      // min-visible-time / hard-timeout without scheduling specific
      // setTimeouts that race against counter pushes.
      raf = window.requestAnimationFrame(evaluate);
    };
    raf = window.requestAnimationFrame(evaluate);

    const unsubscribe = progress.subscribe((c) => {
      counterRef.current = c;
      // Counter changed — predicate might now flip. The rAF tick will
      // catch it on the next frame; we don't run synchronously here to
      // avoid a "fade during React commit" double-render.
    });

    return () => {
      unsubscribe();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [enabled, progress]);

  // After fade completes, unmount entirely so the splash doesn't
  // intercept pointer events. We schedule this only once dismiss flips
  // true so a quick-flicker (dismiss → un-dismiss) won't lose the
  // unmount.
  useEffect(() => {
    if (!dismissed) return;
    const t = window.setTimeout(() => setRemoved(true), FADE_MS + 50);
    return () => window.clearTimeout(t);
  }, [dismissed]);

  // SSR-companion removal: a static <div id="gh-splash"> may have been
  // injected into the document by a future server-side pre-paint pass
  // (currently not — see _gallery-shell — but harmless to clean up).
  // We strip it once React's splash mounts so two overlays don't stack.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const node = document.getElementById("gh-splash");
    if (node && node !== null) node.remove();
  }, []);

  if (!enabled) return null;
  if (removed) return null;

  return (
    <div
      aria-hidden
      data-testid="page-splash"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[#0a0a0a] transition-opacity ease-out"
      style={{
        opacity: dismissed ? 0 : 1,
        transitionDuration: `${FADE_MS}ms`,
        pointerEvents: dismissed ? "none" : "auto",
      }}
    >
      <div className="flex flex-col items-center gap-6">
        {/*
          Dual-ring spinner. The outer ring is a thin rose stroke with a
          soft glow; the inner ring rotates the other way at a slower
          tempo. Together they read as "calm, deliberate" rather than
          "spinning busy indicator". prefers-reduced-motion strips both
          rotations to a static ring.
        */}
        <div className="relative h-10 w-10">
          <span
            className="absolute inset-0 rounded-full border border-rose-400/30 motion-reduce:hidden"
            style={{
              animation: "splash-pulse 1800ms ease-in-out infinite",
              boxShadow: "0 0 24px rgba(255, 77, 109, 0.18)",
            }}
          />
          <span
            className="absolute inset-1 rounded-full border border-rose-400/60 motion-reduce:hidden"
            style={{
              animation: "splash-pulse 1800ms ease-in-out infinite 600ms",
            }}
          />
          {/* Reduced-motion fallback: a single static ring. */}
          <span
            className="absolute inset-0 hidden rounded-full border border-rose-400/50 motion-reduce:block"
            style={{ boxShadow: "0 0 16px rgba(255, 77, 109, 0.15)" }}
          />
        </div>
        <span className="text-[10px] uppercase tracking-[0.3em] text-white/40">
          gallery.divass.space
        </span>
      </div>
    </div>
  );
}
