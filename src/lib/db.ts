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

function getClient(): Sql {
  if (!globalForDb.db) {
    globalForDb.db = makeClient();
  }
  return globalForDb.db;
}

// Lazy proxy: defers `makeClient()` until first call/property access. Lets
// vitest start its testcontainers Postgres in `beforeAll` (which runs AFTER
// ESM module collection) and have DATABASE_URL ready by the time any test
// actually executes a query.
export const sql: Sql = new Proxy(
  function lazySqlStub() {
    throw new Error("[db] unreachable lazy stub");
  } as unknown as Sql,
  {
    apply(_target, thisArg, args: unknown[]) {
      const client = getClient() as unknown as (...a: unknown[]) => unknown;
      return Reflect.apply(client, thisArg, args);
    },
    get(_target, prop, receiver) {
      const client = getClient() as unknown as object;
      return Reflect.get(client, prop, receiver);
    }
  }
) as Sql;
