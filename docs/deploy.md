# Production Deploy Runbook

Step-by-step guide to bring gallery-hub live at `https://gallery.divass.space`
behind Cloudflare Tunnel. Target: a single Linux host (any distro with Docker
Engine 24+). Estimated wall-clock time from a blank VPS: ~30 minutes plus
PostHog first-boot wait (~3 minutes).

> This runbook is **deterministic**. Every command is copy-pasteable. If a
> step's verification fails, stop — do not continue, do not "fix forward".

---

## 1. Server prerequisites

A fresh VPS with at least:

- 4 vCPU, 8 GB RAM, 80 GB SSD (PostHog + ClickHouse are the heavy hitters;
  without analytics you can drop to 2 vCPU / 4 GB / 40 GB)
- Public IPv4
- Docker Engine 24+ and the Compose v2 plugin
- (Optional) Portainer CE for a UI on top of compose

Install Docker on Debian/Ubuntu:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out & back in afterwards
docker compose version          # expect v2.x
```

Optional Portainer:

```bash
docker volume create portainer_data
docker run -d -p 9443:9443 --name portainer --restart=unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v portainer_data:/data \
  portainer/portainer-ce:latest
```

## 2. Clone the repository

```bash
sudo mkdir -p /opt/gallery-hub && sudo chown $USER /opt/gallery-hub
git clone https://github.com/divass/gallery-hub.git /opt/gallery-hub
cd /opt/gallery-hub
git checkout <release-tag-or-commit>   # pin to a known good commit
```

## 3. Generate secrets

```bash
cp .env.prod.example .env.prod
chmod 600 .env.prod
```

Generate values inline:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"        >> .env.prod
echo "MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)"      >> .env.prod
echo "MINIO_ACCESS_KEY=$(openssl rand -hex 16)"         >> .env.prod
echo "MINIO_SECRET_KEY=$(openssl rand -hex 24)"         >> .env.prod
echo "SESSION_PASSWORD=$(openssl rand -base64 32)"      >> .env.prod
echo "WIDGET_TOKEN=$(openssl rand -hex 32)"             >> .env.prod
echo "POSTHOG_PG_PASSWORD=$(openssl rand -hex 24)"      >> .env.prod
echo "POSTHOG_SECRET_KEY=$(openssl rand -base64 32)"    >> .env.prod
echo "ADMIN_PASSWORD=$(openssl rand -base64 18)"        >> .env.prod
```

Then **open `.env.prod` in an editor** and:

- Resolve duplicate keys (the appended values win — keep one of each)
- Update `DATABASE_URL` to embed the new `POSTGRES_PASSWORD`
- Set `ADMIN_EMAIL` to your real address
- Confirm the `PUBLIC_BASE_URL` / `POSTHOG_SITE_URL` / `MINIO_PUBLIC_ENDPOINT`
  match the hostnames you will route through Cloudflare in step 4
- Leave `CF_TUNNEL_TOKEN` blank for now — filled in step 4
- Leave `POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_KEY` blank for now — filled in
  step 10 after PostHog first-boot

> **Startup guard:** `src/lib/session.ts` throws at module load if
> `NODE_ENV=production` and `SESSION_PASSWORD` is missing or empty. The Next
> server will not boot without it — the failure surfaces immediately on the
> first request rather than silently falling back to a publicly-known dev key.
> If you see `Error: SESSION_PASSWORD env var is required in production`,
> regenerate with `openssl rand -hex 32` and confirm it landed in `.env.prod`.

## 4. Cloudflare Tunnel setup

You need a Cloudflare account with `divass.space` already onboarded as a zone.

### Create the tunnel

In the Cloudflare dashboard:

1. Zero Trust → Networks → Tunnels → **Create a tunnel**
2. Connector: `Cloudflared`
3. Name: `gallery-hub`
4. Copy the **install token** — this is `CF_TUNNEL_TOKEN`
5. Paste into `.env.prod` (replace the blank line)

### Add public hostnames

Still in the tunnel config screen, add three public hostnames:

| Hostname                          | Service                       |
| --------------------------------- | ----------------------------- |
| `gallery.divass.space`            | `http://gallery-app:3000`     |
| `minio.gallery.divass.space`      | `http://gallery-minio:9000`   |
| `posthog.gallery.divass.space`    | `http://posthog:8000`         |

Cloudflare auto-creates the matching CNAME records in DNS.

