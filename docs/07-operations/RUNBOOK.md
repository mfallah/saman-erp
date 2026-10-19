# 07 — Operations Runbook (English)

**Status:** Design baseline v1.0 · Owner: DevOps/Platform Lead · Audience: on-call operators/SRE.
**Companions:** [`../06-deployment/INSTALL-FA.md`](../06-deployment/INSTALL-FA.md) (Persian install), [`../06-deployment/DEPLOYMENT.md`](../06-deployment/DEPLOYMENT.md) (deployment contract), [`BACKUP-RESTORE.md`](./BACKUP-RESTORE.md).

> **Verification honesty:** Docker was **not available** in the design/build environment. The commands and SQL below are specified by review against `ARCHITECTURE.md §12/§13/§14`, the ADRs, and the canonical `.env.example`. They must be validated during the first real deployment and the quarterly restore drill; anything that fails is a bug in this runbook. Metric *names* are illustrative — verify actual names in `GET /metrics` before wiring alerts (see §4).

---

## 1. Quick reference

### 1.1 Endpoints

| What | URL | Notes |
|---|---|---|
| Admin UI | `https://erp.carexy.shop` | Persian, RTL |
| API base | `https://erp.carexy.shop/api/v1` | same-origin through `web` |
| Liveness | `https://erp.carexy.shop/health/live` | public via `web` |
| Readiness | `https://erp.carexy.shop/health/ready` | public via `web` |
| Version | internal `api:4000/health/version` | not proxied publicly |
| Metrics | internal `api:4000/metrics` | never public |
| MinIO console | `127.0.0.1:9001` | SSH tunnel only |
| Grafana (optional) | `127.0.0.1:3000` | SSH tunnel only |

### 1.2 Golden commands

Load `.env` values into the shell first so `$POSTGRES_USER`, `$REDIS_PASSWORD`, etc. resolve (one time per session):

```bash
cd /opt/saman-erp
set -a; . ./.env; set +a
docker compose ps
docker compose logs -f --tail=200 api
docker compose exec -T api wget -qO- http://127.0.0.1:4000/health/ready
docker compose exec -T api wget -qO- http://127.0.0.1:4000/health/version
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select now();"
df -h /; free -h; docker stats --no-stream
```

MinIO/S3 inspection uses the `minio-init` (mc) container because the S3 port is not published on the host; the `local` alias is created inside each one-shot command:

```bash
docker compose run --rm --entrypoint sh minio-init -c '
  mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ls --recursive local/saman-backups'
```

### 1.3 Backup / restore commands

```bash
docker compose --profile backup run --rm backup once          # ad-hoc backup
docker compose --profile backup logs --tail=100 backup
docker compose run --rm --entrypoint sh minio-init -c '
  mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ls --recursive local/saman-backups/backups/postgres'
```

Restore: see [`BACKUP-RESTORE.md §6`](./BACKUP-RESTORE.md).

### 1.4 Severity & response

| Severity | Definition | Ack | Mitigate | Examples |
|---|---|---|---|---|
| P1 | service down or data at risk | 15 min | 2 h | API 5xx > 50 %, DB down, disk full, corruption suspicion |
| P2 | major degradation | 30 min | 8 h | channel sync broken, readiness flapping, worker stopped |
| P3 | minor degradation | 1 business day | 3 days | single report slow, one channel rate-limited |
| P4 | cosmetic/ask | 3 business days | next sprint | label formatting, docs |

Escalation: on-call operator → platform lead → DBA (external DB) → security lead (credential/breach suspicion). Record every P1/P2 in the incident log with timeline and commands run.

---

## 2. Scheduled checks

Times are `Asia/Tehran`. All commands run as the service user from `/opt/saman-erp`.

### 2.1 Daily (5 minutes, every morning)

```bash
# 1) all containers up & healthy?
docker compose ps

# 2) readiness + version
docker compose exec -T api wget -qO- http://127.0.0.1:4000/health/ready
docker compose exec -T api wget -qO- http://127.0.0.1:4000/health/version

# 3) errors in the last 24h (count, then inspect top messages)
docker compose logs --since 24h --no-color api | jq -r 'select(.level=="error") | .msg' | sort | uniq -c | sort -rn | head -20

# 4) outbox / queue health
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT count(*) FILTER (WHERE processed_at IS NULL) AS pending,
       min(created_at) FILTER (WHERE processed_at IS NULL) AS oldest_pending,
       round(extract(epoch FROM now() - min(created_at) FILTER (WHERE processed_at IS NULL))) AS lag_seconds
FROM erp.outbox_events;"

# 5) last backup exists and is fresh (age < 26h)
docker compose run --rm --entrypoint sh minio-init -c '
  mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ls --recursive local/saman-backups/backups/postgres' | tail -5

# 6) disk & memory
df -h /; free -h

# 7) TLS certificate validity (> 14 days)
echo | openssl s_client -servername erp.carexy.shop -connect erp.carexy.shop:443 2>/dev/null | openssl x509 -noout -enddate
```

Record: date, errors count, outbox lag, backup age, disk %, cert days. Anything red → open a ticket and follow the matching scenario in §11.

