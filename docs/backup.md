# Backup + Disaster Recovery

Encrypted Postgres dumps, append-only MinIO mirror to cold storage, and a
restore drill that lets the gallery come back from a wiped VPS.

> Storage-quota alerts are wired into `/chikaq` and emit a PostHog
> `storage_critical` event when MinIO usage crosses 85% of
> `STORAGE_QUOTA_BYTES`. See [§5 Monitoring](#5-monitoring) for details.

---

## 1. Architecture

```
                        ┌──────────────────────────┐
                        │   gallery-postgres       │
                        │   /var/lib/postgresql    │
                        └────────────┬─────────────┘
                                     │ pg_dump -Fc
                                     ▼
   ┌──────────────────────────────────────────────────────┐
   │  gallery-backup container  (BACKUP_ROLE=pg)          │
   │                                                      │
   │   cron 03:00 UTC  →  pg-backup.sh                    │
   │     pg_dump | gzip | gpg --symmetric AES256          │
   │     → /backups/daily/gallery-YYYY-MM-DD.sql.gz.gpg   │
   │   prune: 7 daily, 4 weekly, 6 monthly                │
   └──────────────────────────────┬───────────────────────┘
                                  │
                                  ▼
                        ┌──────────────────────┐
                        │  gallery_backups_prod │   (named volume)
                        └──────────────────────┘

                        ┌──────────────────────────┐
                        │   gallery-minio          │
                        │   /data/gallery          │
                        └────────────┬─────────────┘
                                     │ mc mirror (append-only)
                                     ▼
   ┌──────────────────────────────────────────────────────┐
   │  gallery-mirror container  (BACKUP_ROLE=mirror)      │
   │                                                      │
   │   cron 04:00 UTC  →  minio-mirror.sh                 │
   │   reads BACKUP_TARGET ∈ { b2 | r2 | local }          │
   │     b2     → Backblaze B2 (S3-compat)                │
   │     r2     → Cloudflare R2                           │
   │     local  → /mirror (gallery_mirror_prod volume)    │
   │   --remove is OFF unless MIRROR_ALLOW_DELETE=1       │
   └──────────────────────────────────────────────────────┘
```

Both services ship from `deploy/backup/Dockerfile` (postgres-alpine base +
mc + supercronic + gpg). One image, two roles, selected by `BACKUP_ROLE`.

## 2. Schedule

| When (UTC) | Job                      | Container         |
| ---------- | ------------------------ | ----------------- |
| 03:00      | Postgres dump + prune    | `gallery-backup`  |
| 04:00      | MinIO mirror             | `gallery-mirror`  |
| hourly :00 | Storage quota check      | `gallery-worker`  |
| every 1h   | `reap-deleted-albums`    | `gallery-worker`  |
| every 6h   | `reap-stale-exports`     | `gallery-worker`  |

Override the schedules via env if 03:00 UTC clashes with your backup
window: set `BACKUP_SCHEDULE_PG` / `BACKUP_SCHEDULE_MIRROR` (full
five-field cron expressions).

## 3. Manual operations

Trigger a pg-dump immediately (idempotent — overwrites today's file):

```bash
docker compose -f docker-compose.prod.yml exec gallery-backup \
  /opt/scripts/pg-backup.sh
```

Trigger a one-off mirror sweep:

```bash
docker compose -f docker-compose.prod.yml exec gallery-mirror \
  /opt/scripts/minio-mirror.sh
```

List the dumps inside the volume:

```bash
docker compose -f docker-compose.prod.yml exec gallery-backup \
  ls -la /backups/daily /backups/weekly /backups/monthly
```

Pull the latest dump to the host (for off-host archival):

```bash
docker compose -f docker-compose.prod.yml cp \
  gallery-backup:/backups/daily/gallery-$(date -u +%F).sql.gz.gpg \
  ./gallery-latest.sql.gz.gpg
```

## 4. Verify a backup

The cheap check — confirm GPG can decrypt and gzip can decompress:

```bash
docker compose -f docker-compose.prod.yml exec gallery-backup \
  sh -c 'gpg --batch --decrypt \
    --passphrase "$BACKUP_GPG_PASSPHRASE" \
    /backups/daily/gallery-$(date -u +%F).sql.gz.gpg \
    | gunzip | pg_restore --list | head -20'
```

A non-empty TOC listing means the dump is structurally intact.

The real check — restore into a scratch DB and diff row counts:

```bash
# 1. Spin up a throwaway Postgres.
docker run --rm -d --name pg-scratch -e POSTGRES_PASSWORD=x \
  -p 55432:5432 postgres:16.5-alpine

# 2. Restore.
docker compose -f docker-compose.prod.yml exec gallery-backup \
  sh -c 'gpg --batch --decrypt \
    --passphrase "$BACKUP_GPG_PASSPHRASE" \
    /backups/daily/gallery-$(date -u +%F).sql.gz.gpg | gunzip' \
  | docker exec -i pg-scratch pg_restore -U postgres -d postgres \
      --no-owner --no-acl --create

# 3. Compare row counts to the live DB.
docker compose -f docker-compose.prod.yml exec gallery-postgres \
  psql -U gallery -d gallery_hub -c \
  "SELECT 'albums' AS t, COUNT(*) FROM albums
   UNION ALL SELECT 'photos', COUNT(*) FROM photos
   UNION ALL SELECT 'view_events', COUNT(*) FROM view_events;"
docker exec pg-scratch psql -U postgres -d gallery_hub -c \
  "SELECT 'albums', COUNT(*) FROM albums
   UNION ALL SELECT 'photos', COUNT(*) FROM photos
   UNION ALL SELECT 'view_events', COUNT(*) FROM view_events;"

# 4. Tear down.
docker rm -f pg-scratch
```

Allow some drift on `view_events` since fresh events accrue between
the dump time and the diff — albums + photos should match exactly.

## 5. Monitoring

The `/chikaq` Storage card surfaces:

- MinIO bucket bytes + object count (paginated `ListObjectsV2` walk)
- `SUM(orig_bytes) FROM photos` — the user-attributable footprint
- `pg_database_size(current_database())` — full DB footprint
- Last successful pg-dump timestamp (read from `/backups/last-backup.json`)
- Last successful mirror timestamp (read from `/backups/last-mirror.json`)

A pg-boss worker runs hourly (`storage-usage-check` queue). When MinIO
usage crosses **85% of `STORAGE_QUOTA_BYTES`**, the worker emits a
PostHog `storage_critical` event with `{ used_bytes, quota_bytes,
used_pct, bucket }`. Build an alert in PostHog → Insights → New Insight
→ Funnel/Trend on `storage_critical`, then route to email/Slack via
PostHog destinations.

Set `STORAGE_QUOTA_BYTES` in `.env.prod` (in bytes — `100000000000` for
~100 GB). Leave it unset to disable the alert (the dashboard still shows
usage; only the threshold check is silenced).

To expose the manifest files to the gallery-app for the "Last backup"
row, mount the backup volume read-only into `gallery-app` and set
`BACKUP_MANIFEST_DIR=/backups` in `.env.prod`. The lib silently treats a
missing manifest dir / file as "never" so /chikaq is safe even before
the first backup runs.

## 6. Full disaster restore

Cold-start a wiped VPS from nothing but the encrypted dump + cold-storage
mirror.

### 6.1 New server prereqs

Follow [docs/deploy.md §1–§3](deploy.md) to provision Docker, clone the
repo, and fill `.env.prod` — but DO NOT start the full stack yet.

### 6.2 Bring up the data services only

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  up -d gallery-postgres gallery-minio
```

Wait for both to report `healthy`.

### 6.3 Restore Postgres

If the encrypted dump is on the host (e.g. you copied it from cold
storage to `/tmp/gallery.sql.gz.gpg`):

```bash
cat /tmp/gallery.sql.gz.gpg \
  | docker compose -f docker-compose.prod.yml exec -T gallery-backup \
      sh -c 'gpg --batch --decrypt --passphrase "$BACKUP_GPG_PASSPHRASE"' \
  | gunzip \
  | docker compose -f docker-compose.prod.yml exec -T gallery-postgres \
      pg_restore -U gallery -d gallery_hub --no-owner --no-acl --clean --if-exists
```

If you already have the dump inside the backup volume on the new host:

```bash
docker compose -f docker-compose.prod.yml exec gallery-backup \
  sh -c 'gpg --batch --decrypt --passphrase "$BACKUP_GPG_PASSPHRASE" \
    /backups/daily/gallery-<DATE>.sql.gz.gpg | gunzip' \
  | docker compose -f docker-compose.prod.yml exec -T gallery-postgres \
      pg_restore -U gallery -d gallery_hub --no-owner --no-acl --clean --if-exists
```

### 6.4 Restore MinIO

From Backblaze B2:

```bash
docker compose -f docker-compose.prod.yml exec gallery-mirror sh -c '
  mc alias set gh-src http://gallery-minio:9000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY"
  mc alias set gh-cold "$B2_ENDPOINT" "$B2_KEY_ID" "$B2_APP_KEY"
  mc mirror --overwrite gh-cold/"$B2_BUCKET" gh-src/"$MINIO_BUCKET"
'
```

From Cloudflare R2 — same, but the alias points at
`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` with the R2 key
pair.

From a local mirror volume:

```bash
docker compose -f docker-compose.prod.yml exec gallery-mirror sh -c '
  mc alias set gh-src http://gallery-minio:9000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY"
  mc mirror --overwrite /mirror gh-src/"$MINIO_BUCKET"
'
```

### 6.5 Re-run migrations + start the rest

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  run --rm gallery-migrate
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

### 6.6 Verify

- `https://gallery.divass.space/api/health` → `{ db: "ok", minio: "ok" }`
- Log in to `/admin/login` with the seeded credentials.
- Open `/chikaq` → Storage card matches expected bytes within a few
  percent of pre-disaster levels.
- Open a public album link → photos render via presigned GETs.

## 7. Partial restore (single album)

Sometimes the disaster is "I deleted the wrong album yesterday". You
don't want a full restore — you want one album back.

1. **Identify the album_id from the dump:**

   ```bash
   docker compose -f docker-compose.prod.yml exec gallery-backup \
     sh -c 'gpg --batch --decrypt --passphrase "$BACKUP_GPG_PASSPHRASE" \
       /backups/daily/gallery-<DATE>.sql.gz.gpg | gunzip' \
     | docker exec -i pg-scratch pg_restore -U postgres -d postgres \
       --no-owner --no-acl --create -t albums -t photos
   docker exec pg-scratch psql -U postgres -d gallery_hub -c \
     "SELECT id, title FROM albums WHERE title ILIKE '%wedding%';"
   ```

2. **Copy the album + photos rows into live Postgres**, scoped by
   album_id:

   ```bash
   docker exec pg-scratch pg_dump -U postgres -d gallery_hub \
     --table=albums --table=photos --data-only --inserts \
     --no-owner --where="album_id = '<UUID>'" \
     | docker compose -f docker-compose.prod.yml exec -T gallery-postgres \
       psql -U gallery -d gallery_hub
   ```

   (The `albums` row must come first — copy by id.)

3. **Restore the album's MinIO prefix** from cold storage:

   ```bash
   ALBUM_ID=<UUID>
   docker compose -f docker-compose.prod.yml exec gallery-mirror sh -c "
     mc alias set gh-src http://gallery-minio:9000 \$MINIO_ACCESS_KEY \$MINIO_SECRET_KEY
     mc alias set gh-cold \$B2_ENDPOINT \$B2_KEY_ID \$B2_APP_KEY
     mc mirror --overwrite gh-cold/\$B2_BUCKET/albums/$ALBUM_ID gh-src/\$MINIO_BUCKET/albums/$ALBUM_ID
   "
   ```

4. **Trigger derivative regeneration** if any photo's `web` / `large` /
   `thumb` variants are missing:

   ```bash
   docker compose -f docker-compose.prod.yml exec gallery-worker \
     npx tsx scripts/backfill-variant-sizes.ts --album=<UUID>
   ```

## 8. Testing schedule

**Run a restore drill once a month.** Calendar reminder, not a vibe.

A drill is:

1. Pull yesterday's dump from cold storage to a workstation.
2. Restore into a local `pg-scratch` container.
3. Diff row counts against the live DB (allow `view_events` drift).
4. Open one album's photos via a temporary local gallery-app pointed at
   the scratch DB. Confirm presigned URLs work.
5. Record the drill date + outcome in a file the team can see.

If a drill fails, treat it the same as a production outage — the next
real disaster is going to fail the same way.

## 9. What's NOT in scope

- **PostHog data** is not in this backup pipeline. PostHog has its own
  Postgres + ClickHouse + Redis, and the analytics events are
  reconstructable from `view_events` in the gallery DB. If you care
  about preserving the PostHog cohort/funnel definitions themselves,
  back up `posthog_pgdata_prod` separately.
- **Cloudflare configuration** (tunnel UUID, WAF rules, page rules) is
  not in this backup. Export it manually via the Cloudflare dashboard
  and stash in version control.
- **Secrets** are not in this backup. `.env.prod` is gitignored by
  design; keep an encrypted copy in a password manager.
