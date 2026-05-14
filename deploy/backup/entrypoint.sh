#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Entrypoint for the gallery-backup container.
#
# Sets up a tiny supercronic schedule that fires the chosen script on its cron
# expression. We use supercronic over busybox crond so that:
#   * env vars from `docker run -e` reach the cron child (busybox crond strips
#     them unless you re-export everything via PAM, which alpine doesn't have)
#   * logs go to stdout/stderr (the container's normal log driver)
#
# Three roles, controlled by BACKUP_ROLE env:
#   * pg       — daily pg_dump → gzip → gpg encrypt (default 03:00 UTC)
#   * mirror   — daily mc mirror MinIO → cold storage (default 04:00 UTC)
#   * once     — run the role's script once, immediately, then exit (CI/smoke)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROLE="${BACKUP_ROLE:-pg}"
SCHEDULE_PG="${SCHEDULE_PG:-0 3 * * *}"
SCHEDULE_MIRROR="${SCHEDULE_MIRROR:-0 4 * * *}"

case "$ROLE" in
  pg)
    SCRIPT=/opt/scripts/pg-backup.sh
    SCHEDULE="$SCHEDULE_PG"
    ;;
  mirror)
    SCRIPT=/opt/scripts/minio-mirror.sh
    SCHEDULE="$SCHEDULE_MIRROR"
    ;;
  once-pg)
    exec /opt/scripts/pg-backup.sh
    ;;
  once-mirror)
    exec /opt/scripts/minio-mirror.sh
    ;;
  *)
    echo "[entrypoint] unknown BACKUP_ROLE=$ROLE" >&2
    exit 2
    ;;
esac

echo "[entrypoint] role=$ROLE schedule='$SCHEDULE' script=$SCRIPT"

# Run once on boot to surface config errors immediately, then hand over to cron.
# If the very first run fails we want the container to crash-loop and the
# operator to see the error — DON'T `|| true` this.
"$SCRIPT"

# Build a one-line crontab and hand it to supercronic. Supercronic streams
# child stdout/stderr to its own stdout (which is the container's log).
CRONTAB=/tmp/crontab
printf '%s %s\n' "$SCHEDULE" "$SCRIPT" >"$CRONTAB"
exec /usr/local/bin/supercronic -passthrough-logs "$CRONTAB"