### (Optional) credentials-file mode

If you prefer not to use the token, install `cloudflared` locally, run
`cloudflared tunnel login` and `tunnel create gallery-hub`, then drop the
generated JSON into `deploy/cloudflared/credentials.json` and copy
`deploy/cloudflared/config.example.yml` to `config.yml` filling in the
tunnel UUID. Override the `cloudflared` service command in
`docker-compose.prod.yml` to:

```yaml
command: ["tunnel", "--no-autoupdate", "--config", "/etc/cloudflared/config.yml", "run", "gallery-hub"]
```

and unset `CF_TUNNEL_TOKEN`.

## 5. First boot

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

Watch the boot:

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f gallery-app gallery-worker
```

## 6. Wait for healthchecks

```bash
docker compose -f docker-compose.prod.yml ps
```

Expect every row to read `healthy` (gallery-migrate exits as `completed`):

```
NAME                  STATUS
gallery-postgres      Up (healthy)
gallery-minio         Up (healthy)
gallery-migrate       Exited (0)
gallery-app           Up (healthy)
gallery-worker        Up (healthy)
posthog-pg            Up (healthy)
posthog-redis         Up (healthy)
posthog-clickhouse    Up (healthy)
posthog               Up (healthy)
gallery-cloudflared   Up (healthy)
```

If `posthog` is still `starting` after 3 minutes, that's normal — its first
boot runs migrations and ClickHouse schema setup. Wait another 2 minutes,
then check `docker compose logs posthog | tail -50`.

## 7. Apply migrations

The `gallery-migrate` one-shot container already applied schema on boot.
If you ever need to re-run manually:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  run --rm gallery-migrate
```

## 8. Seed the admin user

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec gallery-app npx tsx scripts/seed-admin.ts
```

The script reads `ADMIN_EMAIL` and `ADMIN_PASSWORD` from the container env.
It's idempotent — re-running just updates the password.

## 9. Smoke test

Open these URLs in a browser (incognito) and verify:

- `https://gallery.divass.space/api/health` → 200, JSON shows
  `{db: "ok", minio: "ok", uptime_s: N, version: "..."}`
- `https://gallery.divass.space/admin/login` → login form renders
- Log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`
- Create an album → upload one photo
- In DevTools → Network, the PUT to `minio.gallery.divass.space` should
  return 200. If it 403s, the MinIO CORS or `MINIO_API_CORS_ALLOW_ORIGIN`
  value is wrong — re-check step 3.
- Open the album's public link → photo renders via a presigned GET URL
  pointing at `minio.gallery.divass.space`

**Change the seeded admin password now** via the admin UI.

## 10. PostHog first-boot

1. Open `https://posthog.gallery.divass.space`
2. Create the PostHog admin account (this is NOT the gallery admin)
3. PostHog creates a default project; copy the **Project API key** from
   *Project Settings → Project API Key* (starts with `phc_`)
4. Update `.env.prod`:

   ```env
   POSTHOG_KEY=phc_xxxxxxxxxxxxxxxxxxxx
   NEXT_PUBLIC_POSTHOG_KEY=phc_xxxxxxxxxxxxxxxxxxxx
   ```

