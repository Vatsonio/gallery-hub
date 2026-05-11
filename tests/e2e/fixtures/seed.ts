/**
 * E2E fixture seed — populates the running dev stack (Postgres + MinIO)
 * with a known admin user, a published album, six generated photos,
 * and a password-free share link.
 *
 * Preconditions:
 *   1. `dev.bat` (or equivalent) has Postgres on 5433 + MinIO on 9100
 *      running with bucket `gallery` already created.
 *   2. Migrations applied (`npm run migrate`).
 *   3. Env: DATABASE_URL, MINIO_ENDPOINT, MINIO_ACCESS_KEY,
 *      MINIO_SECRET_KEY, MINIO_BUCKET, SESSION_PASSWORD.
 *
 * Usage:   npm run test:e2e:seed
 * Output:  tests/e2e/.fixture.json  (token, albumId, photoIds, admin creds)
 *          stdout: SEED_OK token=<token>
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import postgres from "postgres";
import sharp from "sharp";
import { hashPassword } from "../../../src/lib/passwords";

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@divass.space";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "demo1234";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[seed] ${name} is required`);
  return v;
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const minioEndpoint = requireEnv("MINIO_ENDPOINT");
  const accessKey = requireEnv("MINIO_ACCESS_KEY");
  const secretKey = requireEnv("MINIO_SECRET_KEY");
  const bucket = process.env.MINIO_BUCKET ?? "gallery";

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    // 1. Reset gallery state (do NOT touch pgboss tables — worker has its own lifecycle).
    await sql`TRUNCATE TABLE view_events, favorites, share_links, photos, albums RESTART IDENTITY CASCADE`;

    // 2. Upsert admin so the dev login still works.
    await sql`
      INSERT INTO admin_users (email, password_hash)
      VALUES (${ADMIN_EMAIL}, ${await hashPassword(ADMIN_PASSWORD)})
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
    `;

    // 3. Album.
    const albumId = randomUUID();
    await sql`
      INSERT INTO albums (id, slug, title, subtitle, status)
      VALUES (${albumId}, 'e2e-demo', 'E2E Demo Album', 'Playwright fixture', 'published')
    `;

    // 4. S3 client (MinIO).
    const s3 = new S3Client({
      endpoint: minioEndpoint,
      region: process.env.MINIO_REGION ?? "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });

    // 5. Six generated photos in solid colors. Each gets original + thumb/web/large
    //    WebP derivatives so the gallery page can presign them.
    const palette: Array<[number, number, number]> = [
      [200, 80, 100],
      [80, 160, 200],
      [180, 200, 80],
      [120, 80, 200],
      [200, 160, 80],
      [80, 200, 160],
    ];
    const photoIds: string[] = [];
    for (let i = 0; i < palette.length; i++) {
      const id = randomUUID();
      photoIds.push(id);
      const width = 1600;
      const height = i % 2 === 0 ? 1066 : 2000;
      const [r, g, b] = palette[i];
      const png = await sharp({
        create: { width, height, channels: 3, background: { r, g, b } },
      })
        .jpeg({ quality: 80 })
        .toBuffer();
      const web = await sharp(png).resize(1600).webp().toBuffer();
      const large = await sharp(png).resize(2400).webp().toBuffer();
      const thumb = await sharp(png).resize(400).webp().toBuffer();

      const uploads: Array<[string, Buffer, string]> = [
        [`albums/${albumId}/${id}/original.jpg`, png, "image/jpeg"],
        [`albums/${albumId}/${id}/web.webp`, web, "image/webp"],
        [`albums/${albumId}/${id}/large.webp`, large, "image/webp"],
        [`albums/${albumId}/${id}/thumb.webp`, thumb, "image/webp"],
      ];
      for (const [key, body, contentType] of uploads) {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
          }),
        );
      }

      await sql`
        INSERT INTO photos (
          id, album_id, filename, width, height, orig_bytes,
          thumb_bytes, web_bytes, large_bytes, sort_order, status
        )
        VALUES (
          ${id}, ${albumId}, ${`photo-${i}.jpg`}, ${width}, ${height}, ${png.length},
          ${thumb.length}, ${web.length}, ${large.length}, ${i}, 'ready'
        )
      `;
    }
    await sql`UPDATE albums SET cover_photo_id = ${photoIds[0]} WHERE id = ${albumId}`;

    // 6. Share link.
    const token = randomBytes(9).toString("base64url").slice(0, 12);
    await sql`
      INSERT INTO share_links (token, album_id, allow_download)
      VALUES (${token}, ${albumId}, true)
    `;

    // 7. Emit fixture file.
    const fixturePath = join(process.cwd(), "tests/e2e/.fixture.json");
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(
      fixturePath,
      JSON.stringify(
        {
          token,
          albumId,
          photoIds,
          adminEmail: ADMIN_EMAIL,
          adminPassword: ADMIN_PASSWORD,
        },
        null,
        2,
      ),
    );

    // eslint-disable-next-line no-console
    console.log(`SEED_OK token=${token} album=${albumId} photos=${photoIds.length}`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[seed] failed:", err);
  process.exit(1);
});
