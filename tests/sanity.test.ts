import { describe, expect, it } from "vitest";

const dockerOff = process.env.SKIP_TESTCONTAINERS === "1";

describe("sanity", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });

  // TODO[docker-off]: unskip when Docker is available
  it.skipIf(dockerOff)("has DATABASE_URL from testcontainer", () => {
    expect(process.env.DATABASE_URL).toMatch(/^postgres:\/\//);
  });
});
