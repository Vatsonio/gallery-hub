import { describe, it, expect } from "vitest";
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatEta,
  formatRate,
  formatRelativeTime,
} from "@/lib/format";

// Narrow no-break space used by formatCount for thousands grouping.
const NBSP = " ";

describe("formatCount", () => {
  it("returns the input unchanged below 1000", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(7)).toBe("7");
    expect(formatCount(999)).toBe("999");
  });

  it("groups thousands with a narrow no-break space", () => {
    expect(formatCount(1000)).toBe(`1${NBSP}000`);
    expect(formatCount(1247)).toBe(`1${NBSP}247`);
    expect(formatCount(1_234_567)).toBe(`1${NBSP}234${NBSP}567`);
  });

  it("handles negatives by prefixing the sign", () => {
    expect(formatCount(-12345)).toBe(`-12${NBSP}345`);
  });

  it("collapses nullish/NaN to 0", () => {
    expect(formatCount(null)).toBe("0");
    expect(formatCount(undefined)).toBe("0");
    expect(formatCount(Number.NaN)).toBe("0");
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("formatBytes", () => {
  it("uses B / KB / MB / GB scaled at 1000-base", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1500)).toBe("1.5 KB");
    expect(formatBytes(2_500_000)).toBe("2.5 MB");
    expect(formatBytes(3_400_000_000)).toBe("3.40 GB");
  });

  it("collapses garbage input to 0 B", () => {
    expect(formatBytes(null)).toBe("0 B");
    expect(formatBytes(undefined)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("formatDuration", () => {
  it("renders m:ss for sub-hour input", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(42)).toBe("0:42");
    expect(formatDuration(180)).toBe("3:00");
    expect(formatDuration(3599)).toBe("59:59");
  });

  it("rotates to h:mm:ss beyond one hour", () => {
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(3725)).toBe("1:02:05");
  });

  it("clamps non-finite/negative to 0:00", () => {
    expect(formatDuration(-5)).toBe("0:00");
    expect(formatDuration(Number.NaN)).toBe("0:00");
    expect(formatDuration(null)).toBe("0:00");
  });
});

describe("formatRate", () => {
  it("appends /s and reuses byte scaling", () => {
    expect(formatRate(8_400_000)).toBe("8.4 MB/s");
    expect(formatRate(1500)).toBe("1.5 KB/s");
  });

  it("collapses zero/garbage to 0 B/s", () => {
    expect(formatRate(0)).toBe("0 B/s");
    expect(formatRate(-1)).toBe("0 B/s");
    expect(formatRate(null)).toBe("0 B/s");
  });
});

describe("formatEta", () => {
  it("returns null for non-finite input so callers can hide the row", () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(Number.NaN)).toBeNull();
    expect(formatEta(-3)).toBeNull();
  });

  it("returns a sub-second floor near completion", () => {
    expect(formatEta(0)).toBe("<1 sec remaining");
    expect(formatEta(0.4)).toBe("<1 sec remaining");
  });

  it("renders a tilded duration otherwise", () => {
    expect(formatEta(138)).toBe("~2:18 remaining");
    expect(formatEta(3661)).toBe("~1:01:01 remaining");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-05-12T12:00:00Z").getTime();

  it("renders sub-5-second deltas as 'just now'", () => {
    expect(formatRelativeTime(new Date(now - 3000), now)).toBe("just now");
  });

  it("renders sec / min / hour / day / month / year tiers", () => {
    expect(formatRelativeTime(new Date(now - 30_000), now)).toBe("30 sec ago");
    expect(formatRelativeTime(new Date(now - 5 * 60_000), now)).toBe("5 min ago");
    expect(formatRelativeTime(new Date(now - 2 * 3_600_000), now)).toBe("2h ago");
    expect(formatRelativeTime(new Date(now - 3 * 86_400_000), now)).toBe("3d ago");
    expect(formatRelativeTime(new Date(now - 45 * 86_400_000), now)).toBe("2 mo ago");
    expect(formatRelativeTime(new Date(now - 400 * 86_400_000), now)).toBe("1y ago");
  });

  it("accepts ISO strings as well as Date objects", () => {
    expect(formatRelativeTime("2026-05-12T11:59:30Z", now)).toBe("30 sec ago");
  });

  it("guards against bad input + future dates", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("unknown");
    expect(formatRelativeTime(new Date(now + 60_000), now)).toBe("in the future");
  });
});
