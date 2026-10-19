# 07 — Backup & Restore (English)

**Status:** Design baseline v1.0 · Owner: DevOps/Platform Lead · Audience: SRE/DBA/operators.
**Companions:** [`../06-deployment/INSTALL-FA.md`](../06-deployment/INSTALL-FA.md) (Persian install), [`../06-deployment/DEPLOYMENT.md`](../06-deployment/DEPLOYMENT.md), [`RUNBOOK.md`](./RUNBOOK.md).

> **Verification honesty:** Docker was **not available** in the design/build environment. The commands below are specified by review against `ARCHITECTURE.md §14`, `ADR-0009`, `ADR-0012`, and the canonical `.env.example`. The restore procedure has been **reasoned through** against the migration/seed flow but **not executed**; the first quarterly drill (or pre-handover drill) is the acceptance test, and its measured RTO is the number reported to the customer. If a command fails during the drill, fix this document — it is the source of truth.

**Objectives** (`docs/00-overview §2 G8`, `ARCHITECTURE §14`): **RPO ≤ 15 min**, **RTO ≤ 1 h**.

| Profile | RPO | RTO | Enabled by |
|---|---|---|---|
| Default (shipped) | up to **24 h** (nightly dump) | ≤ 1 h (target) | `BACKUP_ENABLED=true`, `pg_dump -Fc` |
| **PITR (recommended for 10k SKU / high TPS)** | **≤ 15 min** (`archive_timeout=60s`) | ≤ 1 h | optional pgBackRest profile + WAL archiving |
| Config/secrets | same as backup run | minutes | encrypted config archive |

> **State this to the customer:** with only the default nightly dump, the 15-minute RPO claim is **not** met. PITR is an explicit, opt-in profile — not a default — because it requires a custom PostgreSQL image, WAL archive storage, and a **rehearsed** restore before it can be claimed as an RPO guarantee.

---

## 1. Scope of data

> **Shell setup for all commands below:** run everything from `/opt/saman-erp` with `.env` loaded into the shell (`set -a; . ./.env; set +a`) so `$POSTGRES_USER`, `$REDIS_PASSWORD`, `$MINIO_ROOT_USER`, `$BACKUP_ENCRYPTION_PASSPHRASE` resolve. MinIO is not published on the host, so object listing runs through the `minio-init` (mc) one-shot container (see the helper in `RUNBOOK §1.2`). `pg_restore`/`psql`/`gpg` are expected on the operator's admin host or in the restore scratch container; the `backup` image contract includes `pg_dump`, `gpg` and an S3 client.

| Asset | Backed up? | Method | Location | Notes |
|---|---|---|---|---|
| PostgreSQL `saman` / schema `erp` | **yes** | `pg_dump -Fc` nightly (+ WAL if PITR) | MinIO `saman-backups` + offsite | source of truth |
| Object storage `saman-files` (media, labels, exports) | **yes** | bucket versioning + `mc mirror`/rclone offsite | offsite S3 | needed for full restore |
| `saman-backups` bucket | yes | offsite mirror | offsite S3 | never rely on a backup stored only on the same disk |
| `.env`, `docker-compose.yml`, `infra/`, `certs/`, Caddy data | **yes** | encrypted tar (GPG) | offline/secure vault | contains secrets; separate passphrase |
| Redis | **no** | — | — | ephemeral; queued work replays from outbox (`ADR-0010`) |
| Agent/collector metrics | no | — | — | observability history only |
| Audit partitions beyond 7 y | archive then detach | S3 export + checksum (`ADR-0009`) | S3 archive | legal retention, not part of RPO |

**What is NOT a backup:** a Docker volume snapshot on the same host, a filesystem copy of a running `pgdata` directory, or a `pg_dump` stored only on the same disk. Offsite, encrypted, verified — all three are required.

---

## 2. Backup strategy

### 2.1 Scheduled logical backups (default profile)

