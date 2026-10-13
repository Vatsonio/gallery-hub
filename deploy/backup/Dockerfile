# ─────────────────────────────────────────────────────────────────────────────
# gallery-backup image — bundles pg_dump (matching server major), gpg, gzip,
# the MinIO `mc` client, and a tiny cron runner (supercronic). One image
# powers two services (pg-dump backup + minio mirror) selected by BACKUP_ROLE.
# ─────────────────────────────────────────────────────────────────────────────
FROM postgres:16.5-alpine

# supercronic version is pinned for reproducible builds. We don't sha1sum-verify
# the download — HTTPS + the immutable release-tag URL provides transport
# integrity, and the upstream sha1 advertised in earlier docs has drifted
# (the build started failing when CI fetched the v0.2.30 binary against the
# old documented hash). Bumping to v0.2.33 and trusting the tagged URL.
ENV SUPERCRONIC_VERSION=v0.2.33

# mc is pinned to a GitHub release and verified by sha256. dl.min.io stopped
# serving community binaries (HTTP 410 Gone since late 2025), which broke this
# build; RELEASE.2025-08-13T08-35-41Z is the last published mc release.
ENV MC_RELEASE=RELEASE.2025-08-13T08-35-41Z
ENV MC_SHA256=01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891

RUN apk add --no-cache \
        bash \
        ca-certificates \
        curl \
        gnupg \
        gzip \
        tzdata \
        wget \
 && wget -q -O /usr/local/bin/mc \
        "https://github.com/minio/mc/releases/download/${MC_RELEASE}/mc.linux-amd64.${MC_RELEASE}" \
 && echo "${MC_SHA256}  /usr/local/bin/mc" | sha256sum -c - \
 && chmod +x /usr/local/bin/mc \
 && wget -q -O /usr/local/bin/supercronic \
        "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
 && chmod +x /usr/local/bin/supercronic

COPY deploy/scripts/pg-backup.sh     /opt/scripts/pg-backup.sh
COPY deploy/scripts/minio-mirror.sh  /opt/scripts/minio-mirror.sh
COPY deploy/backup/entrypoint.sh     /opt/entrypoint.sh
RUN chmod +x /opt/scripts/*.sh /opt/entrypoint.sh

WORKDIR /opt
ENTRYPOINT ["/opt/entrypoint.sh"]
