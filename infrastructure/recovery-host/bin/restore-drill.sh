#!/usr/bin/env bash
# S16 disaster-recovery drill: real streaming replication + base backup +
# simulated compromise + PITR restore, all against disposable Docker infra.
# Mirrors the production architecture (wal-receiver's pg_receivewal +
# bin/basebackup-recovery-host.sh + bin/restore-recovery-host.sh) closely
# enough to be a genuine exercise of that design, not a stand-in mechanism.
set -euo pipefail

NET=drill-net
PRIMARY=drill-primary
WALDIR=/tmp/drill-wal
BACKUPDIR=/tmp/drill-backup
RESTOREDIR=/tmp/drill-restore

echo "== cleanup any previous drill state =="
docker rm -f "$PRIMARY" drill-wal-receiver drill-restored >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
rm -rf "$WALDIR" "$BACKUPDIR" "$RESTOREDIR"
mkdir -p "$WALDIR" "$BACKUPDIR" "$RESTOREDIR"
chmod 777 "$WALDIR" "$BACKUPDIR" "$RESTOREDIR"
docker network create "$NET" >/dev/null

echo "== starting primary (streaming replication enabled) =="
docker run -d --name "$PRIMARY" --network "$NET" \
  -e POSTGRES_PASSWORD=drillpass -e POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:17-alpine \
  postgres -c wal_level=replica -c max_wal_senders=4 -c hot_standby=on >/dev/null

for i in $(seq 1 30); do
  docker exec "$PRIMARY" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PRIMARY" pg_isready -U postgres

echo "== allowing replication connections (pg_hba.conf) =="
docker exec "$PRIMARY" sh -c "echo 'host replication all all trust' >> /var/lib/postgresql/data/pg_hba.conf"
docker exec -u postgres "$PRIMARY" psql -c "SELECT pg_reload_conf();"

echo "== creating pre-backup data =="
docker exec -u postgres "$PRIMARY" psql -c \
  "CREATE TABLE drill(id serial primary key, note text, created_at timestamptz default now());"
docker exec -u postgres "$PRIMARY" psql -c \
  "INSERT INTO drill(note) VALUES ('pre-backup row 1'), ('pre-backup row 2');"

echo "== starting WAL receiver (real pg_receivewal, streaming continuously) =="
docker run -d --name drill-wal-receiver --network "$NET" \
  -v "$WALDIR:/wal" \
  postgres:17-alpine \
  pg_receivewal --host="$PRIMARY" --username=postgres --directory=/wal --if-not-exists --verbose >/dev/null
sleep 2
docker logs drill-wal-receiver 2>&1 | tail -5

echo "== taking base backup (real pg_basebackup, matches bin/basebackup-recovery-host.sh) =="
docker run --rm --network "$NET" -v "$BACKUPDIR:/out" postgres:17-alpine \
  pg_basebackup --host="$PRIMARY" --username=postgres --pgdata=/out --wal-method=none --checkpoint=fast --progress

echo "== creating POST-backup data (only recoverable via WAL replay, proves RPO) =="
docker exec -u postgres "$PRIMARY" psql -c \
  "INSERT INTO drill(note) VALUES ('post-backup row 3 (WAL-only)');"

# pg_receivewal writes an in-progress segment as *.partial and only renames it
# to its final name on a full segment or an explicit switch — force one so
# the just-committed row is actually replayable, not stuck in a .partial file
# (this IS the real operational gotcha; production's continuous WAL volume
# would trigger natural switches, an idle drill sandbox does not).
docker exec -u postgres "$PRIMARY" psql -c "SELECT pg_switch_wal();"
echo "-- waiting for pg_receivewal to finalize the segment (no .partial files left) --"
for i in $(seq 1 30); do
  if ! ls "$WALDIR"/*.partial >/dev/null 2>&1; then break; fi
  sleep 1
done
ls -la "$WALDIR"
chmod -R a+r "$WALDIR"  # pg_receivewal ran as root; restore container's postgres user needs read access

DRILL_START=$(date +%s)
echo "== SIMULATING COMPROMISE: destroying the primary =="
docker rm -f "$PRIMARY" >/dev/null

echo "== RESTORE: rebuilding from base backup + WAL replay (PITR) =="
cp -r "$BACKUPDIR"/. "$RESTOREDIR"/
touch "$RESTOREDIR/recovery.signal"
cat > "$RESTOREDIR/postgresql.auto.conf" <<EOF
restore_command = 'cp /wal/%f %p'
EOF

docker run -d --name drill-restored --network "$NET" \
  -v "$RESTOREDIR:/var/lib/postgresql/data" \
  -v "$WALDIR:/wal:ro" \
  postgres:17-alpine >/dev/null

echo "-- waiting for recovery to complete and promote --"
for i in $(seq 1 30); do
  docker exec drill-restored pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec drill-restored pg_isready -U postgres

DRILL_END=$(date +%s)
ELAPSED=$((DRILL_END - DRILL_START))

echo "== VERIFY: querying restored data =="
ROWS=$(docker exec -u postgres drill-restored psql -tA -c "SELECT note FROM drill ORDER BY id;")
echo "$ROWS"

echo "== RESULT =="
echo "Restore wall-clock time (compromise -> verified serving): ${ELAPSED}s (RTO target: <=7200s)"
if echo "$ROWS" | grep -q "post-backup row 3"; then
  echo "PASS: post-backup row recovered via WAL replay (RPO satisfied — no data loss beyond WAL flush lag)."
else
  echo "FAIL: post-backup row missing — WAL replay did not recover the latest committed data."
  exit 1
fi

echo "== cleanup =="
docker rm -f drill-restored drill-wal-receiver >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
rm -rf "$WALDIR" "$BACKUPDIR" "$RESTOREDIR"
echo "drill complete, all disposable resources removed."
