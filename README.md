# gallery-hub

Self-hosted client photo gallery for divass. Public at `gallery.divass.space`, admin at `/admin`.

This repo is the M1 foundation: Next.js 15 + Postgres + MinIO + admin auth. Album CRUD, photo uploads, and public share routes land in subsequent milestones.

## Stack

- Next.js 15 (App Router, TypeScript strict)
- Tailwind 4
- Postgres 16 via `postgres.js`
- MinIO via `@aws-sdk/client-s3`
- `iron-session` admin auth, `@node-rs/argon2` password hashing
- Vitest + testcontainers for tests

## Local development

```bash
cp .env.example .env
docker compose up -d gallery-postgres gallery-minio
npm install
npm run migrate
ADMIN_EMAIL=admin@divass.space ADMIN_PASSWORD=local-dev npm run seed:admin
npm run dev
```

Open `http://localhost:3000/admin/login`.

## Tests

```bash
npm test
```

The vitest setup boots a throwaway Postgres container per test run using `testcontainers`. Docker must be running.

## Portainer deploy

1. Push to `main`. GitHub Actions builds and pushes `ghcr.io/divass/gallery-hub:latest`.
2. In Portainer, create a stack from `docker-compose.yml` in this repo.
3. Set environment variables (Portainer UI):

   ```
   POSTGRES_USER=gallery
   POSTGRES_PASSWORD=<strong>
   POSTGRES_DB=gallery_hub
   DATABASE_URL=postgresql://gallery:<strong>@gallery-postgres:5432/gallery_hub

   MINIO_ROOT_USER=<minio-admin>
   MINIO_ROOT_PASSWORD=<strong>
   MINIO_ENDPOINT=http://gallery-minio:9000
   MINIO_ACCESS_KEY=<minio-admin>
   MINIO_SECRET_KEY=<strong>
   MINIO_BUCKET=gallery

   SESSION_PASSWORD=<32+ char random>
   ADMIN_EMAIL=admin@divass.space
   ADMIN_PASSWORD=<your-admin-password>

   PUBLIC_BASE_URL=https://gallery.divass.space
   ```

4. Bring the stack up. `gallery-migrate` will apply migrations and exit. `gallery-app` will start.
5. Seed the admin **once** (Portainer "Exec" into `gallery-app`):

   ```bash
   npx tsx scripts/seed-admin.ts
   ```

6. Add the Cloudflare Tunnel hostname `gallery.divass.space` → `gallery-app:3000`.
7. Open `https://gallery.divass.space/admin/login` and sign in.

## Health check

`GET /api/health` returns `{ db: 'ok'|'fail', minio: 'ok'|'fail' }` and status 200/503 — wire it into Portainer or Cloudflare uptime monitors.
