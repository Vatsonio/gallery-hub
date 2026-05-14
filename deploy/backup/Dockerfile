# ─────────────────────────────────────────────────────────────────────────────
# gallery-backup image — bundles pg_dump (matching server major), gpg, gzip,
# the MinIO `mc` client, and a tiny cron runner (supercronic). One image
# powers two services (pg-dump backup + minio mirror) selected by BACKUP_ROLE.
# ─────────────────────────────────────────────────────────────────────────────
FROM postgres:16.5-alpine

# supercronic version is pinned for reproducible builds.
ENV SUPERCRONIC_VERSION=v0.2.30 \
    SUPERCRONIC_SHA1SUM=9aeb41e00cc7b71d30d33c57a2333f2c2581a201

RUN apk add --no-cache \
        bash \
        ca-certificates \
        curl \
        gnupg \
        gzip \
        tzdata \
        wget \
 && wget -q -O /usr/local/bin/mc https://dl.min.io/client/mc/release/linux-amd64/mc \
 && chmod +x /usr/local/bin/mc \
 && wget -q -O /usr/local/bin/supercronic \
        "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
 && chmod +x /usr/local/bin/supercronic \
 && echo "${SUPERCRONIC_SHA1SUM}  /usr/local/bin/supercronic" | sha1sum -c -

COPY deploy/scripts/pg-backup.sh     /opt/scripts/pg-backup.sh
COPY deploy/scripts/minio-mirror.sh  /opt/scripts/minio-mirror.sh
COPY deploy/backup/entrypoint.sh     /opt/entrypoint.sh
RUN chmod +x /opt/scripts/*.sh /opt/entrypoint.sh

WORKDIR /opt
ENTRYPOINT ["/opt/entrypoint.sh"]
