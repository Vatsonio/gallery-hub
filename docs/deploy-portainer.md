# Deploy gallery-hub on Proxmox + Portainer

End-to-end recipe to run gallery-hub on a Proxmox LXC / VM with Portainer as
the stack manager. Images are built by GitHub Actions and pulled from GitHub
Container Registry — Portainer never needs the source repo on disk.

## Image pipeline (already wired)

`.github/workflows/build.yml` builds three images on every push to `master`
(plus tags `v*` and manual `workflow_dispatch`):

| Image | Source | Tags |
|---|---|---|
| `ghcr.io/vatsonio/gallery-hub` | `Dockerfile` (Next.js app + migrations) | `latest`, `master`, `sha-XXXXXXX`, `vX.Y.Z` |
| `ghcr.io/vatsonio/gallery-hub-worker` | `Dockerfile.worker` (pg-boss workers) | same |
| `ghcr.io/vatsonio/gallery-hub-backup` | `deploy/backup/Dockerfile` (cron mirror) | same |

The same `gallery-hub` image is also used as the migration runner
(`gallery-migrate` service runs `npx tsx scripts/migrate.ts` once and exits).

## One-time GHCR setup

1. **Make the packages public** (so Portainer can pull without auth)
   - Go to https://github.com/Vatsonio?tab=packages
   - For each of `gallery-hub`, `gallery-hub-worker`, `gallery-hub-backup`:
     Package settings → Danger Zone → "Change visibility" → Public
2. If you'd rather keep them private, give Portainer credentials:
   - Create a PAT at https://github.com/settings/tokens with `read:packages`
   - In Portainer → Registries → Add registry → GitHub Container Registry
   - URL: `ghcr.io`, Username: `vatsonio`, Password: the PAT

## Proxmox host prerequisites

A regular LXC/VM with Docker + Portainer Agent. Suggested specs for a
single-photographer workload (≈ 200 GB photos, light traffic):

- 4 vCPU
- 4 GB RAM (8 GB if you also run PostHog from the bundled compose)
- 100 GB disk for `/var/lib/docker` (volumes live there)
- A second mount for cold backups if you use `BACKUP_TARGET=local`

## Portainer stack from Git (recommended)

This is the path that gives you "click → update".

1. **Portainer → Stacks → Add stack → Git repository**
2. Repository URL: `https://github.com/Vatsonio/gallery-hub`
3. Repository reference: `refs/heads/master`
4. Compose path: `deploy/portainer-stack.yml`
5. **Authentication**: leave empty if the repo is public
6. **Automatic updates**: enable, polling interval 5 minutes (or set up the
   webhook flow — see below)
7. **Environment variables**: paste from `.env.prod.example`, fill secrets

Click "Deploy the stack". Portainer clones the repo, pulls the GHCR images,
brings up postgres → minio → migrate (one-shot) → app + worker + imgproxy +
cloudflared.

### Required env vars (minimum)

| Var | Notes |
|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `openssl rand -hex 24` |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | Same as root for single-tenant |
| `DATABASE_URL` | `postgresql://gallery:<POSTGRES_PASSWORD>@gallery-postgres:5432/gallery_hub` |
| `MINIO_ENDPOINT` | `http://gallery-minio:9000` (internal) |
| `MINIO_PUBLIC_ENDPOINT` | `https://minio.gallery.example.com` |
| `MINIO_API_CORS_ALLOW_ORIGIN` | `https://gallery.example.com` |
| `MINIO_BROWSER_REDIRECT_URL` | `https://minio.gallery.example.com` |
| `IMGPROXY_KEY` / `IMGPROXY_SALT` | `openssl rand -hex 32` each |
| `PUBLIC_IMGPROXY_URL` | `https://img.gallery.example.com` |
| `SESSION_PASSWORD` | `openssl rand -hex 32` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Bootstrap owner — used by `seed-admin.ts` |
| `PUBLIC_BASE_URL` | `https://gallery.example.com` |
| `CF_TUNNEL_TOKEN` | From Cloudflare Tunnel dashboard |

Full reference: `.env.prod.example`.

### Optional env vars

| Var | Notes |
|---|---|
| `TRUST_PROXY_HEADERS` | `1` when behind a trusted proxy (Cloudflare Tunnel). Required for the metrics "Top albums → Views" drill-down to record **real client IPs** (`cf-connecting-ip`) and per-IP login rate-limiting; otherwise IPs log as `unknown`/shared. Only enable when the app is genuinely behind a proxy that strips client-supplied `x-forwarded-for`. |
| `GEOIP_DB_PATH` | Absolute path to a MaxMind **GeoLite2-City.mmdb** (mount it into the gallery-app container). Enables **city/region** in the visitor drill-down. Without it the drill-down shows country only (from Cloudflare's `cf-ipcountry`). Get a free DB at maxmind.com (GeoLite2, requires a free license key) and refresh it periodically. |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token. **Env-only** — the admin UI never stores it (it's a secret at rest). Required to actually send notifications. |
| `TELEGRAM_CHAT_ID` | Default Telegram chat id for notifications (can be overridden in `/admin/settings`). |
| `NEXT_PUBLIC_PH_SESSION_REPLAY` | `1` to re-enable PostHog session replay (off by default — it records visitor screens). |
| `MAX_EXPORT_PHOTOS` / `MAX_EXPORT_BYTES` | Override the export size ceilings (defaults 5000 photos / 25 GB). |

