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

## Production deploy

See [`docs/deploy.md`](docs/deploy.md) for the step-by-step runbook covering
Cloudflare Tunnel setup, secret generation, healthcheck verification,
PostHog first-boot, WAF toggles, and Portainer stack workflow.

TL;DR for an experienced operator:

```bash
git clone https://github.com/divass/gallery-hub.git /opt/gallery-hub
cd /opt/gallery-hub
cp .env.prod.example .env.prod   # fill in secrets — see docs/deploy.md §3
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
docker compose -f docker-compose.prod.yml exec gallery-app \
  npx tsx scripts/seed-admin.ts
```

The production compose file is `docker-compose.prod.yml` (pinned image
tags, healthchecks, read-only root FS, resource limits, no host port
bindings, Cloudflare Tunnel as the only ingress). `docker-compose.yml`
stays as the dev-only stack with exposed ports and `:latest` tags.

### Two public hostnames

The browser does direct PUT uploads to MinIO using presigned URLs to
avoid streaming through Next.js (which would double bandwidth and
bottleneck on 50 MB photos). That means MinIO needs its own public
hostname:

- `gallery.divass.space` → `gallery-app:3000`
- `minio.gallery.divass.space` → `gallery-minio:9000`
- `posthog.gallery.divass.space` → `posthog:8000` (analytics)

Inside Docker, the app uses `gallery-minio:9000` for server-side
reads/writes; the browser uses the public hostname for presigned PUT/GET.

## Health check

`GET /api/health` returns
`{ db: 'ok'|'fail', minio: 'ok'|'fail', uptime_s: N, version: '...' }`
with status 200/503. Wire it into Cloudflare uptime monitors or Portainer.

## Backups + disaster recovery

Daily encrypted Postgres dumps (`pg_dump | gzip | gpg --symmetric AES256`)
plus an append-only MinIO mirror to Backblaze B2 / Cloudflare R2 / a local
volume. `/chikaq` surfaces live usage and last-backup timestamps; a
pg-boss worker emits a PostHog `storage_critical` event at 85% of
`STORAGE_QUOTA_BYTES`.

Full architecture, schedules, restore drill, and partial-restore recipe
live in [`docs/backup.md`](docs/backup.md).

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