- **Tool:** `pg_dump -Fc` (`-Fc` = custom format, compressed, supports selective/parallel restore via `pg_restore`).
- **Schedule:** `BACKUP_CRON=0 2 * * *` in the `backup` sidecar (02:00 local; low traffic).
- **Role:** dump with a role that can read all tables — schema owner `saman_migrator` via `MIGRATION_DATABASE_URL` (canonical env) or the dedicated `saman_backup` role (`pg_read_all_data`) once the implementation exposes it. Never use the app role for a full logical dump.
- **Pipeline (in the backup container):**

```bash
set -euo pipefail
TS="$(date +%Y%m%dT%H%M%SZ)"
FILE="/backups/saman-erp-${TS}.dump"
pg_dump -Fc -Z6 --no-owner --no-acl --dbname="$MIGRATION_DATABASE_URL" -f "$FILE"
sha256sum "$FILE" > "${FILE}.sha256"
gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase "$BACKUP_ENCRYPTION_PASSPHRASE" \
    -o "${FILE}.gpg" "$FILE"
rm -f "$FILE"                      # plaintext never rests on disk
# upload (S3 client in the backup image)
aws --endpoint-url "$S3_ENDPOINT" s3 cp "${FILE}.gpg" \
    "s3://saman-backups/${BACKUP_S3_PREFIX}/$(basename "${FILE}.gpg")"
aws --endpoint-url "$S3_ENDPOINT" s3 cp "${FILE}.sha256" \
    "s3://saman-backups/${BACKUP_S3_PREFIX}/$(basename "${FILE}.sha256")"
# retention
find /backups -name '*.gpg' -mtime +"${BACKUP_KEEP_DAYS}" -delete
```

Notes:

- `--no-owner --no-acl`: the dump must be restorable into a fresh environment where roles may be created differently; ownership/ACL are reconstructed by the restore procedure (roles created by `init`, default privileges re-applied).
- The sidecar uses `S3_ENDPOINT`/`S3_ACCESS_KEY`/`S3_SECRET_KEY` from `.env` and the fixed backup bucket `saman-backups` (created by `minio-init`); `BACKUP_S3_PREFIX` locates objects.
- `BACKUP_ENCRYPTION_PASSPHRASE` is the symmetric GPG passphrase (AES-256). It exists only in `.env` on the host and in the offline vault — never in the backup bucket, never in logs.
- Retention is `BACKUP_KEEP_DAYS` (default 30). Long-term retention (weekly/monthly) is enforced by the **offsite** bucket lifecycle rules (§7); do not keep years of dumps on the production host.
- **Implementation:** the shipped sidecar is `infra/backup/backup.sh` (inside `saman-erp/backup:$IMAGE_TAG`); ad-hoc runs via `scripts/backup-now.sh`; the fresh-container recovery is `infra/backup/restore.sh` orchestrated by `scripts/restore-drill.sh`.
- **Optional offsite mirror (implemented):** when `BACKUP_MIRROR_S3_ENDPOINT`/`BACKUP_MIRROR_S3_BUCKET`/`BACKUP_MIRROR_S3_ACCESS_KEY`/`BACKUP_MIRROR_S3_SECRET_KEY` are set, the sidecar copies the encrypted dump + sha256 to a second S3/MinIO account. The `BACKUP_MIRROR_S3_*` names are pending addition to the canonical `.env.example` (Lead-owned); set them only on the server until then.

### 2.2 Optional PITR profile (pgBackRest + WAL)

For RPO ≤ 15 min, run continuous WAL archiving and periodic full/differential physical backups. This is an **optional profile** because it changes the PostgreSQL image and restore procedure.

- **Image:** `infra/docker/postgres` — build from `postgres:16-alpine` and install `pgbackrest`.
- **Server settings** (in the custom image/`command`, not app env):

```conf
wal_level = replica
archive_mode = on
archive_timeout = 60s                       # bounds RPO to ~1 min of WAL
archive_command = 'pgbackrest --stanza=saman --repo=1 archive-push %p'
max_wal_senders = 5
```