### 2.2 Weekly (30 minutes)

```bash
# W1) DB size growth and top tables
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS size
FROM pg_class WHERE relkind='r' AND relnamespace='erp'::regnamespace
ORDER BY pg_total_relation_size(oid) DESC LIMIT 15;"

# W2) partitions for next 2 months exist
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT inhrelid::regclass AS partition FROM pg_inherits
WHERE inhparent::regclass::text LIKE 'erp.%'
ORDER BY 1 DESC LIMIT 10;"

# W3) long-running / idle-in-transaction sessions
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT pid, usename, state, round(extract(epoch FROM now()-query_start)) AS secs, left(query,80)
FROM pg_stat_activity WHERE datname='saman' AND state <> 'idle'
ORDER BY secs DESC LIMIT 10;"

# W4) dead letters & failed jobs
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT count(*) FROM erp.integration_dead_letters WHERE resolved_at IS NULL;"

# W5) backup restoration spot-check: pg_restore --list on latest dump
docker compose --profile backup exec backup sh -c 'ls -t /backups/*.gpg | head -1'

# W6) OS patches pending
sudo apt-get update -qq && apt list --upgradable 2>/dev/null | head -20
```

### 2.3 Monthly

- Review alert thresholds and 30-day trends (5xx %, p95 latency, outbox lag, DB connections).
- Verify offsite backup copies exist (see `BACKUP-RESTORE §7`).
- Rotate/cleanup access: users, roles, SSH keys, API keys of terminated staff (`ADR-0008` audit trail).
- Check index bloat and schedule any offline maintenance (§5).
- Review disk growth against the 12-month projection; plan expansion before 25 % free.
- Update dependency/security advisories for images (`docker scout`/Trivy in CI, not on the host).
- Quarterly: full restore drill (`BACKUP-RESTORE §9`), PITR drill if enabled, TLS/cert incident rehearsal.

---

## 3. Health, metrics & alert thresholds

### 3.1 Health semantics

| Check | Command | Expected |
|---|---|---|
| containers | `docker compose ps` | all `Up`/`healthy` except one-shot `Exited (0)` |
| liveness | `wget -qO- http://127.0.0.1:4000/health/live` | HTTP 200 |
| readiness | `.../health/ready` | HTTP 200; 503 = DB/Redis/S3 dependency problem |
| version | `.../health/version` | matches `IMAGE_TAG` and DB schema version |
| web | `curl -fsS 127.0.0.1:8080/healthz` | HTTP 200 |
| worker | outbox lag query (§2.1.4) + logs | lag < 60 s |
| backup | newest object age | < 26 h |

### 3.2 Metrics to watch

Metric names below are the **expected** Prometheus names; confirm the actual names by scraping `/metrics` once and adapt the alert rules. If a metric does not exist, the SQL fallback in this runbook is authoritative.

| Signal | Expected metric | Warning | Critical | Meaning / action |
|---|---|---|---|---|
| HTTP 5xx ratio | `http_requests_total{status=~"5.."}` | > 1 % (5 min) | > 5 % (5 min) | app/DB problem → §11.1/§11.4 |
| p95 read latency | `http_request_duration_seconds` | > 300 ms | > 800 ms | DB contention, missing index → §5.4 |
| p95 write latency | same histogram, write routes | > 800 ms | > 2 s | lock contention, disk saturation |
| DB pool usage | `db_pool_*` | > 80 % | > 95 % | connection leak/load → §9 |
| DB connections | `pg_stat_activity_count` | > 80 % of `max_connections` | > 95 % | scale/pool/PgBouncer |
| outbox lag | `outbox_lag_seconds` | > 60 s | > 300 s | worker stalled → §4.1 |
| outbox pending | `outbox_pending_total` | > 5 000 | > 50 000 | worker down/backlog |
| queue failed | `bullmq_jobs_failed_total` | > 10 | > 100 | poison jobs → §4.2 |
| queue depth | `bullmq_queue_depth` | > 1 000 | > 10 000 | scale workers |
| dead letters | `integration_dead_letters_open` | > 0 | > 10 | channel contract/permanent failure → §4.3 |
| worker heartbeat age | `worker_heartbeat_age_seconds` | > 120 s | > 300 s | worker dead → §11.9 |
| disk avail | node exporter `node_filesystem_avail_bytes` | < 15 % | < 7 % | §6 disk playbook |
| backup age | pushgateway/script metric or S3 object age | > 26 h | > 48 h | backup broken → §11.11 |
| cert expiry | `ssl_certificate_not_after` (blackbox) | < 21 d | < 7 d | §10 cert renewal |
| MinIO/S3 errors | `s3_operation_errors_total` | > 0 sustained | > 10/min | uploads failing → §11.10 |
| channel failure rate | `channel_sync_failures_total{channel}` | > 5 % (15 min) | > 25 % | provider outage → §11.3 |
| Redis memory | `redis_memory_used_bytes` | > 80 % of maxmemory | > 95 % | queue growth, `noeviction` risk → §11.2 |
| time offset | node exporter `node_timex_offset_seconds` | > 0.5 s | > 2 s | NTP broken → JWT/OTP/webhook fail |

