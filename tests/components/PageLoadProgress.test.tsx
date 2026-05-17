/**
 * Unit tests for the page-load progress state machine.
 *
 * The component itself is a thin DOM/transition wrapper around two pure
 * helpers (progressReducer + progressRatio). Exercising those gives us
 * the math coverage the spec asked for without pulling
 * @testing-library/react — the project deliberately avoids a renderer
 * and tests state machines through their pure-function entry points.
 */
import { describe, it, expect } from "vitest";
import {
  INITIAL_COUNTER,
  progressRatio,
  progressReducer,
  shouldDismissSplash,
  shouldForceComplete,
  SPLASH_CRITICAL_TILE_TARGET,
} from "@/components/gallery/PageLoadProgress";

/**
 * Convenience factory — lifts a partial counter shape into the full
 * `Counter` (with cover flags defaulted to false). Keeps these tests
 * focused on the field they actually exercise.
 */
function c(
  partial: Partial<{
    registered: number;
    loaded: number;
    coverRegistered: boolean;
    coverLoaded: boolean;
  }>,
) {
  return { ...INITIAL_COUNTER, ...partial };
}

describe("progressReducer", () => {
  it("register bumps the expected total", () => {
    const a = progressReducer(INITIAL_COUNTER, { kind: "register" });
    const b = progressReducer(a, { kind: "register" });
    expect(b).toEqual(c({ registered: 2 }));
  });

  it("loaded bumps the resolved count without exceeding the ceiling", () => {
    const initial = c({ registered: 2 });
    const after1 = progressReducer(initial, { kind: "loaded" });
    expect(after1).toEqual(c({ registered: 2, loaded: 1 }));
    const after2 = progressReducer(after1, { kind: "loaded" });
    expect(after2).toEqual(c({ registered: 2, loaded: 2 }));
    // Stray over-report — a duplicate onLoad would otherwise blow past the
    // ceiling. The reducer clamps so the bar still pins to 100%.
    const after3 = progressReducer(after2, { kind: "loaded" });
    expect(after3).toEqual(c({ registered: 2, loaded: 2 }));
  });

  it("reset restores the zero state including cover flags", () => {
    const dirty = c({
      registered: 7,
      loaded: 3,
      coverRegistered: true,
      coverLoaded: true,
    });
    expect(progressReducer(dirty, { kind: "reset" })).toEqual(INITIAL_COUNTER);
  });

  it("register + loaded interleaving converges to a saturated counter", () => {
    let s = INITIAL_COUNTER;
    const seq: Array<"register" | "loaded"> = [
      "register",
      "register",
      "loaded",
      "register",
      "loaded",
      "loaded",
    ];
    for (const k of seq) s = progressReducer(s, { kind: k });
    expect(s).toEqual(c({ registered: 3, loaded: 3 }));
  });

  it("registerCover is idempotent — replaying does not flip flags off", () => {
    const once = progressReducer(INITIAL_COUNTER, { kind: "registerCover" });
    expect(once.coverRegistered).toBe(true);
    const twice = progressReducer(once, { kind: "registerCover" });
    expect(twice).toBe(once); // referentially equal — no churn for subscribers
  });

  it("loadedCover marks the cover resolved exactly once", () => {
    const a = progressReducer(INITIAL_COUNTER, { kind: "registerCover" });
    const b = progressReducer(a, { kind: "loadedCover" });
    expect(b.coverLoaded).toBe(true);
    // Replays must be no-ops so a duplicate onLoad firing after onError
    // (or vice-versa) doesn't churn React's reducer state.
    const c2 = progressReducer(b, { kind: "loadedCover" });
    expect(c2).toBe(b);
  });
});

describe("progressRatio", () => {
  it("returns 1 when nothing is registered (empty-album shortcut)", () => {
    expect(progressRatio(c({}))).toBe(1);
    // Even if some loaded count slipped in (shouldn't happen, but a
    // defence-in-depth guard) the ratio still pins to 1 — the consumer
    // hides the bar anyway because registered is 0.
    expect(progressRatio(c({ loaded: 5 }))).toBe(1);
  });

  it("returns 0 before any photo has resolved", () => {
    expect(progressRatio(c({ registered: 4 }))).toBe(0);
  });

  it("returns the fraction loaded / registered", () => {
    expect(progressRatio(c({ registered: 4, loaded: 1 }))).toBeCloseTo(0.25, 5);
    expect(progressRatio(c({ registered: 4, loaded: 3 }))).toBeCloseTo(0.75, 5);
  });

  it("clamps to 1 when the resolved count overshoots (defensive)", () => {
    // progressReducer prevents this from happening in practice, but the
    // ratio function is a separate pure helper — keep it robust.
    expect(progressRatio(c({ registered: 2, loaded: 3 }))).toBe(1);
  });

  it("returns exactly 1 at full progress (so the consumer can schedule fade-out reliably)", () => {
    expect(progressRatio(c({ registered: 8, loaded: 8 }))).toBe(1);
  });
});

