import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRateLimiter } from "@/lib/rateLimiter";

describe("rateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows N hits in the window then blocks the next", () => {
    vi.setSystemTime(new Date("2026-05-11T00:00:00Z"));
    const rl = createRateLimiter({ max: 6, windowMs: 60_000 });
    for (let i = 0; i < 6; i++) expect(rl.allow("tok")).toBe(true);
    expect(rl.allow("tok")).toBe(false);
  });

  it("refills after the window slides", () => {
    vi.setSystemTime(new Date("2026-05-11T00:00:00Z"));
    const rl = createRateLimiter({ max: 6, windowMs: 60_000 });
    for (let i = 0; i < 6; i++) rl.allow("tok");
    expect(rl.allow("tok")).toBe(false);
    vi.setSystemTime(new Date("2026-05-11T00:01:01Z"));
    expect(rl.allow("tok")).toBe(true);
  });

  it("tracks keys independently", () => {
    vi.setSystemTime(new Date("2026-05-11T00:00:00Z"));
    const rl = createRateLimiter({ max: 2, windowMs: 60_000 });
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(false);
    expect(rl.allow("b")).toBe(true);
  });

  it("does not consume budget on a blocked hit (no penalty for being blocked)", () => {
    vi.setSystemTime(new Date("2026-05-11T00:00:00Z"));
    const rl = createRateLimiter({ max: 2, windowMs: 60_000 });
    rl.allow("k");
    rl.allow("k");
    expect(rl.allow("k")).toBe(false);
    // 30s later — still in the same window, still 2 hits, still blocked.
    vi.setSystemTime(new Date("2026-05-11T00:00:30Z"));
    expect(rl.allow("k")).toBe(false);
    // Past the window — both hits expire, fresh budget.
    vi.setSystemTime(new Date("2026-05-11T00:01:01Z"));
    expect(rl.allow("k")).toBe(true);
  });
});
