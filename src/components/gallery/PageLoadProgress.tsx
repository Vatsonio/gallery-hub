"use client";

/**
 * Top-of-viewport progress bar that tracks "is the page visually ready yet?"
 *
 * The share page renders dozens of <img> tags that go from "blob in flight"
 * to "displayed". Until the above-the-fold images land, the visitor sees a
 * grid of thumbhash placeholders and the cover hero is still decoding —
 * a brittle moment where there is no other affordance signalling progress.
 * We bridge that gap with a thin rose-tinted bar at the very top of the
 * viewport that fills from 0% to 100% as the critical-render set lands.
 *
 * Tracked set: only the first N photos (currently 30) plus the cover hero.
 * Photos further down the grid are skipped because they may never enter
 * the viewport (lazy loading) — including them would freeze the bar at
 * 90-something % forever. The N=30 budget matches a typical first-screen
 * 4-row × 4-column desktop layout and is plenty for a phone.
 *
 * Animation:
 *   - bar uses `transform: scaleX(N)` with `transform-origin: left` so the
 *     fill is GPU-composited
 *   - 200ms cubic-bezier(0.4, 0, 0.2, 1) easing
 *   - once 100%: holds 300ms, fades out (opacity 1→0 over 200ms)
 *   - prefers-reduced-motion: transitions become instant
 *
 * Empty-album shortcut: when `expectedTotal` resolves to 0, the bar never
 * renders (no work to track).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface Counter {
  registered: number;
  loaded: number;
}

type Action =
  | { kind: "register" }
  | { kind: "loaded" }
  | { kind: "reset" };

/**
 * Pure reducer driving the progress counter. Extracted so the unit test
 * can exercise the math without rendering a component tree (the project
 * deliberately avoids @testing-library/react to keep deps lean).
 *
 * Invariants:
 *   - `loaded` never exceeds `registered` (a stray over-report from a
 *     double onLoad fire saturates at the ceiling rather than overflowing)
 *   - `registered` and `loaded` are monotonically non-decreasing until a
 *     `reset` (e.g. when the share page is reused across navigations)
 */
export function progressReducer(prev: Counter, action: Action): Counter {
  switch (action.kind) {
    case "register":
      return { ...prev, registered: prev.registered + 1 };
    case "loaded":
      return {
        ...prev,
        loaded: Math.min(prev.registered, prev.loaded + 1),
      };
    case "reset":
      return { registered: 0, loaded: 0 };
  }
}

/**
 * Resolve the fill ratio from the counter. Returns 0..1.
 *
 * - When `registered === 0`, there is nothing to track and the bar is
 *   "complete" (1.0) so the consumer can skip rendering or fade out
 *   immediately. We choose 1.0 instead of 0 because every consumer that
 *   sees 0 photos has nothing to show anyway.
 * - Otherwise, ratio = loaded / registered, clamped into 0..1.
 */
export function progressRatio(counter: Counter): number {
  if (counter.registered <= 0) return 1;
  const r = counter.loaded / counter.registered;
  if (r <= 0) return 0;
  if (r >= 1) return 1;
  return r;
}

/**
 * Decide whether the stall safety net should snap the bar to 100%.
 *
 * Centralizes the policy so it can be exercised from a unit test
 * without needing fake timers + a renderer. The provider component
 * encodes the same predicate inline (with a real setTimeout), so we
 * keep this helper authoritative for the rules.
 *
 * Inputs:
 *   - `enabled`: false when there's no gallery to track (empty album).
 *   - `counter`: live counter snapshot.
 *   - `msSinceLastProgress`: elapsed ms since the last register/loaded.
 *   - `thresholdMs`: how long to wait before snapping.
 *
 * Snap conditions (all must hold):
 *   - feature enabled
 *   - something has registered (otherwise nothing to snap to)
 *   - we're not already complete (loaded < registered)
 *   - we've been silent for at least `thresholdMs`
 */
export function shouldForceComplete(
  enabled: boolean,
  counter: Counter,
  msSinceLastProgress: number,
  thresholdMs: number,
): boolean {
  if (!enabled) return false;
  if (counter.registered <= 0) return false;
  if (counter.loaded >= counter.registered) return false;
  return msSinceLastProgress >= thresholdMs;
}

export interface PhotoLoadProgressApi {
  /**
   * Mount-time call — bumps the expected total. Pair with one
   * `reportLoaded()` call once the image lands (or errors). Callers MUST
   * call exactly once per tile or the counter slides off.
   */
  register: () => void;
  /** Fired by an image's onLoad or onError to mark its slot resolved. */
  reportLoaded: () => void;
}

// Default no-op context — lets tiles outside a provider mount safely
// (e.g. when the lightbox renders <img> tags outside the gallery shell).
const PhotoLoadContext = createContext<PhotoLoadProgressApi>({
  register: () => {},
  reportLoaded: () => {},
});