describe("shouldForceComplete (stall safety net)", () => {
  const THRESHOLD = 10_000;

  it("does not snap before the threshold elapses (slow first paint stays honest)", () => {
    expect(
      shouldForceComplete(true, c({ registered: 5, loaded: 2 }), 9_999, THRESHOLD),
    ).toBe(false);
  });

  it("snaps once the threshold elapses with progress stuck below 100%", () => {
    expect(
      shouldForceComplete(true, c({ registered: 5, loaded: 2 }), 10_000, THRESHOLD),
    ).toBe(true);
    expect(
      shouldForceComplete(true, c({ registered: 5, loaded: 4 }), 30_000, THRESHOLD),
    ).toBe(true);
  });

  it("never snaps when the bar is already at 100% — nothing to rescue", () => {
    expect(
      shouldForceComplete(true, c({ registered: 5, loaded: 5 }), 30_000, THRESHOLD),
    ).toBe(false);
  });

  it("never snaps when no tile has registered (empty album)", () => {
    expect(
      shouldForceComplete(true, c({}), 30_000, THRESHOLD),
    ).toBe(false);
  });

  it("never snaps when disabled (provider sees zero photos overall)", () => {
    expect(
      shouldForceComplete(false, c({ registered: 5, loaded: 2 }), 30_000, THRESHOLD),
    ).toBe(false);
  });
});

describe("shouldDismissSplash (page-splash dismissal policy)", () => {
  const baseInputs = {
    enabled: true,
    minVisibleMs: 350,
    hardTimeoutMs: 6_000,
    criticalTileTarget: SPLASH_CRITICAL_TILE_TARGET, // 8
  };

  it("dismisses immediately when disabled (empty album — nothing to hide)", () => {
    // No min-visible delay, no waiting on anything — the consumer
    // should be able to skip rendering the splash from the first paint.
    expect(
      shouldDismissSplash({
        ...baseInputs,
        enabled: false,
        counter: INITIAL_COUNTER,
        msSinceMount: 0,
      }),
    ).toBe(true);
  });

  it("stays mounted before the minimum-visible time even when everything is ready", () => {
    // Cached repeat visit: cover loaded, all tiles loaded, only 50 ms
    // since mount. Must NOT flash a 50ms splash on the user; the
    // minimum 350ms floor enforces a deliberate-feeling pause.
    const counter = c({
      registered: 8,
      loaded: 8,
      coverRegistered: true,
      coverLoaded: true,
    });
    expect(
      shouldDismissSplash({ ...baseInputs, counter, msSinceMount: 50 }),
    ).toBe(false);
  });

  it("blocks dismissal while the cover hero is still loading", () => {
    // All 8 tiles ready, but the LCP cover hasn't fired onLoad yet —
    // dropping the splash now would expose a partially-painted page
    // where the most visually load-bearing asset is missing.
    const counter = c({
      registered: 8,
      loaded: 8,
      coverRegistered: true,
      coverLoaded: false,
    });
    expect(
      shouldDismissSplash({ ...baseInputs, counter, msSinceMount: 1_000 }),
    ).toBe(false);
  });

  it("dismisses once cover + first 8 tiles have resolved past min-visible-time", () => {
    const counter = c({
      registered: 32,
      loaded: 8,
      coverRegistered: true,
      coverLoaded: true,
    });
    expect(
      shouldDismissSplash({ ...baseInputs, counter, msSinceMount: 500 }),
    ).toBe(true);
  });

  it("for small albums, waits for all tiles instead of the fixed target", () => {
    // 3-photo album: target collapses from 8 → 3, dismiss after all
    // three resolve (cover also done).
    const stillLoading = c({
      registered: 3,
      loaded: 2,
      coverRegistered: true,
      coverLoaded: true,
    });
    expect(
      shouldDismissSplash({ ...baseInputs, counter: stillLoading, msSinceMount: 500 }),
    ).toBe(false);
    const allLoaded = c({
      registered: 3,
      loaded: 3,
      coverRegistered: true,
      coverLoaded: true,
    });
    expect(
      shouldDismissSplash({ ...baseInputs, counter: allLoaded, msSinceMount: 500 }),
    ).toBe(true);
  });

  it("hard timeout dismisses regardless of cover/tile state (prevents trap)", () => {
    // imgproxy stall: cover never resolved, no tile resolved. The
    // splash must dismiss anyway after the hard ceiling so the viewer
    // isn't trapped behind a blank page.
    const counter = c({
      registered: 8,
      loaded: 0,
      coverRegistered: true,
      coverLoaded: false,
    });
    expect(
      shouldDismissSplash({ ...baseInputs, counter, msSinceMount: 6_000 }),
    ).toBe(true);
    expect(
      shouldDismissSplash({ ...baseInputs, counter, msSinceMount: 6_500 }),
    ).toBe(true);
  });

  it("cover-only page (no tiles registered yet) dismisses after min time + cover load", () => {
    // Edge case: very small album where tiles haven't registered yet
    // by the time the splash evaluates. After min-visible-time elapses
    // AND the cover is loaded, the splash dismisses.
    const counter = c({
      coverRegistered: true,
      coverLoaded: true,
    });
    expect(
      shouldDismissSplash({ ...baseInputs, counter, msSinceMount: 400 }),
    ).toBe(true);
  });

  it("ignores cover gate when no cover was registered (no cover hero on page)", () => {
    // Layout fallback path: album with photos but no cover photo. The
    // splash should not block on a cover that was never registered.
    const counter = c({ registered: 8, loaded: 8 });
    expect(
      shouldDismissSplash({ ...baseInputs, counter, msSinceMount: 500 }),
    ).toBe(true);
  });
});