### 3.3 Alert wiring (minimum viable)

- Scrape `api:4000/metrics` from an internal Prometheus (profile `observability` or customer Prometheus on the same host/VPN).
- Scrape node/log/host metrics via node-exporter; alert on disk, RAM, clock offset.
- Alertmanager route: P1 → phone/SMS + chat; P2 → chat; P3 → ticket.
- Add a **dead-man** alert on the backup job (e.g., pushgateway or S3 object age) — silent backup failure is the most dangerous alert gap.

---

## 4. Outbox & queue lag

### 4.1 Outbox lag (events not dispatched)

**Symptom:** `outbox_lag_seconds` high; channel stock/prices not updating; journals delayed; `integration_dead_letters` growing.

```bash
# 1) Is the worker alive and polling?
docker compose ps worker
docker compose logs --tail=200 worker | jq -r 'select(.level=="error" or .level=="warn")'

# 2) Backlog size/age distribution
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT event_type,
       count(*) AS pending,
       round(extract(epoch FROM now()-min(created_at))) AS oldest_secs
FROM erp.outbox_events WHERE processed_at IS NULL
GROUP BY event_type ORDER BY pending DESC;"

# 3) Attempts / poison events
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT id, event_type, attempts, available_at, left(payload::text,120)
FROM erp.outbox_events
WHERE processed_at IS NULL AND attempts >= 5
ORDER BY available_at LIMIT 20;"
```

**Actions, in order:**

1. If worker is down/crash-looping → §11.9. Restarting alone is safe: handlers are idempotent (`ADR-0010`).
2. If worker is up but idle while lag grows → check `OUTBOX_POLL_INTERVAL_MS`, Redis connectivity, and `LISTEN/NOTIFY` hints. Restart worker; verify `pending` decreases within 60 s.
3. If a single event type is stuck, inspect its handler error in logs; permanent → fix code/config, or quarantine (below) and alert the module owner.
4. Scale: `docker compose up -d --no-deps --scale worker=2 worker` (if the implementation supports scaling; otherwise raise `WORKER_CONCURRENCY` and restart worker).
5. **Quarantine/replay** (only after the cause is fixed; requires DBA approval; run inside a transaction):

```sql
-- inspect one event
SELECT id, event_type, aggregate_id, attempts, payload FROM erp.outbox_events WHERE id = :id;

-- make it eligible again (do NOT modify business tables)
UPDATE erp.outbox_events
SET attempts = 0, available_at = now()
WHERE id = :id;

-- bulk replay of one event type created after a timestamp
UPDATE erp.outbox_events
SET attempts = 0, available_at = now()
WHERE processed_at IS NULL AND event_type = :event_type AND created_at < now() - interval '10 minutes';
```

Never delete unprocessed outbox rows: they are the source of truth for "must still happen".

### 4.2 Queue failures (BullMQ)

```bash
docker compose logs --tail=300 worker | grep -iE 'failed|stalled|error' | tail -50
docker compose exec -T redis redis-cli -a "$REDIS_PASSWORD" INFO keyspace
docker compose exec -T redis redis-cli -a "$REDIS_PASSWORD" LLEN bull:channel-sync:wait   # queue names per ADR-0010
```

- **Stalled jobs:** BullMQ recovers them when the worker restarts. `docker compose restart worker`, then confirm depth decreases.
- **Poison job:** identify by job id/key in logs; remove from the failed set only after capturing the payload for a bug ticket. If it is a channel sync job, the outbox row remains and will re-emit after fix.
- **Redis memory pressure:** `noeviction` is intentional for queue correctness; growing memory means backlog → scale worker or pause a noisy producer, do not enable eviction.

### 4.3 Dead letters & channel outage

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT channel, event_type, count(*), max(created_at)
FROM erp.integration_dead_letters WHERE resolved_at IS NULL
GROUP BY channel, event_type ORDER BY 3 DESC;"
docker compose logs --since 1h --no-color worker | grep -i "$(echo ${CHANNEL:-carexy})"
```

Provider outage playbook in §11.3. After recovery, replay unresolved dead letters through the module's retry command or by resetting the corresponding outbox rows (same procedure as §4.1 step 5) — never hand-edit `sales_orders`/`inventory_*`.

---

## 5. Database maintenance

All SQL as the admin role (`$POSTGRES_USER`) unless noted. Use `psql` inside the container.

### 5.1 Size & growth

```sql
-- database size
SELECT pg_size_pretty(pg_database_size('saman'));
-- top tables
SELECT relname, pg_size_pretty(pg_total_relation_size(oid))
FROM pg_class WHERE relkind='r' AND relnamespace='erp'::regnamespace
ORDER BY pg_total_relation_size(oid) DESC LIMIT 15;
-- partition inventory (per month)
SELECT inhrelid::regclass AS partition, pg_size_pretty(pg_total_relation_size(inhrelid))
FROM pg_inherits WHERE inhparent::regclass::text IN ('erp.inventory_transactions','erp.audit_logs','erp.api_request_logs')
ORDER BY 1 DESC;
```

### 5.2 Vacuum, analyze, bloat

```sql
-- autovacuum activity
SELECT relname, last_vacuum, last_autovacuum, last_analyze, last_autoanalyze, n_dead_tup
FROM pg_stat_user_tables WHERE schemaname='erp'
ORDER BY n_dead_tup DESC LIMIT 15;