5. Restart the app so it picks up the keys:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.prod \
     up -d gallery-app
   ```

6. Build a dashboard in PostHog UI → Share → copy URL → paste into
   `POSTHOG_DASHBOARD_URL` in `.env.prod` → restart `gallery-app` again.
   `/chikaq` will now embed the dashboard.

## 11. Cloudflare WAF / Bot Fight Mode

In the Cloudflare dashboard for `divass.space`:

- **SSL/TLS → Overview**: set to `Full (strict)`
- **SSL/TLS → Edge Certificates**: enable `Always Use HTTPS`,
  `Automatic HTTPS Rewrites`, `Min TLS Version: 1.2`
- **Security → Bots**: enable `Bot Fight Mode`
- **Security → WAF → Managed rules**: enable the Cloudflare Managed
  Ruleset and OWASP Core Ruleset (paranoia level 1 to start; raise if
  no false positives surface after a week)
- **Security → DDoS**: confirm the default HTTP DDoS rules are on
- **Caching → Configuration**: set `Browser Cache TTL` to `Respect
  existing headers` so the gallery's Cache-Control headers apply
- **Rules → Page Rules** (optional): add a rule for
  `*minio.gallery.divass.space/*` with `Cache Level: Bypass` —
  presigned URLs must never be cached at the edge

### Telegram notifications (optional but recommended)

Real-time push when a client engages with a gallery. Full setup guide:
**[`docs/notifications.md`](notifications.md)**.

TL;DR:

1. Create a bot via `@BotFather` → copy the token.
2. Get your chat id via `@userinfobot` (or a group + `/getUpdates`).
3. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
   `TELEGRAM_RATE_LIMIT_PER_MINUTE` in `.env.prod`.
4. `docker compose -f docker-compose.prod.yml restart gallery-app gallery-worker`
5. Sign in to `/admin/notifications`, click **Test send**, confirm the
   row reaches `status='sent'`.

## 12. Backups

Full backup + disaster-recovery runbook: **[`docs/backup.md`](backup.md)**.

TL;DR:

- `gallery-backup` runs `pg_dump | gzip | gpg --symmetric AES256` daily at
  03:00 UTC into the `gallery_backups_prod` named volume. Retention:
  7 daily / 4 weekly / 6 monthly.
- `gallery-mirror` runs `mc mirror` daily at 04:00 UTC, append-only, from
  MinIO to cold storage. `BACKUP_TARGET` selects `b2` (Backblaze B2),
  `r2` (Cloudflare R2), or `local` (mounted volume).
- `/chikaq` Storage card shows live MinIO / Postgres usage + last
  backup/mirror timestamps.
- A pg-boss worker (`storage-usage-check`) emits a PostHog
  `storage_critical` event when MinIO crosses 85% of
  `STORAGE_QUOTA_BYTES`.

Fill `BACKUP_GPG_PASSPHRASE` and `BACKUP_TARGET` (+ the matching
`B2_*` / `R2_*` env block) in `.env.prod` — see `.env.prod.example` for
the full list. Bring the backup services up alongside the main stack:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  up -d gallery-backup gallery-mirror
```

Trigger a manual verification dump once the stack is healthy:

```bash
docker compose -f docker-compose.prod.yml exec gallery-backup \
  /opt/scripts/pg-backup.sh
```

For raw volume tarballs before a risky change, the legacy snapshot
command still works:

```bash
docker run --rm -v gallery_pgdata_prod:/data -v $PWD:/backup alpine \
  tar czf /backup/gallery_pgdata_$(date +%F).tar.gz -C /data .
docker run --rm -v gallery_miniodata_prod:/data -v $PWD:/backup alpine \
  tar czf /backup/gallery_miniodata_$(date +%F).tar.gz -C /data .
```

## 13. Updating + rolling back

Routine update (release tag bump):

```bash
cd /opt/gallery-hub
git fetch && git checkout <new-tag>
# edit .env.prod APP_VERSION + GALLERY_APP_IMAGE if pinned by sha
docker compose -f docker-compose.prod.yml --env-file .env.prod pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
docker compose -f docker-compose.prod.yml ps   # confirm healthchecks
```

Rollback when a deploy goes bad:

```bash
git checkout <previous-tag>
# revert APP_VERSION / image pins in .env.prod
docker compose -f docker-compose.prod.yml --env-file .env.prod pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

If a migration broke the schema, restore the volume from the most
recent tar.gz from step 12 before bringing the stack back up.

---

## Portainer stack workflow

If you prefer Portainer over raw `docker compose`:

1. Stacks → Add stack → name `gallery-hub`
2. Build method: `Web editor`
3. Paste the full contents of `docker-compose.prod.yml`
4. Scroll down to `Environment variables` → click `Load variables from .env file`
5. Upload your filled `.env.prod` (Portainer stores it inside its volume,
   not on disk where someone might cat it)
6. Click `Deploy the stack`

To update later: edit the stack → click `Update the stack` → enable
`Re-pull image and redeploy`. Portainer pulls the new image tag and
recreates only the changed services.

## Operational notes

- Logs rotate at 50 MB × 5 files per container (json-file driver), so the
  host won't fill up; ship to an external aggregator if you want long-term
  retention.
- `gallery-app` and `gallery-worker` run with `read_only: true`; if you ever
  see "EROFS: read-only file system" tracebacks, a code path is writing
  outside `/tmp`. Fix the code path — don't widen the filesystem.
- The internal Docker network has no host port bindings. The only way in
  is through Cloudflare. If you need a one-off port to debug something,
  add `ports:` temporarily in compose, then remove it before redeploying.
