#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# MinIO → cold-storage mirror for gallery-hub.
#
# Design notes:
#   * Append-only by default. `mc mirror` runs WITHOUT --remove on the cold
#     side, so if MinIO is wiped or compromised the cold copy still has
#     history. Set MIRROR_ALLOW_DELETE=1 to flip to destructive mirroring
#     (rarely what you want — read docs/backup.md before doing this).
#   * Source: the in-cluster MinIO (MINIO_ENDPOINT / *_KEY env).
#   * Destination: chosen by BACKUP_TARGET:
#         b2      Backblaze B2 via S3-compatible endpoint
#         r2      Cloudflare R2 via S3-compatible endpoint
#         local   local filesystem mount ($LOCAL_MIRROR_DIR)
#   * Idempotent: re-running the same day diffs and uploads only changed
#     keys. Empty bucket is a valid no-op.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

MC="${MC:-mc}"
MC_CONFIG_DIR="${MC_CONFIG_DIR:-/tmp/mc-config}"

MINIO_ENDPOINT="${MINIO_ENDPOINT:?MINIO_ENDPOINT required}"
MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:?MINIO_ACCESS_KEY required}"
MINIO_SECRET_KEY="${MINIO_SECRET_KEY:?MINIO_SECRET_KEY required}"
MINIO_BUCKET="${MINIO_BUCKET:-gallery}"

TARGET="${BACKUP_TARGET:-local}"
ALLOW_DELETE="${MIRROR_ALLOW_DELETE:-0}"

log() { printf '[minio-mirror] %s %s\n' "$(date -u +%FT%TZ)" "$*"; }

mkdir -p "$MC_CONFIG_DIR"
export MC_CONFIG_DIR

# Source alias — always the local MinIO.
"$MC" alias set gh-src "$MINIO_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" >/dev/null

case "$TARGET" in
  b2)
    : "${B2_KEY_ID:?B2_KEY_ID required for BACKUP_TARGET=b2}"
    : "${B2_APP_KEY:?B2_APP_KEY required for BACKUP_TARGET=b2}"
    : "${B2_BUCKET:?B2_BUCKET required for BACKUP_TARGET=b2}"
    : "${B2_ENDPOINT:?B2_ENDPOINT required for BACKUP_TARGET=b2 (e.g. https://s3.us-west-002.backblazeb2.com)}"
    "$MC" alias set gh-cold "$B2_ENDPOINT" "$B2_KEY_ID" "$B2_APP_KEY" >/dev/null
    DEST="gh-cold/${B2_BUCKET}"
    ;;
  r2)
    : "${R2_ACCESS_KEY:?R2_ACCESS_KEY required for BACKUP_TARGET=r2}"
    : "${R2_SECRET_KEY:?R2_SECRET_KEY required for BACKUP_TARGET=r2}"
    : "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID required for BACKUP_TARGET=r2}"
    : "${R2_BUCKET:?R2_BUCKET required for BACKUP_TARGET=r2}"
    R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
    "$MC" alias set gh-cold "$R2_ENDPOINT" "$R2_ACCESS_KEY" "$R2_SECRET_KEY" >/dev/null
    DEST="gh-cold/${R2_BUCKET}"
    ;;
  local)
    : "${LOCAL_MIRROR_DIR:?LOCAL_MIRROR_DIR required for BACKUP_TARGET=local}"
    mkdir -p "$LOCAL_MIRROR_DIR"
    DEST="$LOCAL_MIRROR_DIR"
    ;;
  *)
    log "unknown BACKUP_TARGET='$TARGET' (expected b2|r2|local)"
    exit 2
    ;;
esac

SRC="gh-src/${MINIO_BUCKET}"

# Compose the mirror flag set. `--overwrite` updates objects whose size/etag
# differ; `--remove` is OFF unless explicitly enabled so a wiped source can
# never wipe the cold copy too.
MIRROR_FLAGS=("--overwrite")
if [ "$ALLOW_DELETE" = "1" ]; then
  MIRROR_FLAGS+=("--remove")
  log "WARNING: MIRROR_ALLOW_DELETE=1 — cold side will mirror source deletes"
fi

log "mirroring $SRC → $DEST target=$TARGET allow_delete=$ALLOW_DELETE"

# `mc mirror` exits non-zero on any failed transfer. We DON'T swallow that —
# cron will mark the run as failed and the next pass picks up where this one
# left off (mirror is incremental).
"$MC" mirror "${MIRROR_FLAGS[@]}" "$SRC" "$DEST"

# Append a small machine-readable manifest so /chikaq can surface "last mirror".
MANIFEST_DIR="${BACKUP_DIR:-/backups}"
if [ -d "$MANIFEST_DIR" ]; then
  cat >"$MANIFEST_DIR/last-mirror.json" <<JSON
{
  "completed_at": "$(date -u +%FT%TZ)",
  "target": "$TARGET",
  "source": "$SRC",
  "destination": "$DEST"
}
JSON
fi

log "done"