-- table bloat estimate (needs pgstattuple extension; may be unavailable on managed DB)
-- SELECT * FROM pgstattuple('erp.inventory_balances');
```

Actions:

- Hot tables (`inventory_balances`, `sales_orders`) should show frequent autovacuum. If `n_dead_tup` grows and autovacuum lags, tighten per-table settings (requires migrator/owner):

```sql
ALTER TABLE erp.inventory_balances SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
ALTER TABLE erp.sales_orders SET (autovacuum_vacuum_scale_factor = 0.05);
```

- Manual maintenance (off-peak, short lock; avoid on huge tables during business hours):

```sql
VACUUM (ANALYZE, VERBOSE) erp.inventory_balances;
-- last resort for heavy bloat during a maintenance window:
-- VACUUM (FULL, ANALYZE) erp.inventory_balances;  -- takes an exclusive lock
```

### 5.3 Partition maintenance

The `maintenance` worker job creates the next 2 monthly partitions daily (`ADR-0009`). Verify; if missing, create manually (name pattern must match `DATA-MODEL.md`; example below assumes `<table>_YYYY_MM`):

```sql
-- list partitioned parents
SELECT relname FROM pg_class WHERE relkind='p' AND relnamespace='erp'::regnamespace;

-- example: create next month before it is needed
CREATE TABLE IF NOT EXISTS erp.inventory_transactions_2026_11
  PARTITION OF erp.inventory_transactions
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE INDEX IF NOT EXISTS ix_inventory_transactions_2026_11_created_at_brin
  ON erp.inventory_transactions_2026_11 USING brin (created_at);
```

If an insert fails with `no partition of relation ... found for row`, it is a **P1** (writes rejected). Create the missing partitions immediately for all partitioned parents, then alert the platform lead: the maintenance job is broken.

Retention (per `ADR-0009`): `api_request_logs` 90 d, `channel_api_calls` 180 d, processed `outbox_events` 30 d, `audit_logs` 7 y (archive to S3 then detach). Detach/drop only after export + checksum:

```sql
-- DETACH is cheap; DROP frees space but is irreversible
ALTER TABLE erp.api_request_logs DETACH PARTITION erp.api_request_logs_2026_05;
-- after archive verification:
DROP TABLE IF EXISTS erp.api_request_logs_2026_05;
```

### 5.4 Slow queries

```sql
-- requires pg_stat_statements extension; if unavailable use pg_stat_activity sampling
SELECT round(total_exec_time::numeric,1) AS total_ms, calls,
       round(mean_exec_time::numeric,2) AS mean_ms, left(query,120)
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15;
-- reset stats after remediation (careful: affects dashboards)
-- SELECT pg_stat_statements_reset();
```

```sql
-- lock waits/deadlocks
SELECT blocked.pid AS blocked_pid, blocking.pid AS blocking_pid,
       left(blocked.query,80), left(blocking.query,80)
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE blocked.datname='saman';
```

Deadlocks are retried by the app (max 3, `ARCHITECTURE §6`), but recurring ones indicate a lock-order bug — file a ticket with the query pair.

### 5.5 Indexes

```sql
-- unused indexes (candidates for removal; verify over a full business cycle)
SELECT relname, indexrelname, idx_scan FROM pg_stat_user_indexes
WHERE schemaname='erp' AND idx_scan = 0 ORDER BY pg_relation_size(indexrelid) DESC LIMIT 15;
-- duplicate indexes
SELECT indexrelname, relname FROM pg_stat_user_indexes WHERE schemaname='erp'
ORDER BY relname, indexrelname;
```

Index changes ship as migrations, never as ad-hoc `CREATE INDEX` in production (except `CONCURRENTLY` emergencies, then convert to a migration). See `ADR-0003`.

---

## 6. Disk full playbook

**Symptom:** `df -h /` > 90 %; writes fail (`could not extend file`, `No space left on device`); API 5xx; `pg_wal` growth.

```bash
# 1) where is space going?
df -h /; df -i /
sudo du -xh --max-depth=2 /var/lib/docker 2>/dev/null | sort -rh | head -20
docker system df
docker ps -a --format '{{.Names}}' | while read c; do echo "== $c"; docker inspect -f '{{.LogPath}}' "$c" | xargs -r ls -lh; done

