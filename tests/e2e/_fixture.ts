import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface E2EFixture {
  token: string;
  albumId: string;
  photoIds: string[];
  adminEmail: string;
  adminPassword: string;
}

const FIXTURE_PATH = join(process.cwd(), "tests/e2e/.fixture.json");

export function loadFixture(): E2EFixture {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(
      `[e2e] fixture not found at ${FIXTURE_PATH}. Run \`npm run test:e2e:seed\` first.`,
    );
  }
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as E2EFixture;
}
