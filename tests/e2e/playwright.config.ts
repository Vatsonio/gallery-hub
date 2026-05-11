import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const PROJECT_ROOT = resolve(__dirname, "..", "..");
const DEV_PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${DEV_PORT}`;

// Env handed to the Next dev server. We reuse the same dev-stack ports as
// dev.bat (Postgres 5433, MinIO 9100) so the running compose stack is shared
// between manual dev and Playwright runs.
const SERVER_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  NODE_ENV: "development",
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgresql://gallery:gallery@localhost:5433/gallery_hub",
  MINIO_ENDPOINT: process.env.MINIO_ENDPOINT ?? "http://localhost:9100",
  MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY ?? "minio",
  MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY ?? "minio12345",
  MINIO_BUCKET: process.env.MINIO_BUCKET ?? "gallery",
  MINIO_FORCE_PATH_STYLE: process.env.MINIO_FORCE_PATH_STYLE ?? "true",
  SESSION_PASSWORD:
    process.env.SESSION_PASSWORD ??
    "dev-demo-secret-thirty-two-chars-long-pls",
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? BASE_URL,
};

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        // `npm run dev` is slow to first-compile but reliable. Generous timeout
        // because the first page request triggers a full Next compile.
        command: `npx next dev -p ${DEV_PORT}`,
        cwd: PROJECT_ROOT,
        url: BASE_URL,
        timeout: 180_000,
        reuseExistingServer: !process.env.CI,
        env: SERVER_ENV,
        stdout: "ignore",
        stderr: "pipe",
      },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"] } },
  ],
});