# 2) DB/WAL/backup inside volumes
docker compose exec -T postgres du -sh /var/lib/postgresql/data /var/lib/postgresql/data/pg_wal
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d saman -c "SELECT pg_size_pretty(sum(size)) FROM pg_ls_waldir();"
docker compose exec -T backup du -sh /backups
```

**Mitigation order (stop the bleeding before deleting anything):**

1. **Pause non-essential producers:** `docker compose stop backup` (it will resume after cleanup); consider pausing heavy report/export jobs in the UI.
2. **Truncate oversized container logs** (safe; Docker rotates at 20 MB × 5 but a misconfigured daemon may not):

```bash
sudo find /var/lib/docker/containers -name '*-json.log' -size +200M -exec truncate -s 0 {} \;
```
3. **Remove old local backup staging only after confirming offsite copies** (`BACKUP-RESTORE §7`):

```bash
docker compose --profile backup exec backup sh -c 'find /backups -name "*.gpg" -mtime +7 -delete'
docker image prune -f          # dangling images only; no volumes
docker builder prune -f        # build cache
```
4. **Drop verified old partitions** (§5.3) after archive + checksum.
5. **WAL growth:** check `pg_wal` and archival. If PITR is enabled, `pgbackrest check`; if WAL is stuck due to an archiver failure, fix archiving (do not delete WAL manually). If no PITR, large `pg_wal` normal during write spikes; `CHECKPOINT;` may help reclaim.
6. **Expand disk** (cloud/LVM: `lvextend`/`resize2fs`) — the durable fix. Target ≥ 25 % free afterwards.
7. **Never** `rm` files from `pgdata`; never `docker compose down -v`.

Post-incident: check root cause (log flood, missing rotation, backup staging accumulation, partition retention not running), add a disk-growth alert, and update capacity plan.

---

## 7. OOM / memory pressure

**Symptom:** `OOMKilled` in `docker inspect`; API restarts; slow queries after restart; cgroup memory at limit.

```bash
docker inspect -f '{{.Name}} {{.State.OOMKilled}}' $(docker compose ps -q)
dmesg -T | grep -iE 'oom|killed process' | tail -20
docker stats --no-stream
free -h; vmstat 1 5
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d saman -c "SHOW shared_buffers; SHOW work_mem; SHOW max_connections;"
```

Actions:

1. Identify the container killed: likely `api` (heavy report), `worker` (import/export), or `postgres` (too-high `work_mem` × concurrency).
2. Bound the offender: lower `DB_POOL_MAX`, `WORKER_CONCURRENCY`, or report batch size; restart the container.
3. PostgreSQL: ensure `shared_buffers` ≤ 25 % RAM and `work_mem` small (16–32 MB) because it multiplies per sort/hash node; tune per-session for heavy jobs instead.
4. Add/adjust Compose memory limits and swap (host has 4 GB swap per `INSTALL-FA §3.3`); swap prevents OOM-kill but slows queries — treat as cushion, not capacity.
5. If node memory is the issue, check other host processes; add RAM or move MinIO/offsite components.

Log the incident; recurring OOM at normal load means sizing is wrong, not a one-off.

---

## 8. TLS certificates

### 8.1 Caddy (profile `tls`)

Caddy renews automatically ~30 days before expiry and stores certs in `caddy_data`.

```bash
docker compose logs --tail=100 caddy | grep -iE 'certificate|renew|acme|error'
docker compose exec -T caddy caddy list-certificates
echo | openssl s_client -servername erp.carexy.shop -connect erp.carexy.shop:443 2>/dev/null | openssl x509 -noout -enddate
```

If renewal fails: check DNS A record, ports 80/443 reachable from internet, ACME rate limit, and logs. For testing, temporarily use the Let's Encrypt **staging** CA in `infra/nginx/Caddyfile` (`acme_ca https://acme-staging-v02.api.letsencrypt.org/directory`), then remove it.

### 8.2 Host nginx + certbot

```bash
sudo certbot certificates
sudo certbot renew --dry-run
sudo systemctl status certbot.timer
sudo certbot renew --force-renewal -d erp.carexy.shop   # only if genuinely needed (rate limits!)
sudo nginx -t && sudo systemctl reload nginx
```

If port 80 is firewalled, either open it for ACME or use DNS-01 challenge (documented in `infra/nginx` notes). Never disable TLS verification to "fix" a cert problem.

---

## 9. Connection, lock & performance incidents

### 9.1 DB connections exhausted

```sql
SELECT count(*), state, usename FROM pg_stat_activity WHERE datname='saman' GROUP BY 2,3;
SELECT pid, usename, state, round(extract(epoch FROM now()-state_change)) AS state_secs, left(query,80)
FROM pg_stat_activity WHERE datname='saman' ORDER BY state_secs DESC LIMIT 20;
```

- `idle in transaction` sessions: find owner; they indicate a leaked transaction. The app has a 60s role timeout, but check API/worker logs.
- Terminate a runaway query **only** after confirming it is not a migration/backup: `SELECT pg_terminate_backend(:pid);`
- Budget check: `DB_POOL_MAX × api replicas + pool × worker replicas + headroom ≤ max_connections`. Reduce replicas/pool or add PgBouncer (`DEPLOYMENT §9.3`).
- Restarting `api` releases its pool; do it one replica at a time.

### 9.2 High latency / slow writes

