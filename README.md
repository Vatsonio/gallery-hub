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

## Analytics — PostHog (self-hosted) + `/chikaq` insights

Two-layer analytics on top of the gallery:

- **`/chikaq`** (admin-gated) — first-party insights drawn straight from Postgres
  (views trend, top albums, recent activity per viewer). Lives in the same
  process; survives even if PostHog is down.
- **PostHog self-hosted** — funnels, retention, session replay, deep cohorting.
  Embedded inside `/chikaq` via a shared dashboard URL.

### Bring up the PostHog stack

The compose file ships PostHog + dedicated Postgres + Redis + ClickHouse on the
same `internal` network. They are independent services — start them on demand:

```bash
docker compose up -d posthog-pg posthog-redis posthog-clickhouse posthog
```

First boot:

1. Wait ~60 s for ClickHouse and PostHog to settle.
2. Visit `http://localhost:8000` → create the admin account (this is the
   PostHog project owner, **not** the gallery admin).
3. PostHog creates a default project; copy the **Project API key** from
   *Project Settings → Project API Key*.
4. Paste it into `.env`:

   ```env
   POSTHOG_KEY=phc_xxx...
   POSTHOG_HOST=http://localhost:8000
   NEXT_PUBLIC_POSTHOG_KEY=phc_xxx...
   NEXT_PUBLIC_POSTHOG_HOST=http://localhost:8000
   ```
5. Build a dashboard inside PostHog (funnels, retention, top events).
   *Dashboard → Share → toggle "Share dashboard" → copy URL.*
6. Paste it into `.env` as `POSTHOG_DASHBOARD_URL=...` and reload `/chikaq`
   — the iframe panel will render the live dashboard.

### Events captured

Server-side (always via `safeCapture` — never throws into a user flow):

- `gallery_view` — public album page render
- `favorites_view` — `/a/<token>/favorites` render
- `favorite_added` / `favorite_removed` — heart toggle on a photo
- `share_unlocked` — password-gated link unlocked
- `export_started` / `export_completed` — ZIP export of an album or favorites

Client-side (`PostHogProvider` mounted only inside `/a/<token>/*`):

- Automatic `$pageview` + `$pageleave` for SPA navigations
- Session replay (configured per project inside PostHog UI)

Admin sessions are explicitly opted out — no captures fire while previewing
albums from `/admin`.

### Resource note

PostHog + ClickHouse together idle at ~1.5 GB RAM. On a small VPS, either
schedule it (start before reviewing analytics, stop after), or fall back to
**PostHog Cloud's free tier** by pointing `POSTHOG_HOST` at
`https://us.posthog.com` (or `eu.posthog.com`) and keeping the rest of the
gallery stack local.

### `/chikaq`

The admin-gated insights page is at `/chikaq` (admin login required). It shows
storage tiles, a 30-day views sparkline, top albums by view count, recent
activity grouped per viewer, the embedded PostHog dashboard, and a one-click
link to the Cloudflare dashboard for DDoS / IP / geo views.
