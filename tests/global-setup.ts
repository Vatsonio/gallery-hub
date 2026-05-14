import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";

/**
 * Vitest globalSetup: starts ONE Postgres + ONE MinIO container for the whole
 * `npx vitest` invocation. All test files share the same containers and
 * coordinate through env vars. This replaces the per-file `beforeAll`
 * container startup that previously caused Docker resource exhaustion when
 * dozens of test files ran in parallel.
 *
 * Honors `SKIP_TESTCONTAINERS=1` for environments where Docker is unavailable:
 * the containers are not started, a placeholder `DATABASE_URL` is set, and
 * integration tests that need real services should gate themselves on the env
 * with `describe.skipIf(process.env.SKIP_TESTCONTAINERS === "1")`.
 */

let pgContainer: StartedPostgreSqlContainer | undefined;
let minioContainer: StartedTestContainer | undefined;

export async function setup(): Promise<void> {
  // Placeholder MinIO env so that lazy clients which read env at module load
  // don't blow up before `setup()` returns. Real values are written below if
  // testcontainers run.
  process.env.MINIO_ENDPOINT ??= "http://127.0.0.1:9000";
  process.env.MINIO_REGION ??= "us-east-1";
  process.env.MINIO_ACCESS_KEY ??= "minio";
  process.env.MINIO_SECRET_KEY ??= "minio12345";
  process.env.MINIO_BUCKET ??= "gallery-test";
  process.env.MINIO_FORCE_PATH_STYLE ??= "true";

  if (process.env.SKIP_TESTCONTAINERS === "1") {
    process.env.DATABASE_URL ??= "postgresql://noop:noop@127.0.0.1:5432/noop";
    return;
  }

  pgContainer = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("gallery_test")
    .withUsername("gallery")
    .withPassword("gallery")
    .start();
  process.env.DATABASE_URL = pgContainer.getConnectionUri();

  minioContainer = await new GenericContainer("minio/minio:latest")
    .withCommand(["server", "/data"])
    .withEnvironment({
      MINIO_ROOT_USER: "minio",
      MINIO_ROOT_PASSWORD: "minio12345",
    })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/minio/health/ready", 9000))
    .start();
  const host = minioContainer.getHost();
  const port = minioContainer.getMappedPort(9000);
  process.env.MINIO_ENDPOINT = `http://${host}:${port}`;
  process.env.MINIO_ACCESS_KEY = "minio";
  process.env.MINIO_SECRET_KEY = "minio12345";
  process.env.MINIO_FORCE_PATH_STYLE = "true";
}

export async function teardown(): Promise<void> {
  await pgContainer?.stop();
  await minioContainer?.stop();
  pgContainer = undefined;
  minioContainer = undefined;
}
