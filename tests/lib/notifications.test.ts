import { describe, it, expect } from "vitest";
import {
  escapeMarkdownV2,
  hourBucket,
  minuteBucket,
} from "@/lib/notifications";

describe("escapeMarkdownV2", () => {
  it("escapes every reserved char from the Telegram spec", () => {
    const reserved = "_*[]()~`>#+-=|{}.!\\";
    const out = escapeMarkdownV2(reserved);
    // Each char should be prefixed with a single backslash.
    for (const c of reserved) {
      expect(out).toContain(`\\${c}`);
    }
  });

  it("leaves plain text alone", () => {
    expect(escapeMarkdownV2("Hello world")).toBe("Hello world");
  });

  it("escapes embedded reserved chars in mixed content", () => {
    // Colon is NOT reserved by MarkdownV2 (only the 18 chars in the spec
    // are). Parens and the dot ARE.
    const out = escapeMarkdownV2("Wedding (2025): final.jpg");
    expect(out).toBe("Wedding \\(2025\\): final\\.jpg");
  });

  it("escapes the backslash itself (so payloads round-trip)", () => {
    const out = escapeMarkdownV2("a\\b");
    expect(out).toBe("a\\\\b");
  });

  it("is idempotent over an already-safe string", () => {
    const out = escapeMarkdownV2(escapeMarkdownV2("alpha"));
    expect(out).toBe("alpha");
  });
});

describe("hourBucket / minuteBucket — dedup-key stability", () => {
  it("collapses two timestamps in the same hour to the same key", () => {
    const a = new Date("2026-05-12T14:03:11Z");
    const b = new Date("2026-05-12T14:59:59Z");
    expect(hourBucket(a)).toBe(hourBucket(b));
    expect(hourBucket(a)).toBe("2026-05-12T14:00:00Z");
  });

  it("rolls over at the hour boundary", () => {
    const a = new Date("2026-05-12T14:59:59Z");
    const b = new Date("2026-05-12T15:00:00Z");
    expect(hourBucket(a)).not.toBe(hourBucket(b));
  });

  it("minuteBucket is finer-grained than hourBucket", () => {
    const a = new Date("2026-05-12T14:03:11Z");
    const b = new Date("2026-05-12T14:04:59Z");
    expect(minuteBucket(a)).not.toBe(minuteBucket(b));
    expect(hourBucket(a)).toBe(hourBucket(b));
  });
});
