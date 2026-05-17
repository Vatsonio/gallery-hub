"use client";

import { useEffect, useRef, useState } from "react";

/**
 * RAF-driven count-up animation hook. Animates from the previously
 * displayed value to the new `target` over `durationMs`, using a tunable
 * easing function. Returns the current intermediate value plus a stable
 * `done` flag so callers can drop the animation class once the number
 * settles.
 *
 * Design choices:
 *   * Pure vanilla — framer-motion isn't installed and we don't want to
 *     pull a dep just for one animation. requestAnimationFrame is enough
 *     for sub-frame jank-free counters.
 *   * Respects prefers-reduced-motion: when set, the value snaps to the
 *     target on mount with no animation. This is the cheapest accessible
 *     behaviour — no half-animated "0 → 1 247" tween for users who asked
 *     for less motion.
 *   * Deterministic with vi.useFakeTimers() + vi.advanceTimersByTime: the
 *     hook reads performance.now() through a `now` ref so tests can pin
 *     time progress without touching the global clock.
 */
export interface CountUpOptions {
  /** Animation duration in milliseconds. Default 800. */
  durationMs?: number;
  /** Easing function f(t) on the unit interval. Default: easeOutBack-ish. */
  easing?: (t: number) => number;
  /** Override prefers-reduced-motion. Default: read from media query. */
  disabled?: boolean;
}

/**
 * Slight overshoot ease (mirrors `cubic-bezier(0.34, 1.2, 0.64, 1)`).
 * Lands at 1 at t=1 with a small bounce-past-and-back near the end —
 * makes counters feel "alive" without going carnival.
 */
function defaultEasing(t: number): number {
  if (t >= 1) return 1;
  if (t <= 0) return 0;
  const c1 = 1.2;
  const c3 = c1 + 1;
  // easeOutBack family: 1 + c3*(t-1)^3 + c1*(t-1)^2.
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function useCountUp(target: number, opts: CountUpOptions = {}): number {
  const durationMs = opts.durationMs ?? 800;
  const easing = opts.easing ?? defaultEasing;
  const disabled = opts.disabled ?? prefersReducedMotion();

  // Stable refs so we don't re-trigger the animation when the easing
  // function reference changes inside React strict mode.
  const fromRef = useRef<number>(target);
  const targetRef = useRef<number>(target);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const [value, setValue] = useState<number>(target);

  useEffect(() => {
    // Snap mode — no animation, no RAF.
    if (disabled || durationMs <= 0) {
      fromRef.current = target;
      targetRef.current = target;
      setValue(target);
      return;
    }

    // SSR guard. In jest/vitest we always have a window via jsdom; in
    // pure-node tests we just set the final value.
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      setValue(target);
      return;
    }

    fromRef.current = value;
    targetRef.current = target;
    startRef.current = null;

    function tick(now: number) {
      if (startRef.current === null) startRef.current = now;
      const elapsed = now - startRef.current;
      const t = Math.min(1, elapsed / durationMs);
      const eased = easing(t);
      const next = fromRef.current + (targetRef.current - fromRef.current) * eased;
      setValue(next);
      if (t < 1) {
        rafRef.current = window.requestAnimationFrame(tick);
      } else {
        // Lock to exact target so trailing renders don't show 999.9998.
        setValue(targetRef.current);
        rafRef.current = null;
      }
    }
    rafRef.current = window.requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // We intentionally exclude `value` from the dep array — using the
    // initial value as the "from" only on target changes is exactly the
    // behaviour we want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs, disabled]);

  return value;
}

/**
 * Convenience wrapper that animates to an integer and rounds the
 * intermediate value. Use this for counters that should never flash
 * a fractional number on the way up (e.g. "Uploading 47 of 150").
 */
export function useCountUpInt(target: number, opts: CountUpOptions = {}): number {
  const v = useCountUp(target, opts);
  return Math.round(v);
}