## Updates

Three options, pick what matches your workflow.

### Option A — Portainer "Pull and redeploy"
1. Push a commit to `master`.
2. Wait ~3-4 min for the build workflow to finish (GitHub Actions tab).
3. Portainer → Stacks → gallery-hub → "Pull and redeploy".
4. Portainer pulls the new `:latest` images, recreates only changed services.

### Option B — Portainer webhook (push notification)
1. Portainer → Stacks → gallery-hub → "Webhook" → copy the URL.
2. GitHub → Settings → Webhooks → Add webhook.
3. Payload URL: the Portainer webhook URL.
4. Content type: `application/json`. Events: just `push`.
5. On every push to `master`, GitHub waits for the build, then Portainer
   pulls + redeploys automatically.

For a deterministic "wait for build before redeploy" you can replace the
GitHub Webhook with a final job in `.github/workflows/build.yml`:

```yaml
  notify-portainer:
    needs: [app, worker, backup]
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsSL -X POST "${{ secrets.PORTAINER_WEBHOOK_URL }}"
```

Add `PORTAINER_WEBHOOK_URL` to GitHub secrets — Portainer fires only after
images are in the registry.

### Option C — Polling
Set "Automatic updates" → "GitOps updates" in the Portainer stack to poll
the repo every N minutes. Portainer pulls images and redeploys when the
compose file or its referenced tags change. Simplest, but lags behind a
push by up to N minutes and re-runs even when only the README changed.

### Option D — SSH (when Portainer's web UI lags or you want determinism)

After the build workflow turns green, SSH to the Proxmox host (or the LXC
that runs Docker) and:

```sh
# Force-pull the latest images — pull_policy: always in the stack makes
# this redundant on `up`, but explicit pulls are handy when you want to
# inspect the new SHAs before recreating.
docker pull ghcr.io/vatsonio/gallery-hub:latest
docker pull ghcr.io/vatsonio/gallery-hub-worker:latest

# Recreate the three services that move on every release. Postgres /
# MinIO / imgproxy / cloudflared / watchtower stay up.
docker compose -p <portainer-stack-name> \
  --env-file /path/to/stack.env \
  -f deploy/portainer-stack.yml \
  up -d --force-recreate gallery-migrate gallery-app gallery-worker

# Confirm the new image is live and reporting the right commit:
curl -sS https://gallery.example.com/api/health
# → {"db":"ok","minio":"ok","uptime_s":...,"version":"sha-XXXXXXX..."}
```

If you don't know the stack project name, Portainer shows it under
**Stacks → name** and `docker inspect gallery-app --format
'{{index .Config.Labels "com.docker.compose.project"}}'` prints it from
the running container.

### One-off: orientation backfill after upgrading past `9a965b9`

Commit `9a965b9` fixes a bug where iPhone portrait shots were stored
with landscape dimensions (worker trusted `sharp.metadata()` over the
EXIF Orientation tag). Existing rows need a one-shot correction. After
the new worker image is running:

```sh
docker exec gallery-app npx tsx scripts/backfill-orientation.ts
```

The script walks every photo with `status='ready'`, re-reads sharp
metadata against MinIO, and updates rows whose stored dimensions
disagree with the orientation-corrected truth. Idempotent — safe to
re-run. On the smoke album it caught 8 photos out of 223.

Re-deployments after the backfill don't need to run it again.

## DNS + TLS

Cloudflare Tunnel handles ingress. Three hostnames need a `Public Hostname`
mapping inside the tunnel:

| Hostname | Origin |
|---|---|
| `gallery.example.com` | `http://gallery-app:3000` |
| `img.gallery.example.com` | `http://gallery-imgproxy:8080` |
| `minio.gallery.example.com` | `http://gallery-minio:9000` |
| `posthog.gallery.example.com` (optional) | `http://posthog-app:8000` |

TLS is terminated by Cloudflare; origin stays HTTP inside the Docker
network. No certbot / nginx required.

## First-boot checklist

1. Stack deploys: postgres healthy, minio healthy, migrate exits 0,
   app + worker become healthy.
2. SSH into the LXC: `docker exec gallery-app node -e "console.log('ok')"`.
3. Open `https://gallery.example.com/admin/login`. Sign in with
   `ADMIN_EMAIL` / `ADMIN_PASSWORD`. You're auto-promoted to `owner` by
   migration `018`.
4. `/admin/users/new` to create additional admins. `/admin/settings` to set
   storage caps, retention, Telegram, etc.

## Rollback

```sh
# In the Portainer container console for gallery-app:
docker compose -f docker-compose.prod.yml pull \
  gallery-app=ghcr.io/vatsonio/gallery-hub:sha-XXXXXXX
docker compose -f docker-compose.prod.yml up -d gallery-app gallery-worker
```

Or override `GALLERY_APP_IMAGE` / `GALLERY_WORKER_IMAGE` in the Portainer
stack env and redeploy. The `master` and `sha-*` tags are kept indefinitely
by GHCR, so any past good build is a one-tag pin away.
