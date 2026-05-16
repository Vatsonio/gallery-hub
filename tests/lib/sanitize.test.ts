import { describe, expect, it } from "vitest";
import {
  FALLBACK_FILENAME,
  MAX_FILENAME_LENGTH,
  sanitizeFilename,
} from "@/lib/sanitize";

describe("sanitizeFilename — F7 filename injection", () => {
  describe("path traversal", () => {
    it("strips POSIX parent-dir prefixes", () => {
      expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    });

    it("strips Windows parent-dir prefixes", () => {
      expect(sanitizeFilename("..\\..\\Windows\\System32\\config")).toBe("config");
    });

    it("strips mixed-separator traversal", () => {
      expect(sanitizeFilename("../foo\\..\\bar/baz.jpg")).toBe("baz.jpg");
    });

    it("strips bare `..`", () => {
      expect(sanitizeFilename("..")).toBe(FALLBACK_FILENAME);
    });

    it("strips `....`", () => {
      expect(sanitizeFilename("....")).toBe(FALLBACK_FILENAME);
    });

    it("strips absolute POSIX paths", () => {
      expect(sanitizeFilename("/etc/passwd")).toBe("passwd");
    });

    it("strips absolute Windows paths", () => {
      expect(sanitizeFilename("C:\\Users\\admin\\secret.txt")).toBe("secret.txt");
    });

    it("strips Windows drive letter when no path components follow", () => {
      expect(sanitizeFilename("C:secret")).toBe("secret");
    });

    it("strips UNC-style prefixes", () => {
      // After splitting on \, only the final segment survives.
      expect(sanitizeFilename("\\\\server\\share\\file.jpg")).toBe("file.jpg");
    });
  });

  describe("control characters", () => {
    it("strips NUL bytes", () => {
      expect(sanitizeFilename("foo\x00.jpg")).toBe("foo.jpg");
    });

    it("strips ASCII control chars 0x01..0x1f", () => {
      expect(sanitizeFilename("foo\x01\x02\x1f.jpg")).toBe("foo.jpg");
    });

    it("strips DEL (0x7f)", () => {
      expect(sanitizeFilename("foo\x7f.jpg")).toBe("foo.jpg");
    });

    it("strips CR/LF (header-injection class)", () => {
      expect(sanitizeFilename("foo\r\nbar.jpg")).toBe("foobar.jpg");
    });

    it("collapses embedded newlines after control-char strip", () => {
      // \r and \n are control chars and get stripped before whitespace collapse.
      expect(sanitizeFilename("a\tb.jpg")).toBe("ab.jpg");
    });
  });

  describe("leading / trailing dots and spaces", () => {
    it("strips leading dot (hidden file)", () => {
      expect(sanitizeFilename(".env")).toBe("env");
    });

    it("strips multiple leading dots", () => {
      expect(sanitizeFilename("...secret.jpg")).toBe("secret.jpg");
    });

    it("strips trailing dots (Windows compat)", () => {
      expect(sanitizeFilename("foo.exe.")).toBe("foo.exe");
    });

    it("strips trailing whitespace", () => {
      expect(sanitizeFilename("foo.jpg   ")).toBe("foo.jpg");
    });

    it("strips trailing mixed dots and spaces", () => {
      expect(sanitizeFilename("foo.jpg .. ")).toBe("foo.jpg");
    });
  });

  describe("length", () => {
    it("caps very long names while preserving extension", () => {
      const longBase = "a".repeat(MAX_FILENAME_LENGTH + 50);
      const out = sanitizeFilename(`${longBase}.jpg`);
      expect(out.length).toBe(MAX_FILENAME_LENGTH);
      expect(out.endsWith(".jpg")).toBe(true);
    });

    it("hard-truncates when extension is implausibly long", () => {
      // Total > MAX, but the last dot is far from the end so the "preserve
      // ext" branch shouldn't fire — we should just hard-truncate.
      const head = "a".repeat(MAX_FILENAME_LENGTH);
      const tail = ".x".repeat(50); // dot is ~99 chars from the end
      const out = sanitizeFilename(head + tail);
      expect(out.length).toBe(MAX_FILENAME_LENGTH);
    });

    it("leaves short names alone", () => {
      expect(sanitizeFilename("DSC_0001.jpg")).toBe("DSC_0001.jpg");
    });
  });

  describe("unicode normalization", () => {
    it("normalizes NFD → NFC", () => {
      // "é" as U+0065 + U+0301 (decomposed) vs U+00E9 (composed).
      const decomposed = "éclair.jpg";
      const composed = "éclair.jpg";
      expect(sanitizeFilename(decomposed)).toBe(composed);
    });

    it("preserves non-ASCII letters", () => {
      expect(sanitizeFilename("写真.jpg")).toBe("写真.jpg");
    });
  });

  describe("empty / non-string fallback", () => {
    it("falls back on empty string", () => {
      expect(sanitizeFilename("")).toBe(FALLBACK_FILENAME);
    });

    it("falls back on whitespace-only", () => {
      expect(sanitizeFilename("   ")).toBe(FALLBACK_FILENAME);
    });

    it("falls back on dots-only after strip", () => {
      expect(sanitizeFilename("...")).toBe(FALLBACK_FILENAME);
    });

    it("falls back on null", () => {
      expect(sanitizeFilename(null)).toBe(FALLBACK_FILENAME);
    });

    it("falls back on undefined", () => {
      expect(sanitizeFilename(undefined)).toBe(FALLBACK_FILENAME);
    });

    it("falls back on number", () => {
      expect(sanitizeFilename(42)).toBe(FALLBACK_FILENAME);
    });

    it("falls back on object", () => {
      expect(sanitizeFilename({ name: "evil" })).toBe(FALLBACK_FILENAME);
    });
  });

  describe("invariants on adversarial input", () => {
    it("never contains a forward slash in output", () => {
      const out = sanitizeFilename("a/b/c/d/e.jpg");
      expect(out.includes("/")).toBe(false);
    });

    it("never contains a backslash in output", () => {
      const out = sanitizeFilename("a\\b\\c.jpg");
      expect(out.includes("\\")).toBe(false);
    });

    it("never starts with a dot", () => {
      const out = sanitizeFilename(".....\\....\\.hidden");
      expect(out.startsWith(".")).toBe(false);
    });

    it("never contains NUL", () => {
      const out = sanitizeFilename("a\x00b\x00c.jpg");
      expect(out.includes("\x00")).toBe(false);
    });

    it("preserves a reasonable original filename verbatim", () => {
      expect(sanitizeFilename("DSC_0001 (1).jpeg")).toBe("DSC_0001 (1).jpeg");
    });
  });
});
