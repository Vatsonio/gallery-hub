import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLongPress } from "@/lib/long-press";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("createLongPress", () => {
  it("fires onLongPress after the configured delay if the pointer holds still", () => {
    const fn = vi.fn();
    const lp = createLongPress(fn, { delayMs: 500 });
    lp.onPointerDown({ clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(499);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancels if the pointer moves beyond tolerance", () => {
    const fn = vi.fn();
    const lp = createLongPress(fn, { delayMs: 500, tolerancePx: 8 });
    lp.onPointerDown({ clientX: 10, clientY: 10 });
    lp.onPointerMove({ clientX: 30, clientY: 10 });
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not fire if the pointer lifts before delay elapses", () => {
    const fn = vi.fn();
    const lp = createLongPress(fn, { delayMs: 500 });
    lp.onPointerDown({ clientX: 5, clientY: 5 });
    vi.advanceTimersByTime(200);
    lp.onPointerUp();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("ignores small jitter inside the tolerance window", () => {
    const fn = vi.fn();
    const lp = createLongPress(fn, { delayMs: 500, tolerancePx: 8 });
    lp.onPointerDown({ clientX: 100, clientY: 100 });
    lp.onPointerMove({ clientX: 103, clientY: 102 });
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