export function usePhotoLoadProgress(): PhotoLoadProgressApi {
  return useContext(PhotoLoadContext);
}

interface ProviderProps {
  /**
   * Hard cap on how many tiles can register. Once reached, further
   * register() calls become no-ops. Combined with the cover hero, this
   * is the "critical-render set" size — see file docblock.
   */
  cap: number;
  /** Whether the page has any photos at all. Empty albums hide the bar. */
  enabled: boolean;
  children: ReactNode;
}

/**
 * Maximum time, in ms, the bar will wait for stalled images before
 * snapping itself to 100%. Aggressive enough that a hung CDN or a
 * blocked imgproxy request can't freeze the bar forever, but generous
 * enough that a slow 3G first paint still completes naturally.
 */
const STALL_TIMEOUT_MS = 10_000;

/**
 * Provider + visible progress bar in one. Keeps state local — the parent
 * gallery shell mounts it once and any descendant tile picks up the
 * api via usePhotoLoadProgress().
 */
export default function PageLoadProgress({ cap, enabled, children }: ProviderProps) {
  const [counter, dispatch] = useReducer(progressReducer, { registered: 0, loaded: 0 });
  const registeredRef = useRef(0);
  // Once the bar has reached 100% AND faded, we stop rendering. The grace
  // window is the holdDelay (300ms) + fade duration (200ms) ≈ 500ms.
  const [done, setDone] = useState(false);
  // Forced 100% latch — flipped by the stall safety net so the bar fills
  // even if the underlying counter is still mid-way.
  const [forceComplete, setForceComplete] = useState(false);

  const register = useCallback(() => {
    if (registeredRef.current >= cap) return;
    registeredRef.current += 1;
    dispatch({ kind: "register" });
  }, [cap]);

  const reportLoaded = useCallback(() => {
    dispatch({ kind: "loaded" });
  }, []);

  // Honest ratio derived from counters. The visible ratio (below) is
  // max(honest, 1 if forceComplete) so the safety-net snap is purely
  // additive — a normally-resolving page never sees this branch.
  const honestRatio = progressRatio(counter);
  const ratio = forceComplete ? 1 : honestRatio;

  // Safety net: if no progress arrives for STALL_TIMEOUT_MS after the
  // first register, snap to 100%. This covers the edge case where an
  // <img> never fires onLoad/onError (cached image race + missed
  // listener, or a tile that registered but whose request was aborted by
  // the browser). Without this, the bar would freeze below 100% forever
  // and the user would think the page is still loading.
  //
  // Policy is delegated to `shouldForceComplete` so the same predicate
  // can be exercised from a unit test without a renderer or fake timers.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (shouldForceComplete(enabled, counter, STALL_TIMEOUT_MS, STALL_TIMEOUT_MS)) {
        setForceComplete(true);
      }
    }, STALL_TIMEOUT_MS);
    return () => window.clearTimeout(t);
    // Re-arm whenever `loaded` advances — a tile resolving resets the
    // stall clock to give the next one its full budget.
  }, [enabled, counter, counter.registered, counter.loaded]);

  // Effect: schedule fade-out once the ratio hits 1. We deliberately do
  // this in an effect (not inline during render) so the bar finishes its
  // animation to 100% before unmounting.
  useEffect(() => {
    if (!enabled) {
      setDone(true);
      return;
    }
    if (ratio < 1) {
      // Not done yet — make sure we stay visible.
      setDone(false);
      return;
    }
    if (counter.registered === 0) {
      // No photos arrived (very fast empty render). Hide immediately.
      setDone(true);
      return;
    }
    // Hold at 100% briefly so the user perceives the fill, then fade.
    const t = window.setTimeout(() => setDone(true), 500);
    return () => window.clearTimeout(t);
  }, [ratio, counter.registered, enabled]);

  const api = useMemo<PhotoLoadProgressApi>(
    () => ({ register, reportLoaded }),
    [register, reportLoaded],
  );

  const showBar = enabled && counter.registered > 0 && !done;

  return (
    <PhotoLoadContext.Provider value={api}>
      {showBar ? (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5"
          data-testid="page-load-progress"
        >
          <div
            className="h-full origin-left bg-rose-400/90 transition-transform duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none"
            style={{
              transform: `scaleX(${ratio})`,
              opacity: ratio >= 1 ? 0 : 1,
              transition:
                ratio >= 1
                  ? "transform 200ms cubic-bezier(0.4,0,0.2,1), opacity 200ms ease-out 300ms"
                  : "transform 200ms cubic-bezier(0.4,0,0.2,1)",
            }}
          />
        </div>
      ) : null}
      {children}
    </PhotoLoadContext.Provider>
  );
}
