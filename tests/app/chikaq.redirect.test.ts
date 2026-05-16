/**
 * Integration test: /chikaq must bounce unauthenticated requests to the
 * admin login flow with a `next=/chikaq` round-trip parameter, exactly
 * like /admin/* does.
 *
 * We unit-test the redirect contract directly via the page module rather
 * than spinning a Next server — `redirect()` from next/navigation throws
 * a special signal that the framework intercepts; here we just assert it
 * threw with the right URL.
 */
import { describe, expect, it, vi } from "vitest";

// Mock next/navigation to surface the redirect target as a throw with a
// recognisable shape. This mirrors how Next 15 implements the redirect
// helper in tests where there is no request context.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const err = new Error(`REDIRECT:${url}`) as Error & { __redirect: string };
    err.__redirect = url;
    throw err;
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

// Mock the session helper so we control whether the admin appears logged in.
vi.mock("@/lib/session", () => ({
  requireAdminSessionFromCookies: vi.fn(async () => ({ ok: false as const })),
}));

// Mock the heavy aggregator imports — irrelevant for the redirect test and
// avoids needing a live Postgres.
vi.mock("@/lib/widgetQuery", () => ({
  loadInsightsStats: vi.fn(async () => ({
    albums_total: 0,
    photos_total: 0,
    storage_bytes: 0,
  })),
  loadViewsTrend: vi.fn(async () => []),
  loadViewsTrend30d: vi.fn(async () => []),
  loadTopAlbums: vi.fn(async () => []),
  loadTopAlbums30d: vi.fn(async () => []),
  loadRecentActivity24h: vi.fn(async () => []),
  loadTileSparklines: vi.fn(async () => ({ photos: [], favorites: [], storage: [] })),
  parseChikaqPeriod: (raw: string | null | undefined) =>
    raw === "7d" || raw === "30d" || raw === "90d" || raw === "all" ? raw : "30d",
  periodToDays: (p: string) => {
    switch (p) {
      case "7d": return 7;
      case "30d": return 30;
      case "90d": return 90;
      case "all": return null;
    }
    return 30;
  },
}));

vi.mock("@/app/admin/logout/actions", () => ({
  logoutAction: async () => undefined,
}));

describe("/chikaq", () => {
  it("redirects to /admin/login?next=/chikaq when no admin session", async () => {
    const { default: Page } = await import("@/app/chikaq/page");
    await expect(Page({})).rejects.toThrowError(/REDIRECT:\/admin\/login\?next=\/chikaq/);
  });

  it("does not redirect when the admin session is valid", async () => {
    const session = await import("@/lib/session");
    (session.requireAdminSessionFromCookies as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      userId: "admin-1",
      email: "admin@local",
    });
    const { default: Page } = await import("@/app/chikaq/page");
    // The vitest happy-dom environment does not register React as a global,
    // so the JSX evaluation throws ReferenceError("React is not defined").
    // That's still the wrong-error-for-the-right-reason — what we care about
    // is that the page got *past* the redirect guard. If the redirect had
    // fired, the error would carry the REDIRECT: prefix injected by our mock.
    await Page({}).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toMatch(/REDIRECT:/);
    });
  });
});
