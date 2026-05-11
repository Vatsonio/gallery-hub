import postgres from "postgres";
import { hashPassword } from "../src/lib/passwords";

export interface SeedAdminOptions {
  databaseUrl: string;
  email: string;
  password: string;
  silent?: boolean;
}

export async function seedAdmin(opts: SeedAdminOptions): Promise<void> {
  const log = (msg: string) => {
    if (!opts.silent) console.log(msg);
  };
  const sql = postgres(opts.databaseUrl, { max: 1 });
  try {
    const passwordHash = await hashPassword(opts.password);
    await sql`
      INSERT INTO admin_users (email, password_hash)
      VALUES (${opts.email}, ${passwordHash})
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
    `;
    log(`[seed-admin] upserted admin ${opts.email}`);
  } finally {
    await sql.end();
  }
}

const isMain = process.argv[1]?.endsWith("seed-admin.ts");
if (isMain) {
  const databaseUrl = process.env.DATABASE_URL;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!databaseUrl || !email || !password) {
    console.error("[seed-admin] DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD must all be set");
    process.exit(1);
  }
  seedAdmin({ databaseUrl, email, password }).catch((err) => {
    console.error("[seed-admin] failed:", err);
    process.exit(1);
  });
}
