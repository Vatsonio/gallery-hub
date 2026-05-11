import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/passwords";

describe("passwords", () => {
  it("hashes and verifies a correct password", async () => {
    const hash = await hashPassword("hunter2!");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, "hunter2!")).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("hunter2!");
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });

  it("produces different hashes for the same password (random salt)", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });
});
