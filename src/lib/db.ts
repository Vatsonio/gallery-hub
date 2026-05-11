import postgres, { type Sql } from "postgres";

const globalForDb = globalThis as unknown as { db?: Sql };

function makeClient(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // During `next build` Next collects page data by evaluating server modules
    // even when no DB is available. Defer the error to first actual query.
    if (process.env.NEXT_PHASE === "phase-production-build") {
      return postgres("postgresql://noop:noop@127.0.0.1:5432/noop", {
        ssl: false,
        max: 1,
        idle_timeout: 1
      });
    }
    throw new Error("[db] DATABASE_URL is not set");
  }
  return postgres(url, {
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
    max: 10,
    idle_timeout: 30
  });
}

export const sql: Sql = globalForDb.db ?? makeClient();

if (process.env.NODE_ENV !== "production") {
  globalForDb.db = sql;
}