1. Check `df`, `vmstat`, disk wait (`iostat -x 1` if installed) — saturation shows as high `%util`/`await`.
2. Check locks (§5.4) and partition existence (§5.3).
3. Check autovacuum bloat (§5.2).
4. Check Redis latency (`redis-cli --latency -a "$REDIS_PASSWORD"`).
5. Confirm p95 budget (`docs/00-overview §3`: read < 200 ms, write < 500 ms); if a specific endpoint regressed, file with `requestId` and query plan.

---

## 10. Secret & key rotation

Detailed impact matrix: `DEPLOYMENT §8.3`. Rules: rotate during low traffic, one secret at a time, verify readiness after each, and update the config backup afterwards.

### 10.1 JWT secrets

```bash
# 1) generate
openssl rand -base64 48
# 2) update JWT_ACCESS_SECRET in /opt/saman-erp/.env
# 3) restart
docker compose up -d --no-deps api worker
# 4) verify login + refresh
curl -fsS https://erp.carexy.shop/health/ready
```

Rotating `JWT_ACCESS_SECRET` invalidates access tokens only (≤10 min; users refresh transparently). To invalidate all refresh sessions, use session revocation (admin UI / `POST /auth/sessions/revoke-others`), not a key rotation. Announce before doing it in business hours.

### 10.2 Database role passwords

```sql
-- as admin
ALTER ROLE saman_app PASSWORD '<new-hex>';
```
Then update `DATABASE_URL` in `.env` and restart `api`/`worker`. For the migrator: `ALTER ROLE saman_migrator ...`, update `MIGRATION_DATABASE_URL`, run `migrate` to prove connectivity. Order matters: change DB first, then app, expect a few failed auth attempts (retried by pool) during the switch.

### 10.3 `APP_ENCRYPTION_KEY` (channel credentials)

Channel credentials are AES-256-GCM encrypted with this key. Rotation is **not** a simple restart:

1. If the implementation supports dual keys (`APP_ENCRYPTION_KEY_VERSION`), add the new key/version, re-encrypt rows, switch the active version, remove the old key. Verify with a channel "test connection".
2. If no dual-key support: create a maintenance window; export/re-enter channel credentials through the admin UI **after** switching the key; then test every channel.
3. Keep the old key offline until all rows are confirmed re-encrypted. Losing the old key before re-encryption = permanent loss of channel credentials.

### 10.4 Redis, S3, provider keys

| Secret | Steps |
|---|---|
| `REDIS_PASSWORD` | update server and `REDIS_URL` together; roll `api`/`worker`; expect queue pause of a few seconds |
| `S3_ACCESS_KEY`/`S3_SECRET_KEY` | create new MinIO/S3 user with same policy → switch env → restart api/worker → revoke old user after verification |
| `CAREXY_API_KEY`, `DIGIKALA_CLIENT_SECRET`, `LIMO_API_KEY` | update at provider panel if supported, update `.env`, restart worker/api, run channel test |
| `BOOTSTRAP_ADMIN_PASSWORD` | irrelevant after first boot; ensure cleared from `.env` |

After any rotation: regenerate the encrypted config backup (`INSTALL-FA §14.4`) and verify readiness + a login.

---

## 11. Incident scenarios

Each scenario: **detect → contain → recover → verify → follow-up**.

### 11.1 Database down

**Detect:** `/health/ready` 503; logs `ECONNREFUSED`/`terminating connection`; writes failing.

```bash
docker compose ps postgres
docker compose logs --tail=200 postgres
docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
df -h /; docker inspect -f '{{.State.OOMKilled}}' $(docker compose ps -q postgres)
```

1. If container exited/OOM → §7 then `docker compose up -d postgres`.
2. If disk full → §6 first; PostgreSQL will not start without space.
3. If data corruption is suspected (`could not read block`, `invalid page`): **do not** run `initdb`/`pg_resetwal`; declare P1, isolate the host, and restore from the latest verified backup (`BACKUP-RESTORE §6`).
4. After recovery: `docker compose up -d api worker`, verify readiness, outbox lag draining, one login + one read/write smoke.
5. Follow-up: root cause, RPO check (any data loss window?), backup restore time actual.

### 11.2 Redis down

**Detect:** readiness 503; rate-limit/cache errors; queue paused; login may still work (auth uses DB + cached permissions — cache bypass per `ARCHITECTURE §13`).

```bash
docker compose ps redis
docker compose logs --tail=100 redis
docker compose exec -T redis redis-cli -a "$REDIS_PASSWORD" ping
docker compose exec -T redis redis-cli -a "$REDIS_PASSWORD" INFO memory
```

1. Restart: `docker compose up -d redis`; API/worker reconnect automatically.
2. AOF corruption: check logs; if Redis refuses to start, move `redisdata` aside (this loses queued jobs only — outbox replays), start fresh, verify outbox dispatch resumes.
3. Verify: `/health/ready`, queue depth decreasing, rate limiting works (test a burst login → 429).
4. Follow-up: if eviction/oom (`maxmemory` reached), scale memory or fix queue backlog; never switch to an eviction policy that drops queue keys.

### 11.3 Channel provider outage (Carexy / Digikala / Limo)

**Detect:** `channel_sync_failures_total` rising; dead letters; stock/price sync delayed; SMS OTP failing.

