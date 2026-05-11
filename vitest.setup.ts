import { afterAll, beforeAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";

declare global {
  // eslint-disable-next-line no-var
  var __PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
}

if (process.env.SKIP_TESTCONTAINERS === "1") {
  // Docker is unavailable. Set a placeholder DATABASE_URL at setup-file load
  // time (before test modules are evaluated) so modules that read it at import
  // time can construct lazy clients without throwing. postgres.js only opens
  // the connection on first query, so this placeholder never connects.
  // TODO[docker-off]: drop this branch when Docker is available again.
  process.env.DATABASE_URL ??= "postgresql://noop:noop@127.0.0.1:5432/noop";
}

beforeAll(async () => {
  if (process.env.SKIP_TESTCONTAINERS === "1") return;
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("gallery_test")
    .withUsername("gallery")
    .withPassword("gallery")
    .start();
  globalThis.__PG_CONTAINER__ = container;
  process.env.DATABASE_URL = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  await globalThis.__PG_CONTAINER__?.stop();
}, 60_000);