- **Repo config** `infra/backup/pgbackrest.conf` (rendered from host env at deploy; keep secrets out of git):

```ini
[saman]
pg1-path=/var/lib/postgresql/data
repo1-type=s3
repo1-s3-endpoint=<S3 endpoint>
repo1-s3-bucket=saman-backups
repo1-s3-region=<region>
repo1-s3-key=<access key>
repo1-s3-key-secret=<secret key>
repo1-path=/pgbackrest
repo1-retention-full=4
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=<strong passphrase, stored offline with BACKUP_ENCRYPTION_PASSPHRASE>
```

- **Stanza & schedule:**

```bash
# one-time
docker compose exec -T postgres pgbackrest --stanza=saman stanza-create
docker compose exec -T postgres pgbackrest --stanza=saman check

# nightly full (e.g. 01:00), plus differential/incremental via cron in the backup sidecar
docker compose exec -T postgres pgbackrest --stanza=saman --type=full backup
docker compose exec -T postgres pgbackrest --stanza=saman --type=incr backup
docker compose exec -T postgres pgbackrest --stanza=saman info
```

- **Restore (PITR) outline** — full detail §6.4:

```bash
docker compose stop api worker
docker compose stop postgres
docker compose run --rm --entrypoint pgbackrest postgres --stanza=saman --delta restore
# then start postgres and replay to target time:
docker compose start postgres
```

The cipher passphrase for the PITR repo is **not** `BACKUP_ENCRYPTION_PASSPHRASE` unless configured so; store both offline and record which is which in the vault. Losing either makes the corresponding backups unrecoverable.

### 2.3 Object-storage backup

```bash
# inside the backup sidecar (or a host with mc/aws configured)
mc alias set local "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY"
mc version enable local/saman-files                 # already done by minio-init
mc mirror --overwrite local/saman-files offsite/saman-files
mc mirror --overwrite local/saman-backups offsite/saman-backups
```

Offsite target = external S3/MinIO bucket controlled by the customer (different provider/account/disk than the production server). For Iranian deployments use a second provider/region; for regulated customers, enable object lock/immutability on the offsite bucket.

### 2.4 Config & secrets backup

```bash
cd /opt/saman-erp
tar -czf /tmp/saman-config-$(date +%F).tar.gz \
  .env docker-compose.yml infra/ certs/ 2>/dev/null || true
gpg --batch --yes --symmetric --cipher-algo AES256 \
  --passphrase "$BACKUP_ENCRYPTION_PASSPHRASE" \
  -o /root/saman-config-$(date +%F).tar.gz.gpg /tmp/saman-config-$(date +%F).tar.gz
shred -u /tmp/saman-config-$(date +%F).tar.gz
```

Store the resulting `.gpg` offsite, in a location readable during a total-server-loss event. The following must also be in the offline vault (not only on the server): `BACKUP_ENCRYPTION_PASSPHRASE`, `APP_ENCRYPTION_KEY`, GPG/pgBackRest passphrases, and the `age`/GPG private keys if asymmetric encryption is used. **Without them, backups are worthless.**

---

## 3. Encryption

| Item | Algorithm | Key material | Stored where |
|---|---|---|---|
| DB dumps | GPG symmetric, `--cipher-algo AES256` | `BACKUP_ENCRYPTION_PASSPHRASE` | `.env` (host) + offline vault |
| Config archive | same as above | same passphrase (or separate) | offline vault |
| PITR repo | `repo1-cipher-type=aes-256-cbc` | `repo1-cipher-pass` in pgBackRest config | offline vault, distinct from dump passphrase |
| Channel credentials (DB) | AES-256-GCM (`ADR-0006`) | `APP_ENCRYPTION_KEY` + version | `.env` + offline vault |
| Offsite transport | TLS (S3 https) | provider creds | secret manager/`.env` |

