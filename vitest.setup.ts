import { afterAll, beforeAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";

declare global {
  // eslint-disable-next-line no-var
  var __PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
  // eslint-disable-next-line no-var
  var __MINIO_CONTAINER__: StartedTestContainer | undefined;
}

// Placeholders so module-load reads of MinIO env vars in `@/lib/minio` don't
// return undefined. `beforeAll` replaces MINIO_ENDPOINT with the container's
// actual mapped port. The lazy `s3Client` proxy reads env on first use, so
// the real endpoint is picked up before any request is sent.
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
  // TODO[docker-off]: drop this branch when Docker is available again.
  process.env.DATABASE_URL ??= "postgresql://noop:noop@127.0.0.1:5432/noop";
}

beforeAll(async () => {
  if (process.env.SKIP_TESTCONTAINERS === "1") return;
  const pg = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("gallery_test")
    .withUsername("gallery")
    .withPassword("gallery")
    .start();
  globalThis.__PG_CONTAINER__ = pg;
  process.env.DATABASE_URL = pg.getConnectionUri();

  const minio = await new GenericContainer("minio/minio:latest")
    .withCommand(["server", "/data"])
    .withEnvironment({
      MINIO_ROOT_USER: "minio",
      MINIO_ROOT_PASSWORD: "minio12345"
    })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/minio/health/ready", 9000))
    .start();
  globalThis.__MINIO_CONTAINER__ = minio;
  const host = minio.getHost();
  const port = minio.getMappedPort(9000);
  process.env.MINIO_ENDPOINT = `http://${host}:${port}`;
  process.env.MINIO_ACCESS_KEY = "minio";
  process.env.MINIO_SECRET_KEY = "minio12345";
  process.env.MINIO_FORCE_PATH_STYLE = "true";
}, 180_000);

afterAll(async () => {
  await globalThis.__PG_CONTAINER__?.stop();
  await globalThis.__MINIO_CONTAINER__?.stop();
}, 60_000);