```bash
docker compose logs --since 30m --no-color worker | grep -iE 'carexy|digikala|limosms|timeout|5[0-9][0-9]'
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d saman -c "
SELECT channel, count(*) FROM erp.integration_dead_letters
WHERE resolved_at IS NULL GROUP BY channel;"
```

1. Confirm provider status (status page/support). Do not hammer: retries already use exponential backoff with jitter.
2. User-facing impact: orders keep being created in ERP; channel stock becomes stale — notify operations; consider pausing the affected sync queue only if it is generating noise, not because of data risk.
3. When provider recovers: replay unresolved dead letters (§4.3), verify a stock push and an order pull, check no duplicate orders (idempotency keys, `ADR-0006`).
4. SMS outage affects login OTP: admins can still log in with password+2FA fallback per policy; if not possible, temporary policy decision by security lead only — never disable OTP globally without written approval.
5. Follow-up: confirm contract errors vs transient; update adapter/TBD constants if the provider changed.

### 11.4 Disk full

→ §6.

### 11.5 OOM

→ §7.

### 11.6 Failed migration

**Detect:** `migrate` exits non-zero; API refuses to start (`DB_SCHEMA_VERSION` mismatch); deploy blocked.

```bash
docker compose --profile tools run --rm migrate 2>&1 | tail -50
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d saman -c "
SELECT * FROM information_schema.tables WHERE table_schema='erp' AND table_name LIKE '%migration%';"
```

1. Do **not** edit the migrations table or mark migrations as applied manually unless the DBA/lead explicitly decides; a half-applied DDL can leave the schema inconsistent.
2. If the migration is transactional (Drizzle runs each migration in a transaction where possible), a failure rolls back — fix the SQL and retry.
3. If partial DDL committed: assess with `\d` on affected tables; either write a corrective migration forward, or restore the pre-migration backup and redeploy the previous tag (`BACKUP-RESTORE §6.3`).
4. Keep `api`/`worker` on the old tag while the DB is mid-migration if expand/contract was followed; that is why §10.1 of DEPLOYMENT requires compatibility.
5. Follow-up: add the missing migration test to CI (fresh DB → migrate → seed), review expansion ordering.

### 11.7 Restore / disaster recovery

Full procedure: [`BACKUP-RESTORE.md §6`](./BACKUP-RESTORE.md). Summary:

1. Declare incident, freeze writes (`docker compose stop api worker`).
2. Pick target backup (and WAL target time if PITR) based on RPO.
3. Restore into a **fresh** database/volume, run `migrate` head check, start API.
4. Verify: users count, last ledger row, trial balance balances, login + product list, one order flow.
5. Announce recovery, record actual RPO/RTO, file postmortem.

### 11.8 TLS expiry / misconfiguration

**Detect:** browsers warn; `openssl s_client` shows expired; `certbot`/Caddy errors.

→ §8. Emergency: if a valid cert exists elsewhere, install it manually into `caddy_data`/nginx and reload; keep HSTS but never serve plain HTTP for authenticated traffic. Follow-up: add cert-expiry alert (< 21 days).

### 11.9 Worker crash loop

```bash
docker compose ps worker
docker compose logs --tail=300 worker
docker inspect -f '{{.RestartCount}} {{.State.OOMKilled}}' "$(docker compose ps -q worker)"
```

1. OOM → §7. Config error → fix `.env`, `up -d worker`.
2. Redis/db unreachable → fix dependency first; worker will recover.
3. Poison job crashing the process: identify job/queue in logs; if needed, temporarily pause that queue (pause the producer flag or scale down) and quarantine the job; handlers must be idempotent on retry.
4. Outbox keeps retrying safely while worker is down; no data loss, only latency.

### 11.10 MinIO / S3 unavailable

**Detect:** upload failures (labels, media, exports); readiness 503 (S3 is part of readiness); backup upload failures.

```bash
docker compose ps minio
docker compose logs --tail=100 minio
docker compose run --rm --entrypoint sh minio-init -c '
  mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ready local && mc admin info local'
```

1. Restart MinIO; check disk space on its volume (full disk breaks MinIO).
2. If the data volume is lost: declare P1; restore `minio_data` from offsite mirror; DB is unaffected but media objects may be missing (document impact).
3. After recovery: verify a media upload/download and a label print; run a manual backup (`backup once`) to confirm the backup path works too.

### 11.11 Backup failure / stale backup

**Detect:** backup age alert > 26 h; `backup` container logs errors; missing `.gpg` objects.

```bash
docker compose ps backup
docker compose logs --tail=200 backup
docker compose run --rm --entrypoint sh minio-init -c '
  mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ls --recursive local/saman-backups/backups/postgres' | tail
```

1. Disk full → §6; credentials/endpoint mismatch → fix `.env`/MinIO user; GPG error → verify `BACKUP_ENCRYPTION_PASSPHRASE` is set (never print it).
2. Run manually until it succeeds: `docker compose --profile backup run --rm backup once`.
3. Verify the object size > 0 and `sha256` file exists; do a `pg_restore --list` on the downloaded dump.
4. If backups have been broken for days: treat as P1 risk, take a fresh manual backup immediately, and inform the customer that RPO was temporarily violated.