Rules: never store the passphrase/key next to the backup; rotate passphrase only via a key-versioned procedure that keeps old backups readable; test decryption on every drill (an undecryptable backup is a failed backup).

---

## 4. Retention & lifecycle

| Tier | Where | Retention | Purpose |
|---|---|---|---|
| Recent dailies | MinIO `saman-backups` | `BACKUP_KEEP_DAYS` (30 d) | fast restore without offsite download |
| Offsite dailies | external S3 | 30–35 d | server/disk loss |
| Offsite weeklies | external S3 lifecycle (transition from dailies) | 12 weeks | accidental long-window data loss |
| Offsite monthlies | external S3 lifecycle | 12 months | audit/regulatory |
| Audit log partitions | S3 archive (Parquet/CSV + checksum) | 7 years (`ADR-0009`) | legal retention |
| PITR repo | external S3 (pgBackRest) | `repo1-retention-full=4` | point-in-time recovery window |

Example external-bucket lifecycle (S3-compatible APIs accept a similar rules JSON via `aws s3api put-bucket-lifecycle-configuration`):

```json
{
  "Rules": [
    { "ID": "expire-daily-dumps", "Filter": { "Prefix": "backups/postgres/" },
      "Status": "Enabled", "Expiration": { "Days": 35 } }
  ]
}
```

Checklist for retention: disk growth alert at 15 % free (RUNBOOK §3), retention is *never* the only disk-space control, and expired backups are removed only after a newer verified backup exists.

---

## 5. Verification (every backup, and weekly by a human)

**Automated (nightly, in the sidecar):**

1. Dump exit code 0 and file size > 0.
2. `sha256` manifest written and uploaded.
3. `pg_restore --list` on the plaintext dump **before deleting it** (proves readability):

```bash
pg_restore -l "$FILE" > /dev/null
```

4. GPG decrypt round-trip of the uploaded object (download to `/tmp`, decrypt, list, delete).
5. Backup age metric/alarm: newest object < 26 h → alert (`RUNBOOK §3.2`).

**Weekly (human, 10 minutes):**

```bash
mkdir -p /opt/saman-restore

# 1) list the newest objects (through the mc one-shot container; no host S3 port)
docker compose run --rm --entrypoint sh minio-init -c '
  mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null &&
  mc ls --recursive local/saman-backups/backups/postgres' | tail -5

# 2) download the chosen dump + checksum to the host (throwaway mc container with a bind mount)
docker run --rm --network saman-erp_backend \
  -v /opt/saman-restore:/out \
  -e S3_ENDPOINT -e S3_ACCESS_KEY -e S3_SECRET_KEY \
  --entrypoint sh minio/mc:RELEASE.2025-04-16T18-13-26Z -c '
    mc alias set local "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null &&
    mc cp "local/saman-backups/backups/postgres/saman-erp-YYYYMMDDTHHMMSSZ.dump.gpg" /out/ &&
    mc cp "local/saman-backups/backups/postgres/saman-erp-YYYYMMDDTHHMMSSZ.dump.sha256" /out/'
# network name: confirm with `docker network ls` (compose prefix is the project name)

# 3) checksum + decrypt + proof of readability
cd /opt/saman-restore
sha256sum -c saman-erp-YYYYMMDDTHHMMSSZ.dump.sha256
gpg --batch --yes --decrypt --passphrase "$BACKUP_ENCRYPTION_PASSPHRASE" \
  -o db.dump saman-erp-YYYYMMDDTHHMMSSZ.dump.gpg
pg_restore -l db.dump | head
```

Record: newest backup timestamp, size, decrypt+list result, schema version in the TOC.

**Quarterly:** full restore rehearsal into a fresh container (§6.2) with RTO measurement and the checklist in §9.

---

## 6. Restore procedures

### 6.1 Decide the recovery point

