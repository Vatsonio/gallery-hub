import { afterAll, beforeAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";

declare global {
  // eslint-disable-next-line no-var
  var __PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
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
