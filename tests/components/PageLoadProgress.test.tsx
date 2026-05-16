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
  progressRatio,
  progressReducer,
} from "@/components/gallery/PageLoadProgress";

describe("progressReducer", () => {
  it("register bumps the expected total", () => {
    const a = progressReducer({ registered: 0, loaded: 0 }, { kind: "register" });
    const b = progressReducer(a, { kind: "register" });
    expect(b).toEqual({ registered: 2, loaded: 0 });
  });

  it("loaded bumps the resolved count without exceeding the ceiling", () => {
    const initial = { registered: 2, loaded: 0 };
    const after1 = progressReducer(initial, { kind: "loaded" });
    expect(after1).toEqual({ registered: 2, loaded: 1 });
    const after2 = progressReducer(after1, { kind: "loaded" });
    expect(after2).toEqual({ registered: 2, loaded: 2 });
    // Stray over-report — a duplicate onLoad would otherwise blow past the
    // ceiling. The reducer clamps so the bar still pins to 100%.
    const after3 = progressReducer(after2, { kind: "loaded" });
    expect(after3).toEqual({ registered: 2, loaded: 2 });
  });

  it("reset restores the zero state", () => {
    const dirty = { registered: 7, loaded: 3 };
    expect(progressReducer(dirty, { kind: "reset" })).toEqual({
      registered: 0,
      loaded: 0,
    });
  });

  it("register + loaded interleaving converges to a saturated counter", () => {
    let s = { registered: 0, loaded: 0 };
    const seq: Array<"register" | "loaded"> = [
      "register",
      "register",
      "loaded",
      "register",
      "loaded",
      "loaded",
    ];
    for (const k of seq) s = progressReducer(s, { kind: k });
    expect(s).toEqual({ registered: 3, loaded: 3 });
  });
});

describe("progressRatio", () => {
  it("returns 1 when nothing is registered (empty-album shortcut)", () => {
    expect(progressRatio({ registered: 0, loaded: 0 })).toBe(1);
    // Even if some loaded count slipped in (shouldn't happen, but a
    // defence-in-depth guard) the ratio still pins to 1 — the consumer
    // hides the bar anyway because registered is 0.
    expect(progressRatio({ registered: 0, loaded: 5 })).toBe(1);
  });

  it("returns 0 before any photo has resolved", () => {
    expect(progressRatio({ registered: 4, loaded: 0 })).toBe(0);
  });

  it("returns the fraction loaded / registered", () => {
    expect(progressRatio({ registered: 4, loaded: 1 })).toBeCloseTo(0.25, 5);
    expect(progressRatio({ registered: 4, loaded: 3 })).toBeCloseTo(0.75, 5);
  });

  it("clamps to 1 when the resolved count overshoots (defensive)", () => {
    // progressReducer prevents this from happening in practice, but the
    // ratio function is a separate pure helper — keep it robust.
    expect(progressRatio({ registered: 2, loaded: 3 })).toBe(1);
  });

  it("returns exactly 1 at full progress (so the consumer can schedule fade-out reliably)", () => {
    expect(progressRatio({ registered: 8, loaded: 8 })).toBe(1);
  });
});