| Situation | Restore target |
|---|---|
| bad deploy with incompatible migration | last nightly backup **before** the deploy (or PITR to just before the migration) |
| accidental data deletion / wrong business action | PITR to `target-time` just before the event (if PITR enabled); otherwise last nightly (accept data loss) |
| host/disk loss | latest available dump (and latest WAL if PITR) |
| corruption | last backup verified clean; investigate after recovery |

Announce the expected data-loss window before starting (this is the customer-facing RPO fact).

### 6.2 Restore into a FRESH container (drill or production, non-destructive first)

Never test a restore by overwriting production. Use a separate container on a different port/network.

```bash
# 0) work dir on host
mkdir -p /opt/saman-restore && cd /opt/saman-restore

# 1) start a fresh PostgreSQL 16 container (scratch, port 55432)
docker run -d --name saman-restore-test \
  -e POSTGRES_PASSWORD='<scratch-hex>' \
  -p 127.0.0.1:55432:5432 \
  postgres:16-alpine
until docker exec saman-restore-test pg_isready -U postgres; do sleep 2; done
# attach the scratch DB to the compose backend network so api/migrate can reach it by name
docker network connect saman-erp_backend saman-restore-test

# 2) create db + roles + extensions + schema (same contract as INSTALL-FA §9.3)
docker exec -i saman-restore-test psql -U postgres -d postgres \
  -v migrator_pw="<migrator-hex>" -v app_pw="<app-hex>" <<'SQL'
CREATE DATABASE saman;
CREATE ROLE saman_migrator LOGIN PASSWORD :'migrator_pw';
CREATE ROLE saman_app      LOGIN PASSWORD :'app_pw';
\connect saman
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
GRANT CONNECT, CREATE ON DATABASE saman TO saman_migrator;
CREATE SCHEMA IF NOT EXISTS erp AUTHORIZATION saman_migrator;
GRANT USAGE ON SCHEMA erp TO saman_app;
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO saman_app;
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT USAGE, SELECT ON SEQUENCES TO saman_app;
SQL

# 3) download the chosen backup (dump + sha256) from MinIO/offsite to /opt/saman-restore
docker run --rm --network saman-erp_backend \
  -v /opt/saman-restore:/out \
  -e S3_ENDPOINT -e S3_ACCESS_KEY -e S3_SECRET_KEY \
  --entrypoint sh minio/mc:RELEASE.2025-04-16T18-13-26Z -c '
    mc alias set local "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null &&
    mc cp "local/saman-backups/backups/postgres/saman-erp-YYYYMMDDTHHMMSSZ.dump.gpg" /out/ &&
    mc cp "local/saman-backups/backups/postgres/saman-erp-YYYYMMDDTHHMMSSZ.dump.sha256" /out/'
# (network name: confirm with `docker network ls`; compose prefix is the project name)

# 4) verify checksum, decrypt
sha256sum -c saman-erp-YYYYMMDDTHHMMSSZ.dump.sha256
gpg --batch --yes --decrypt \
  --passphrase "$BACKUP_ENCRYPTION_PASSPHRASE" \
  -o db.dump saman-erp-YYYYMMDDTHHMMSSZ.dump.gpg

# 5) restore as the schema owner (roles/extensions already exist; schema/extension TOC entries skipped)
pg_restore -l db.dump | grep -vE ' (EXTENSION|COMMENT - EXTENSION|SCHEMA) - ' > restore.toc
pg_restore --no-owner --no-acl -L restore.toc \
  -d "postgres://saman_migrator:<migrator-hex>@127.0.0.1:55432/saman" db.dump

# 6) migrations head check (from the API image on the compose network; must be no-op/clean; replace 1.0.0 with your IMAGE_TAG)
docker run --rm --network saman-erp_backend \
  -e DATABASE_URL="postgres://saman_app:<app-hex>@saman-restore-test:5432/saman" \
  -e MIGRATION_DATABASE_URL="postgres://saman_migrator:<migrator-hex>@saman-restore-test:5432/saman" \
  -e NODE_ENV=production \
  saman-erp/api:1.0.0 pnpm db:migrate

# 7) verify counts and invariants
psql "postgres://saman_migrator:<migrator-hex>@127.0.0.1:55432/saman" -c "
SELECT count(*) AS tables FROM information_schema.tables WHERE table_schema='erp';
SELECT count(*) AS users FROM erp.users;
SELECT count(*) AS ledger_rows FROM erp.inventory_transactions;
SELECT max(created_at) AS newest_ledger FROM erp.inventory_transactions;"

# 8) smoke test: run a temporary API from the real compose file, pointed at the scratch DB
#    (it joins the backend network, so the real Redis/MinIO credentials from .env work;
#     SMS is mocked and channel sync is disabled so the drill never contacts providers)
cd /opt/saman-erp
docker network connect saman-erp_backend saman-restore-test 2>/dev/null || true
docker compose run -d --rm --no-deps --name saman-restore-api \
  --publish 127.0.0.1:14000:4000 \
  -e DATABASE_URL="postgres://saman_app:<app-hex>@saman-restore-test:5432/saman" \
  -e APP_URL=http://127.0.0.1:14000 -e COOKIE_SECURE=false \
  -e SMS_MODE=mock -e CHANNEL_SYNC_ENABLED=false -e DOCS_ENABLED=false \
  api
sleep 15
curl -fsS http://127.0.0.1:14000/health/live
curl -fsS http://127.0.0.1:14000/health/ready
# login through a web container pointed at this API (or POST /api/v1/auth/login with the restored admin),
# then read a product and an order. Cleanup:
docker rm -f saman-restore-api
docker network disconnect saman-erp_backend saman-restore-test
```

