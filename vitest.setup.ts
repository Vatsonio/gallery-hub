/**
 * Per-test-worker setup. The heavy lifting (one Postgres + one MinIO for the
 * whole `npx vitest` invocation) is done in `tests/global-setup.ts`. This file
 * only ensures lazy-import-time placeholders are present when env vars haven't
 * yet been written by globalSetup (e.g. forked worker that imports lib/minio
 * before the parent process forwards the resolved values — vitest does
 * forward them, but the defaults are a defensive fallback).
 */

process.env.MINIO_ENDPOINT ??= "http://127.0.0.1:9000";
process.env.MINIO_REGION ??= "us-east-1";
process.env.MINIO_ACCESS_KEY ??= "minio";
process.env.MINIO_SECRET_KEY ??= "minio12345";
process.env.MINIO_BUCKET ??= "gallery-test";
process.env.MINIO_FORCE_PATH_STYLE ??= "true";

if (process.env.SKIP_TESTCONTAINERS === "1") {
  // Docker is unavailable. Set a placeholder DATABASE_URL at setup-file load
  // time (before test modules are evaluated) so modules that read it at import
  // time can construct lazy clients without throwing. postgres.js only opens
  // the connection on first query, so this placeholder never connects.
  process.env.DATABASE_URL ??= "postgresql://noop:noop@127.0.0.1:5432/noop";
}