### 11.12 5xx spike / total outage

1. `docker compose ps`, readiness, logs by level, disk/RAM first (most common root causes).
2. If a deploy preceded it → rollback (`DEPLOYMENT §10.3`) before deep debugging.
3. If DB is healthy but errors are app-level → capture `requestId` samples, check recent config changes (`git log`, `.env` mtime), and the top error message.
4. Communicate status to users (read-only notice if DB is up but writes fail).

### 11.13 Suspicious login / credential leak

1. `audit_logs` filter `access.denied`, failed logins, and source IPs; revoke user sessions (admin UI or `auth_sessions` per `ADR-0004`).
2. Rotate the affected secret (§10) and, if channel/webhook secrets may be exposed, rotate them and re-test channels.
3. Preserve logs (copy out before rotation) and follow the security incident process in `docs/04-security/SECURITY.md`.

---

## 12. Post-incident

- Write a timeline: detection, each command, decision, recovery time.
- Answer: was RPO met? was RTO met? was any data manually edited?
- Add/extend an alert so the same silent failure pages earlier.
- Add a regression test or runbook fix; update this document and `BACKUP-RESTORE.md` if procedures changed.
- For data-affecting incidents, verify invariants: `Σ ledger = balances`, trial balance balanced, no duplicate channel orders (`ADR-0007`؛ Definition of Done در `ARCHITECTURE.md §17`).

---

## 13. Maintenance calendar

| When | Task |
|---|---|
| daily 08:00 | §2.1 checklist |
| nightly 02:00 | automatic backup (`BACKUP_CRON=0 2 * * *`) |
| weekly | §2.2 checklist, review disk growth |
| monthly | trends, access review, index/bloat review, offsite verify |
| quarterly | restore drill + RTO measurement, PITR drill if enabled, cert/secret rotation review |
| on release | backup → migrate → seed → rolling restart → smoke (`DEPLOYMENT §10`) |
| yearly | audit log archive verification, capacity plan, dependency/EOL review |

---

## Appendix A — Variables referenced by this runbook

Every environment variable used in commands above, with its source of truth (`../06-deployment/DEPLOYMENT.md §7`; canonical template `.env.example`):

| Variable | Why this runbook uses it |
|---|---|
| `POSTGRES_USER` | admin role for psql commands |
| `POSTGRES_DB` | database name (`saman`) in queries |
| `POSTGRES_PASSWORD` | not printed; used via container env only |
| `REDIS_PASSWORD` | `redis-cli -a`, queue inspection |
| `REDIS_URL` | API runtime Redis connection (readiness/queue context) |
| `S3_ENDPOINT` / `S3_BUCKET` | MinIO/offsite verification context |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | MinIO admin tooling (`mc` one-shot container) |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | MinIO console/admin checks via `mc` |
| `LIMO_API_KEY` | SMS/OTP provider checks during OTP incidents |
| `CAREXY_API_KEY` | Carexy channel outage diagnosis |
| `DIGIKALA_CLIENT_SECRET` | Digikala channel OAuth diagnosis (never printed) |
| `DATABASE_URL` | API runtime DB connection (validated through readiness) |
| `MIGRATION_DATABASE_URL` | DDL role for migrate/seed checks |
| `DB_POOL_MAX` | connection-budget math |
| `DB_STATEMENT_TIMEOUT_MS` | slow-query/lock troubleshooting context |
| `DB_SCHEMA` | schema name in SQL (`erp`) |
| `APP_PORT` | internal API port 4000 in health commands |
| `APP_URL` | public origin in cert/TLS verification context |
| `DOMAIN` | cert/TLS checks |
| `ACME_EMAIL` | Caddy/ACME troubleshooting |
| `IMAGE_TAG` | version drift checks (`/health/version`) |
| `OUTBOX_POLL_INTERVAL_MS` | outbox lag troubleshooting |
| `OUTBOX_BATCH_SIZE` | outbox throughput tuning |
| `WORKER_CONCURRENCY` | worker scaling |
| `BACKUP_ENABLED` | backup health checks |
| `BACKUP_CRON` | maintenance calendar |
| `BACKUP_KEEP_DAYS` | disk cleanup decisions |
| `BACKUP_S3_PREFIX` | locating backup objects in MinIO |
| `BACKUP_ENCRYPTION_PASSPHRASE` | backup failure diagnosis (never printed) |
| `CHANNEL_SYNC_ENABLED` | channel outage containment |
| `CHANNEL_HTTP_TIMEOUT_MS` | channel timeout diagnosis |
| `SMS_MODE` | OTP outage context |
| `JWT_ACCESS_SECRET` | rotation procedure |
| `APP_ENCRYPTION_KEY` / `APP_ENCRYPTION_KEY_VERSION` | credential re-encryption procedure |
| `BOOTSTRAP_ADMIN_PASSWORD` | confirming it was cleared after first boot |
| `LOG_LEVEL` | temporary debug logging during incidents (revert after) |

**End of runbook — v1.0**