> The smoke API needs reachable Redis/S3 for `/health/ready`; `/health/live` + a direct `psql` invariant check is a weaker but acceptable data-only drill. The **release-gate drill must include a real login and a product/order read** (§9 steps 8–9). Never run the scratch API with production SMS/channel credentials or `CHANNEL_SYNC_ENABLED=true`.

**Why filter the TOC?** The dump contains `CREATE EXTENSION` entries that require superuser/ownership and would collide with the pre-created extensions, and `CREATE SCHEMA erp` would duplicate the schema we created for `ALTER DEFAULT PRIVILEGES`. `pg_restore -L` with a filtered list applies everything else deterministically, without `|| true` masking real errors. Verify the TOC filter output contains the expected tables:

```bash
grep -c ' TABLE ' restore.toc
head -20 restore.toc
```

**Why restore as `saman_migrator` with `--no-owner`?** Objects get created by the migrator, so the `ALTER DEFAULT PRIVILEGES` grants apply at creation time and `saman_app` can use the restored tables without a separate grant pass. `--no-owner/--no-acl` keeps the dump portable.

### 6.3 Production cutover (after a failed drill-free decision)

Only after the fresh-container restore has passed verification:

```bash
cd /opt/saman-erp

# 1) stop traffic
docker compose stop api worker web

# 2) safety: archive the current (broken/old) database instead of dropping blindly
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -c "
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='saman' AND pid <> pg_backend_pid();"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -c "
ALTER DATABASE saman RENAME TO saman_old_$(date +%Y%m%d_%H%M);"

# 3) recreate empty database (schema/roles/extensions + default privileges contract — a NEW database starts with no default ACLs)
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE saman;"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d saman -c "
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE SCHEMA IF NOT EXISTS erp AUTHORIZATION saman_migrator;
GRANT USAGE ON SCHEMA erp TO saman_app, saman_readonly, saman_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO saman_app;
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT SELECT ON TABLES TO saman_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT USAGE, SELECT ON SEQUENCES TO saman_app;"

# 4) copy the verified dump into the production postgres container and restore as the schema owner
docker compose cp /opt/saman-restore/db.dump postgres:/tmp/db.dump
docker compose exec -T postgres sh -c '
  pg_restore -l /tmp/db.dump | grep -vE " (EXTENSION|COMMENT - EXTENSION|SCHEMA) - " > /tmp/restore.toc &&
  PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --no-owner --no-acl -L /tmp/restore.toc \
    -h 127.0.0.1 -U saman_migrator -d saman /tmp/db.dump'

# 5) head check + start
docker compose --profile tools run --rm migrate
docker compose up -d api worker web
docker compose exec -T api wget -qO- http://127.0.0.1:4000/health/ready
```

