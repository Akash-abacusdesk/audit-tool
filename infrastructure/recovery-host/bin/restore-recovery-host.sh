#!/usr/bin/env bash
# Restores PostgreSQL backup/WAL material from the Restic repository.
# Vaultwarden's own restore is owned by the external Vaultwarden microservice
# team (PRD §3, §4.2) — this script never touches Vaultwarden data.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 /etc/platform/recovery-backup.env <target-dir> [snapshot]" >&2
  exit 2
fi

ENV_FILE="$1"
TARGET_DIR="$2"
SNAPSHOT="${3:-latest}"

if [[ ! -r "$ENV_FILE" ]]; then
  echo "missing readable env file: $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY}"
: "${RESTIC_PASSWORD_FILE:?set RESTIC_PASSWORD_FILE}"

mkdir -p "$TARGET_DIR"
restic restore "$SNAPSHOT" --target "$TARGET_DIR" --tag platform-recovery-host
