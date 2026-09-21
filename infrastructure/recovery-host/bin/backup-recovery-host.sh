#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-/etc/platform/recovery-backup.env}"
if [[ ! -r "$ENV_FILE" ]]; then
  echo "missing readable env file: $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY}"
: "${RESTIC_PASSWORD_FILE:?set RESTIC_PASSWORD_FILE}"
: "${VAULTWARDEN_DATA_DIR:?set VAULTWARDEN_DATA_DIR}"
: "${RECOVERY_BACKUP_DIR:?set RECOVERY_BACKUP_DIR}"
: "${RECOVERY_WAL_DIR:?set RECOVERY_WAL_DIR}"

restic snapshots >/dev/null 2>&1 || restic init

restic backup \
  "$VAULTWARDEN_DATA_DIR" \
  "$RECOVERY_BACKUP_DIR" \
  "$RECOVERY_WAL_DIR" \
  --tag platform-recovery-host

restic forget \
  --tag platform-recovery-host \
  --keep-daily "${KEEP_DAILY:-14}" \
  --keep-weekly "${KEEP_WEEKLY:-8}" \
  --keep-monthly "${KEEP_MONTHLY:-12}" \
  --prune

restic check