Then run the smoke test: login (Persian UI) → product list → open an order → view journal; verify outbox lag drains; check `integration_dead_letters`.

Rollback of the restore itself: rename `saman` back to a scratch name and rename `saman_old_*` to `saman`, restart — only if the restore verification failed and the old database is still intact.

### 6.4 PITR restore (optional profile)

```bash
cd /opt/saman-erp
docker compose stop api worker
docker compose stop postgres

# restore the physical backup into the existing pgdata volume (pgBackRest --delta keeps the repo delta small)
docker compose run --rm --entrypoint pgbackrest postgres --stanza=saman --delta restore

# for an explicit point in time, first disable app writes and restore to target:
# docker compose run --rm --entrypoint pgbackrest postgres \
#   --stanza=saman --delta --type=time --target='2026-10-19 14:30:00+03:30' --target-action=promote restore

docker compose start postgres
docker compose exec -T postgres pgbackrest --stanza=saman info
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d saman -c "select pg_is_in_recovery();"

# only after recovery completed and verification passed:
docker compose up -d api worker
docker compose --profile backup run --rm backup once    # fresh full backup immediately after recovery
```

### 6.5 Restore from complete server loss

1. Provision a new Ubuntu host (`INSTALL-FA §2–5`) with the **same `APP_ENCRYPTION_KEY` and passphrases from the vault**.
2. Restore config archive to `/opt/saman-erp` (`.env`, `docker-compose.yml`, `docker-compose.prod.yml`, `infra/`, `certs/`).
3. `docker compose pull` (images are in the registry/exported tarballs; keep an exported `images-1.0.0.tar` offsite if the registry is unavailable).
4. Restore DB (§6.2/§6.3) and `saman-files` (`mc mirror offsite/saman-files local/saman-files`).
5. DNS: point `erp.carexy.shop` to the new IP; re-issue TLS (Caddy auto or `certbot`).
6. Verify: readiness, login, product list, order, journal, backup job resumed.
7. Measure RTO (provisioning + restore + verification) and record.

---

## 7. Offsite strategy

| Layer | Mechanism | Verification |
|---|---|---|
| DB dumps | backup sidecar uploads to `saman-backups` and, when `BACKUP_MIRROR_S3_*` is configured, mirrors the same encrypted object to the offsite bucket (fallback: host `mc mirror`/`rclone` cron) | weekly object list + size on offsite |
| File bucket | `mc mirror --overwrite` nightly to offsite; versioning on source | sample download monthly |
| Config/secrets | manual encrypted archive after every change | decrypt test quarterly |
| Images | registry + exported image tarball stored offsite | pull/`docker load` test quarterly |
| Audit archive | yearly partition export + checksum to S3 archive | checksum verification |

Offsite credentials must be read-only on the production host where possible (write-only to the backup bucket, no delete) to limit blast radius of a compromised server; deletion/lifecycle is managed by the customer's cloud admin, not the app server.

---

## 8. Automation schedule (reference)

```cron
# /etc/cron.d/saman-backup (alternative when the sidecar profile is not used)
0 2 * * *  saman  cd /opt/saman-erp && docker compose --profile backup run --rm backup once >> /var/log/saman-backup.log 2>&1
15 2 * * * saman  /opt/saman-erp/infra/backup/mirror-offsite.sh >> /var/log/saman-offsite.log 2>&1
30 3 * * * saman  /opt/saman-erp/infra/backup/verify-latest.sh >> /var/log/saman-backup-verify.log 2>&1
```

