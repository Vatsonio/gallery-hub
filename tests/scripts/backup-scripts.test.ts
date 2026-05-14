/**
 * Smoke tests for the bash backup scripts. We can't realistically execute
 * pg_dump / mc inside vitest, but we CAN assert:
 *
 *   1. `bash -n` parses cleanly (syntax sanity).
 *   2. The scripts honour `set -euo pipefail` (catches a class of bugs
 *      where someone removes the strict-mode preamble during refactor).
 *   3. Required env vars are declared with the `${VAR:?...}` failure
 *      pattern so a misconfigured deploy fails loudly instead of writing
 *      empty / unencrypted dumps.
 *
 * The tests skip when bash is not on PATH (Windows CI without WSL); the
 * static-content assertions still run.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

function bashAvailable(): boolean {
  const r = spawnSync("bash", ["-c", "exit 0"], { stdio: "ignore" });
  return r.status === 0;
}

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS = [
  path.join(ROOT, "deploy", "scripts", "pg-backup.sh"),
  path.join(ROOT, "deploy", "scripts", "minio-mirror.sh"),
  path.join(ROOT, "deploy", "backup", "entrypoint.sh"),
];

describe("backup script smoke tests", () => {
  for (const script of SCRIPTS) {
    describe(path.basename(script), () => {
      it("exists in the repo", () => {
        expect(existsSync(script)).toBe(true);
      });

      it("declares strict-mode preamble", () => {
        const src = readFileSync(script, "utf8");
        expect(src).toMatch(/set -euo pipefail/);
      });

      it.skipIf(!bashAvailable())("parses with `bash -n`", () => {
        const r = spawnSync("bash", ["-n", script], { encoding: "utf8" });
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
      });
    });
  }

  it("pg-backup.sh requires the GPG passphrase env", () => {
    const src = readFileSync(SCRIPTS[0], "utf8");
    // ${VAR:?...} is the bash pattern that aborts when VAR is unset/empty.
    expect(src).toMatch(/BACKUP_GPG_PASSPHRASE:\?/);
    expect(src).toMatch(/POSTGRES_PASSWORD:\?/);
  });

  it("pg-backup.sh uses AES256 symmetric encryption", () => {
    const src = readFileSync(SCRIPTS[0], "utf8");
    expect(src).toMatch(/--cipher-algo AES256/);
    expect(src).toMatch(/--symmetric/);
  });

  it("minio-mirror.sh defaults to append-only (--remove gated)", () => {
    const src = readFileSync(SCRIPTS[1], "utf8");
    // The contract: --remove is only added when MIRROR_ALLOW_DELETE=1.
    // Confirm the env gate exists and that --remove only appears inside the
    // conditional branch (skipping comment lines so doc text doesn't trip us).
    expect(src).toMatch(/MIRROR_ALLOW_DELETE/);
    const codeLines = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"));
    const removeLines = codeLines.filter((l) => l.includes("--remove"));
    // Should only appear inside the MIRROR_FLAGS+=(...) branch.
    expect(removeLines.length).toBeGreaterThan(0);
    for (const line of removeLines) {
      expect(line).toMatch(/MIRROR_FLAGS\+=/);
    }
  });

  it("minio-mirror.sh supports all three documented targets", () => {
    const src = readFileSync(SCRIPTS[1], "utf8");
    for (const target of ["b2", "r2", "local"]) {
      expect(src).toContain(target);
    }
  });
});
