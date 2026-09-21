# Security / Recovery Host

Dedicated hardened host (mesh node `10.10.0.2` placeholder) for Vaultwarden,
backup/WAL reception, and recovery tooling. Per PRD Tier-0 rule, **deep scanners
and browser tests NEVER run on production VPSs**.

## Role
- Runs Vaultwarden with an isolated datastore.
- Holds backups target (Restic/Borg repo on dedicated volume).
- Recovery staging: restore drills, break-glass toolkit.
- Receives central PostgreSQL backup/WAL material.

## Deployable Vaultwarden bundle

The deployable production bundle lives in `tool/infrastructure/recovery-host/`:

- `docker-compose.yml` — Vaultwarden service, private bind only, isolated Docker volume.
- `.env.example` — production env-file template; copy to `.env` on the host.
- `backup.env.example` — Restic backup/restore env template; copy to `/etc/platform/recovery-backup.env`.
- `Caddyfile.private.example` — optional private/VPN-only reverse proxy template.
- `bin/backup-recovery-host.sh` — encrypted Restic backup for Vaultwarden data, received backups, and WAL.
- `bin/verify-recovery-backups.sh` — backup freshness/integrity check entrypoint.
- `bin/restore-vaultwarden.sh` — restore a selected Restic snapshot into a target directory.
- `backups/` and `wal/` — host-side reception directories, intentionally not mounted into Vaultwarden.

Validate the compose file from `tool/`:

```powershell
npm run validate:recovery-host
```

First production boot on the Security / Recovery Host:

```bash
cd /opt/platform/tool/infrastructure/recovery-host
cp .env.example .env
chmod 600 .env
# edit .env: bind to loopback or WireGuard IP, set domain, set ADMIN_TOKEN
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

Install backup tooling and configure encrypted backups:

```bash
apt -y install restic
mkdir -p /etc/platform /srv/platform-recovery/backups /srv/platform-recovery/wal
cp backup.env.example /etc/platform/recovery-backup.env
chmod 600 /etc/platform/recovery-backup.env
# create /etc/platform/restic-password with a human-generated secret, chmod 600
bin/backup-recovery-host.sh /etc/platform/recovery-backup.env
bin/verify-recovery-backups.sh /etc/platform/recovery-backup.env
```

Restore Vaultwarden material to a staging directory:

```bash
bin/restore-vaultwarden.sh /etc/platform/recovery-backup.env /srv/restore/vaultwarden latest
```

Vaultwarden is not part of `infrastructure/docker-compose.dev.yml`; it must not
share the central application PostgreSQL role or PgBouncer pool.

## Base hardening (on top of vps-base.md baseline)
```bash
# No public surface at all: no 80/443, SSH from mesh only (enforced by nftables baseline)
apt -y install restic jq cron

# dedicated unprivileged runtime users
adduser --system --group scanner
adduser --system --group backup

# separate volumes so a scan/restore storm can't starve the OS
mkfs.ext4 /dev/sdb && mkdir -p /srv/scans /srv/backups   # sizes = provisioning-time knobs
```

## Scanner isolation pattern (v1: container-per-job)
```
docker run --rm --network none \
  --read-only --tmpfs /tmp:size=2g \        # tmpfs size = knob, not fixed policy
  --cpus ${SCAN_CPUS:-2} --memory ${SCAN_MEM:-4g} \
  -v /srv/scans/<job>:/work:ro \
  <pinned-scanner-image> ...
```
- `--network none` unless the job explicitly needs egress (allowlisted at dispatch).
- Tool versions are pinned by D3 (scanner inventory); this host only consumes them.

## Backup layout
- Restic repo `/srv/backups/restic`, password + repo config injected via env file
  (`/etc/platform/backup.env`, chmod 600 — see caddy-secrets.md).
- Central PostgreSQL archive/WAL receiver path maps to `RECOVERY_WAL_DIR` from
  `infrastructure/recovery-host/.env`.
- Scheduled backup receiver path maps to `RECOVERY_BACKUP_DIR` from
  `infrastructure/recovery-host/.env`.
- Vaultwarden datastore is the `vaultwarden-data` Docker volume and is backed up
  by `bin/backup-recovery-host.sh` as Vaultwarden backup material, separate from
  central PostgreSQL.
- Schedule + retention are env knobs (`BACKUP_CRON`, `KEEP_DAILY/WEEKLY/MONTHLY`);
  defaults documented here, tuned at provisioning.
- Restore drill: quarterly, human-scheduled; runbook entry added after first real host exists.

## Human gates (same gate list as vps-base.md)
Second VPS provision approval; backup destination/storage credentials; retention policy sign-off.