Guard against overlap and failures with `flock`:

```bash
flock -n /var/lock/saman-backup.lock -c 'docker compose --profile backup run --rm backup once'
```

The sidecar is the preferred path (scoped credentials, separate container); host cron is the fallback. Either way: one scheduler, one code path, log retention, and an alert if the last success is older than 26 h.

---

## 9. RPO/RTO rehearsal checklist (quarterly, signed)

| # | Step | Expected | Record |
|---|---|---|---|
| 1 | Pick a backup (and PITR target if enabled) | backup < 26 h | timestamp |
| 2 | Download from offsite (not local MinIO only) | checksum matches | download time |
| 3 | Decrypt with offline passphrase | success | operator |
| 4 | `pg_restore -l` | readable TOC | table count |
| 5 | Restore into fresh container (§6.2) | exit 0, no errors | elapsed |
| 6 | `pnpm db:migrate` head check | no-op/clean | version |
| 7 | Counts: users, ledger rows, last ledger timestamp | match source snapshot | numbers |
| 8 | Invariants: trial balance balanced; `Σ ledger = balances` (job/query) | balanced | pass/fail |
| 9 | Start API against scratch DB + login/product/order smoke | works, Persian UI | pass/fail |
| 10 | Measure **RTO** (steps 1–9) | ≤ 1 h | minutes |
| 11 | Measure **RPO** (data loss window) | ≤ 15 min with PITR / documented 24 h default | minutes |
| 12 | Restore `saman-files` sample object | download OK | pass/fail |
| 13 | Sign-off (operator + platform lead) | — | date |

Failure of any step = **failed drill**; open a P1 hardening ticket and repeat within 2 weeks. Record the drill in the operations log and update this document with any deviation.

---

## 10. Roles & responsibilities

| Activity | Owner |
|---|---|
| Scheduled backups running | Platform/SRE (alerted) |
| Offsite mirroring & lifecycle | Customer cloud admin + Platform |
| Passphrase/key custody | Security lead + customer executive (two-person rule recommended) |
| Restore drill execution | SRE/operator |
| Restore decision during incident | Platform lead + customer owner |
| Audit archive | Finance/legal + Platform |

---

## Appendix A — Variables referenced

| Variable | Use in this document |
|---|---|
| `BACKUP_ENABLED` | enable scheduled backups |
| `BACKUP_CRON` | 02:00 nightly schedule |
| `BACKUP_KEEP_DAYS` | local retention / cleanup |
| `BACKUP_S3_PREFIX` | locating objects under `saman-backups` |
| `BACKUP_ENCRYPTION_PASSPHRASE` | GPG symmetric encryption/decryption |
| `BACKUP_MIRROR_S3_ENDPOINT` / `BACKUP_MIRROR_S3_BUCKET` / `BACKUP_MIRROR_S3_ACCESS_KEY` / `BACKUP_MIRROR_S3_SECRET_KEY` | optional offsite mirror (implemented in `backup.sh`; pending canonical `.env.example` addition) |
| `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | MinIO/S3 access for upload/download/mirror |
| `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD` | admin operations on the container DB |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | `mc` one-shot container alias/listing during verification |
| `REDIS_PASSWORD` | Redis is not backed up; referenced when deciding whether a queue-only loss is acceptable |
| `MIGRATION_DATABASE_URL` | dump source role and restore target (schema owner) |
| `DATABASE_URL` | app connection used in the post-restore smoke check |
| `APP_URL`, `COOKIE_SECURE`, `DOCS_ENABLED` | overridden on the temporary restore-smoke API so the drill never links to production or exposes docs |
| `APP_ENCRYPTION_KEY` | must be preserved to decrypt channel credentials after restore |
| `IMAGE_TAG` | restored image version / migration head check |
| `SMS_MODE`, `CHANNEL_SYNC_ENABLED` | post-restore smoke considerations (avoid sending real messages during drills) |

**End of document — v1.0**
