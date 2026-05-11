import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, teardownTestDb, resetTestDb } from "./_helpers";
import { sql } from "@/lib/db";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

beforeAll(async () => {
  process.env.GH_TEST_BYPASS_AUTH = "1";
  await setupTestDb();
});
afterAll(async () => { await teardownTestDb(); });

let albumId: string;
beforeEach(async () => {
  await resetTestDb();
  albumId = randomUUID();
  await sql`INSERT INTO albums (id, slug, title, status) VALUES (${albumId}, ${'a-' + albumId.slice(0,8)}, 't', 'published')`;
});

describe("share-link actions", () => {
  it("creates with optional password hashing", async () => {
    const { createShareLink } = await import("@/lib/share-actions");
    const link = await createShareLink(albumId, { password: "hunter2", allowDownload: true });
    expect(link.token).toHaveLength(12);
    expect(link.password_hash).toMatch(/^\$argon2id\$/);
    expect(link.allow_download).toBe(true);
  });

  it("creates with no password", async () => {
    const { createShareLink } = await import("@/lib/share-actions");
    const link = await createShareLink(albumId, { allowDownload: false });
    expect(link.password_hash).toBeNull();
    expect(link.allow_download).toBe(false);
  });

  it("updates expiry and download flag", async () => {
    const { createShareLink, updateShareLink } = await import("@/lib/share-actions");
    const link = await createShareLink(albumId, {});
    const exp = new Date(Date.now() + 86400_000);
    const updated = await updateShareLink(link.token, { expiresAt: exp, allowDownload: false });
    expect(updated.allow_download).toBe(false);
    expect(updated.expires_at?.getTime()).toBe(exp.getTime());
  });

  it("changes password when newPassword provided, clears when null", async () => {
    const { createShareLink, updateShareLink } = await import("@/lib/share-actions");
    const link = await createShareLink(albumId, { password: "old" });
    const u1 = await updateShareLink(link.token, { newPassword: "new" });
    expect(u1.password_hash).toMatch(/^\$argon2id\$/);
    expect(u1.password_hash).not.toBe(link.password_hash);
    const u2 = await updateShareLink(link.token, { newPassword: null });
    expect(u2.password_hash).toBeNull();
  });

  it("revokes (deletes) the link", async () => {
    const { createShareLink, revokeShareLink } = await import("@/lib/share-actions");
    const link = await createShareLink(albumId, {});
    await revokeShareLink(link.token);
    const rows = await sql`SELECT 1 FROM share_links WHERE token = ${link.token}`;
    expect(rows).toHaveLength(0);
  });
});
