/**
 * Unit tests for the export-route pre-flight helper used by
 * ExportModal. The helper is a thin wrapper around the fetch API +
 * JSON parsing; tests mock `globalThis.fetch` and assert the four
 * decision branches:
 *
 *   - 204 No Content → null (download is OK to start)
 *   - 4xx JSON body  → ProbeError with the server's reason + message
 *   - 4xx text body  → fallback unknown reason
 *   - network error  → fallback network reason
 *
 * No DOM, no React — the helper is pure logic over fetch().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeExport } from "@/components/gallery/ExportModal";

function mockFetch(impl: typeof fetch): void {
  // `globalThis.fetch` is the right hook for both Node 20 + jsdom.
  // We re-assign rather than spyOn because the type alias is the
  // signature, not an existing property descriptor we can wrap.
  globalThis.fetch = impl as typeof fetch;
}

function makeResponse(
  status: number,
  body: string,
  contentType = "application/json",
): Response {
  // Node's Response constructor refuses a body for null-body status
  // codes (204/205/304). Mirror the spec: empty body, no Content-Type.
  if (status === 204 || status === 205 || status === 304) {
    return new Response(null, { status });
  }
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
  });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("probeExport", () => {
  it("returns null on a 204 (download will succeed)", async () => {
    mockFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("/api/export/tok123");
      expect(url).toContain("probe=1");
      expect(url).toContain("scope=all");
      expect(url).toContain("variant=original");
      return makeResponse(204, "");
    });
    const out = await probeExport("tok123", "all", "original");
    expect(out).toBeNull();
  });

  it("surfaces the server's JSON {reason,message} on a structured 4xx", async () => {
    mockFetch(async () =>
      makeResponse(
        404,
        JSON.stringify({
          reason: "no_favorites",
          message: "Like some photos first to enable a favorites export.",
        }),
      ),
    );
    const out = await probeExport("tok123", "favorites", "original");
    expect(out).not.toBeNull();
    expect(out!.reason).toBe("no_favorites");
    expect(out!.message).toMatch(/like some photos/i);
  });

  it("distinguishes the admin-preview reason so the UI can suggest a private window", async () => {
    mockFetch(async () =>
      makeResponse(
        404,
        JSON.stringify({
          reason: "admin_preview_no_favorites",
          message:
            "Admin previews can't favorite photos. Open the link in a private window to test as a visitor.",
        }),
      ),
    );
    const out = await probeExport("tok123", "favorites", "original");
    expect(out!.reason).toBe("admin_preview_no_favorites");
    expect(out!.message).toMatch(/private window/i);
  });

  it("falls back to an unknown reason when the server returns plain text", async () => {
    mockFetch(async () => makeResponse(500, "internal error", "text/plain"));
    const out = await probeExport("tok123", "all", "original");
    expect(out!.reason).toBe("unknown");
    expect(out!.message).toMatch(/internal error|HTTP 500/);
  });

  it("falls back to a network reason when fetch throws", async () => {
    mockFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const out = await probeExport("tok123", "all", "original");
    expect(out!.reason).toBe("network");
    expect(out!.message).toMatch(/try again/i);
  });

  it("guards against malformed JSON (server says JSON content-type but body is broken)", async () => {
    mockFetch(async () => makeResponse(503, "{not valid json"));
    const out = await probeExport("tok123", "all", "original");
    expect(out!.reason).toBe("unknown");
    // The raw text propagates so a future log line can capture what
    // actually came back.
    expect(out!.message).toContain("{not valid json");
  });
});
