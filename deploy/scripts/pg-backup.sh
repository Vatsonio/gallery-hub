#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Encrypted Postgres dump for gallery-hub.
#
#   pg_dump -Fc → gzip → gpg --symmetric → /backups/YYYY-MM-DD/...
#
# Idempotent: re-running on the same day overwrites today's dump and re-runs
# pruning. Designed to be invoked from cron inside the gallery-backup
# container (see docker-compose.prod.yml).
#
# Required env:
#   POSTGRES_HOST       hostname of the primary (default: gallery-postgres)
#   POSTGRES_PORT       (default: 5432)
#   POSTGRES_USER
#   POSTGRES_PASSWORD
#   POSTGRES_DB
#   BACKUP_GPG_PASSPHRASE   symmetric encryption passphrase
#
# Optional env:
#   BACKUP_DIR          where to write dumps (default: /backups)
#   KEEP_DAILY          (default: 7)
#   KEEP_WEEKLY         (default: 4)
#   KEEP_MONTHLY        (default: 6)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

POSTGRES_HOST="${POSTGRES_HOST:-gallery-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:?POSTGRES_USER required}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD required}"
POSTGRES_DB="${POSTGRES_DB:?POSTGRES_DB required}"
BACKUP_GPG_PASSPHRASE="${BACKUP_GPG_PASSPHRASE:?BACKUP_GPG_PASSPHRASE required}"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${KEEP_MONTHLY:-6}"

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly" "$BACKUP_DIR/monthly"

TS_DAY="$(date -u +%Y-%m-%d)"
TS_FULL="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DOW="$(date -u +%u)"   # 1..7 (Mon..Sun)
DOM="$(date -u +%d)"   # 01..31

DAILY_FILE="$BACKUP_DIR/daily/gallery-${TS_DAY}.sql.gz.gpg"
TMP_FILE="$BACKUP_DIR/.in-progress.${TS_FULL}.sql.gz.gpg"

log() { printf '[pg-backup] %s %s\n' "$(date -u +%FT%TZ)" "$*"; }

log "starting dump host=$POSTGRES_HOST db=$POSTGRES_DB → $DAILY_FILE"

# pg_dump's -Fc (custom format) is the most portable restore target and
# already lz-compressed; we still gzip the GPG-encrypted stream so transit
# sizes are predictable for the cold-storage mirror step.
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
    -h "$POSTGRES_HOST" \
    -p "$POSTGRES_PORT" \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    -Fc \
    --no-owner \
    --no-acl \
  | gzip -c \
  | gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase "$BACKUP_GPG_PASSPHRASE" \
        --output "$TMP_FILE"

# Atomic move only after the whole pipeline succeeded.
mv -f "$TMP_FILE" "$DAILY_FILE"
SIZE="$(stat -c '%s' "$DAILY_FILE" 2>/dev/null || wc -c <"$DAILY_FILE")"
log "wrote daily file size=${SIZE}B"

# Snapshot to weekly on Sunday (DOW=7), monthly on the 1st of the month.
if [ "$DOW" = "7" ]; then
  cp -f "$DAILY_FILE" "$BACKUP_DIR/weekly/gallery-${TS_DAY}.sql.gz.gpg"
  log "promoted to weekly"
fi
if [ "$DOM" = "01" ]; then
  cp -f "$DAILY_FILE" "$BACKUP_DIR/monthly/gallery-${TS_DAY}.sql.gz.gpg"
  log "promoted to monthly"
fi

# Prune. ls -1t orders newest first; tail +N skips the N we want to keep.
prune() {
  local subdir="$1"
  local keep="$2"
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR/$subdir" 2>/dev/null \
    | grep -E '\.sql\.gz\.gpg$' \
    | tail -n +$((keep + 1)) \
    | while read -r f; do
        log "pruning $subdir/$f"
        rm -f "$BACKUP_DIR/$subdir/$f"
      done
}
prune daily   "$KEEP_DAILY"
prune weekly  "$KEEP_WEEKLY"
prune monthly "$KEEP_MONTHLY"

# Write a small machine-readable manifest so /chikaq can surface "last backup".
cat >"$BACKUP_DIR/last-backup.json" <<JSON
{
  "completed_at": "$(date -u +%FT%TZ)",
  "file": "$DAILY_FILE",
  "size_bytes": ${SIZE},
  "db": "$POSTGRES_DB"
}
JSON

log "done"
