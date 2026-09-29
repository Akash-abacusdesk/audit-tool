#!/usr/bin/env bash
# Takes a fresh PostgreSQL base backup into RECOVERY_BACKUP_DIR, dated so
# restic keeps history across runs (each run is its own directory — PITR
# recovery picks the newest base backup and replays WAL from RECOVERY_WAL_DIR
# forward, matching wal-receiver's continuous pg_receivewal stream).
#
# Was previously missing entirely: backup-recovery-host.sh restics
# RECOVERY_BACKUP_DIR but nothing populated it. Run this on a schedule (e.g.
# daily) before backup-recovery-host.sh.
set -euo pipefail

ENV_FILE="${1:-/etc/platform/recovery-backup.env}"
if [[ ! -r "$ENV_FILE" ]]; then
  echo "missing readable env file: $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

: "${RECOVERY_BACKUP_DIR:?set RECOVERY_BACKUP_DIR}"
: "${PRIMARY_PG_HOST:?set PRIMARY_PG_HOST}"
: "${PRIMARY_PG_PORT:=5432}"
: "${PRIMARY_PG_REPLICATION_USER:?set PRIMARY_PG_REPLICATION_USER}"
: "${PRIMARY_PG_REPLICATION_PASSWORD:?set PRIMARY_PG_REPLICATION_PASSWORD}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$RECOVERY_BACKUP_DIR/$STAMP"
mkdir -p "$DEST"

PGPASSWORD="$PRIMARY_PG_REPLICATION_PASSWORD" pg_basebackup \
  --host="$PRIMARY_PG_HOST" \
  --port="$PRIMARY_PG_PORT" \
  --username="$PRIMARY_PG_REPLICATION_USER" \
  --pgdata="$DEST" \
  --wal-method=none \
  --checkpoint=fast \
  --progress

ln -sfn "$STAMP" "$RECOVERY_BACKUP_DIR/latest"
echo "base backup complete: $DEST"
