/**
 * Shared test admin identity. Migration 021 added a NOT NULL FK from
 * albums.owner_user_id to admin_users(id), so anything that creates an
 * album in a test/bench context needs a real admin_users row to point
 * at. The two test-auth bypasses (NODE_ENV=test + x-test-admin header
 * in `requireAdminSession`, and GH_TEST_BYPASS_AUTH=1 in the admin
 * actions gate) both report this UUID as the calling user.
 *
 * Tests (and scripts/upload-bench.ts) must call `ensureTestAdminUser`
 * before creating albums so the FK resolves.
 */
import { sql } from "@/lib/db";

export const TEST_ADMIN_USER_ID = "11111111-1111-1111-1111-111111111111";
export const TEST_ADMIN_EMAIL = "test@local";

export async function ensureTestAdminUser(): Promise<string> {
  // password_hash isn't exercised by the bypass paths but the column is
  // NOT NULL; stash a deterministic placeholder so the row stays valid.
  await sql`
    INSERT INTO admin_users (id, email, password_hash, role)
    VALUES (${TEST_ADMIN_USER_ID}, ${TEST_ADMIN_EMAIL}, '$test$bypass', 'owner')
    ON CONFLICT (id) DO NOTHING
  `;
  return TEST_ADMIN_USER_ID;
}
