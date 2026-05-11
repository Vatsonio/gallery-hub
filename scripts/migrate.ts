import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

export interface RunMigrationsOptions {
  databaseUrl: string;
  migrationsDir?: string;
  silent?: boolean;
}

export async function runMigrations(opts: RunMigrationsOptions): Promise<void> {
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const log = (msg: string) => {
    if (!opts.silent) console.log(msg);
  };
  const sql = postgres(opts.databaseUrl, { max: 1 });
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied = await sql<{ name: string }[]>`SELECT name FROM _migrations`;
    const appliedSet = new Set(applied.map((r) => r.name));

    for (const file of files) {
      if (appliedSet.has(file)) {
        log(`[migrate] = ${file} (already applied)`);
        continue;
      }
      const body = readFileSync(join(dir, file), "utf8");
      log(`[migrate] + ${file}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      });
    }
    log("[migrate] done");
  } finally {
    await sql.end();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("migrate.ts");
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[migrate] DATABASE_URL is not set");
    process.exit(1);
  }
  runMigrations({ databaseUrl: url }).catch((err) => {
    console.error("[migrate] failed:", err);
    process.exit(1);
  });
}
