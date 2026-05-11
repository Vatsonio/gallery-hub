import postgres, { type Sql } from "postgres";

const globalForDb = globalThis as unknown as { db?: Sql };

function makeClient(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) {
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
