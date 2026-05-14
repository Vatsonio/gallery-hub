import { describe, it, expect } from "vitest";
import { escapeMarkdownV2 } from "@/lib/notifications";

/**
 * Telegram MarkdownV2 has strict escaping rules. These tests pin the
 * exact characters that must be backslash-prefixed before the body is
 * sent to `sendMessage(parse_mode='MarkdownV2')`.
 *
 * Per https://core.telegram.org/bots/api#markdownv2-style: the reserved
 * characters are: `_ * [ ] ( ) ~ ` > # + - = | { } . !` plus `\`. Failing
 * to escape any of them causes a 400 from the Telegram API.
 */
describe("MarkdownV2 escape — character-by-character", () => {
  const reserved = "_*[]()~`>#+-=|{}.!\\";
  for (const c of reserved) {
    it(`escapes \`${c}\` with a leading backslash`, () => {
      const out = escapeMarkdownV2(`pre${c}post`);
      expect(out).toBe(`pre\\${c}post`);
    });
  }
});

describe("MarkdownV2 escape — payload-shape scenarios", () => {
  it("safely embeds an album title with parens and a period", () => {
    const title = "Wedding (Highlights). vol. 1";
    const out = `_${escapeMarkdownV2(title)}_`;
    expect(out).toBe("_Wedding \\(Highlights\\)\\. vol\\. 1_");
  });

  it("preserves spaces", () => {
    expect(escapeMarkdownV2("hello there")).toBe("hello there");
  });

  it("handles unicode (Cyrillic + emoji) without escaping them", () => {
    const out = escapeMarkdownV2("Привіт 👋 Chikaq");
    expect(out).toBe("Привіт 👋 Chikaq");
  });

  it("escapes hyphens in viewer-id slices", () => {
    const out = escapeMarkdownV2("a1b2-c3d4");
    expect(out).toBe("a1b2\\-c3d4");
  });

  it("escapes underscore (Telegram parses _italic_)", () => {
    const out = escapeMarkdownV2("user_name");
    expect(out).toBe("user\\_name");
  });

  it("does not escape characters that aren't reserved", () => {
    const out = escapeMarkdownV2("ABCabc0123/&%@");
    expect(out).toBe("ABCabc0123/&%@");
  });
});
