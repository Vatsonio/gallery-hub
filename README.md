# gallery-hub

Self-hosted client photo gallery for divass. Public at `gallery.divass.space`, admin at `/admin`.

## Stack

- Next.js 15 (App Router, TypeScript strict)
- Tailwind 4
- Postgres 16 via `postgres.js`
- MinIO via `@aws-sdk/client-s3`
- `iron-session` admin auth, `@node-rs/argon2` password hashing
- Vitest + testcontainers for tests

## Local development (Windows, one shot)

Double-click `dev.bat`. It:

1. Boots Postgres + MinIO containers (with CORS + checksum-free presigning)
2. Applies migrations, seeds the admin (`admin@divass.space` / `demo1234`)
3. Starts `next dev` on http://localhost:3000

Open http://localhost:3000 — you'll be redirected to `/admin/login`.

- `dev-stop.bat` — stop containers (data preserved)
- `dev-reset.bat` — wipe containers AND data

## Local development (manual)

```bash
cp .env.example .env  # adjust values
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

## Portainer + Cloudflare Tunnel deploy

The app needs **two** public hostnames because browser-direct uploads to MinIO can't go through the Next.js app — MinIO must be reachable from the client.

- `gallery.divass.space` → `gallery-app:3000` (the Next.js app)
- `minio.gallery.divass.space` → `gallery-minio:9000` (MinIO, browser-side reads + presigned PUTs)

### Steps

1. Push to `main`. GitHub Actions builds and pushes `ghcr.io/divass/gallery-hub:latest`.
2. In Portainer, create a stack from `docker-compose.yml` in this repo.
3. Set environment variables (Portainer UI):

   ```env
   POSTGRES_USER=gallery
   POSTGRES_PASSWORD=<strong>
   POSTGRES_DB=gallery_hub
   DATABASE_URL=postgresql://gallery:<strong>@gallery-postgres:5432/gallery_hub

   MINIO_ROOT_USER=<minio-admin>
   MINIO_ROOT_PASSWORD=<strong>
   MINIO_ACCESS_KEY=<minio-admin>
   MINIO_SECRET_KEY=<strong>
   MINIO_BUCKET=gallery

   # Internal endpoint — used by Next.js + worker for server-side reads/writes.
   MINIO_ENDPOINT=http://gallery-minio:9000

   # Public endpoint — what the browser sees in presigned URLs.
   MINIO_PUBLIC_ENDPOINT=https://minio.gallery.divass.space

   # CORS origin allowed to PUT/GET MinIO from the browser.
   MINIO_API_CORS_ALLOW_ORIGIN=https://gallery.divass.space

   SESSION_PASSWORD=<32+ char random>
   ADMIN_EMAIL=admin@divass.space
   ADMIN_PASSWORD=<your-admin-password>

   PUBLIC_BASE_URL=https://gallery.divass.space
   ```

4. Bring the stack up. `gallery-migrate` applies migrations and exits. `gallery-app` + `gallery-worker` start.
5. Seed the admin **once** (Portainer "Exec" into `gallery-app`):

   ```bash
   npx tsx scripts/seed-admin.ts
   ```

6. In MinIO console (`http://gallery-minio:9001` reached via Portainer, or temporarily exposed), create the `gallery` bucket — or it'll auto-create on first upload via `ensureBucket()`.

7. Add **two** Cloudflare Tunnel public hostnames:
   - `gallery.divass.space` → service `http://gallery-app:3000`
   - `minio.gallery.divass.space` → service `http://gallery-minio:9000`

8. Open `https://gallery.divass.space/admin/login` and sign in.

### Why two hostnames?

The browser does direct PUT uploads to MinIO using presigned URLs to avoid streaming through Next.js (which would double bandwidth and bottleneck on 50 MB photos). For that to work the browser needs a reachable MinIO. Inside the Docker network the app server uses `gallery-minio:9000` for thumbnails/derivatives; outside, the browser uses the second tunnel hostname.

Don't want a second hostname? Switch to a server-side upload proxy: change `Dropzone.tsx` to POST file blobs to a new `/api/upload/blob` route which streams them to MinIO. Slower but single-origin.

## Health check

`GET /api/health` returns `{ db: 'ok'|'fail', minio: 'ok'|'fail' }` and status 200/503 — wire it into Portainer or Cloudflare uptime monitors.
