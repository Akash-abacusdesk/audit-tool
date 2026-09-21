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

restic snapshots --tag platform-recovery-host
restic check
