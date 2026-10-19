# syntax=docker/dockerfile:1.7
# =============================================================================
# Saman ERP — backup sidecar image (profile `backup`)
# Contains: PostgreSQL 16 client (pg_dump), gpg, mc (MinIO/S3 client), tini.
# Runs as non-root `backup` (uid 1001); all writable state lives in /backups
# or /tmp (MC_CONFIG_DIR, GNUPGHOME).
# =============================================================================
FROM alpine:3.20 AS prod

RUN apk add --no-cache \
      bash \
      ca-certificates \
      coreutils \
      findutils \
      gnupg \
      postgresql16-client \
      tini \
      tzdata \
 && adduser -D -u 1000 -h /home/backup backup \
 && mkdir -p /backups /home/backup \
 && chown -R backup:backup /backups /home/backup

# MinIO client (same pinned release as the minio-init service).
COPY --from=minio/mc:RELEASE.2025-04-16T18-13-26Z /usr/bin/mc /usr/local/bin/mc

COPY infra/backup/backup.sh  /usr/local/bin/backup.sh
COPY infra/backup/restore.sh /usr/local/bin/restore.sh
RUN chmod 0755 /usr/local/bin/backup.sh /usr/local/bin/restore.sh /usr/local/bin/mc

USER 1000:1000
WORKDIR /home/backup
ENV MC_CONFIG_DIR=/tmp/mc \
    GNUPGHOME=/tmp/gnupg \
    TZ=Asia/Tehran

LABEL org.opencontainers.image.title="saman-erp-backup" \
      org.opencontainers.image.description="Saman ERP backup/restore sidecar (pg_dump -Fc + GPG + MinIO/S3)" \
      org.opencontainers.image.licenses="UNLICENSED"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/backup.sh"]
CMD ["daemon"]
