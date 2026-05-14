import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    globalSetup: "./tests/global-setup.ts",
    // Tests share one Postgres + one MinIO (started in globalSetup). The
    // integration suites all reset DB state via resetTestDb() in beforeEach,
    // which is only safe when test files run serially. singleFork keeps
    // process startup cheap (one worker) while serializing file execution.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true }
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}", "scripts/**/*.ts"]
    }
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") }
  }
});
