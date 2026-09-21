# Private networking + SSH administration model

Scope: S1-D2. Config-as-code; no real host touched yet.

## Private networking: WireGuard mesh overlay
All inter-service traffic (API↔PG, scanners, WP nodes ↔ control plane) rides a
WireGuard mesh; public internet only ever reaches Caddy 80/443 on the central VPS.

- Mesh subnet: `10.10.0.0/24` (placeholder — final value set at provisioning).
  - `10.10.0.1` central VPS (also the mesh "hub" with `AllowedIPs` routing)
  - `10.10.0.2` security/recovery host
  - `10.10.0.10+` worker/ephemeral nodes
- Keys per host, generated at provision time (`wg genkey`), private keys injected via secret mechanism ([caddy-secrets.md](caddy-secrets.md)) — never committed.
- Hub config template `/etc/wireguard/wg0.conf` (central VPS):
```
[Interface]
Address = 10.10.0.1/24
ListenPort = 51820
PrivateKey = <injected>

[Peer]  # security/recovery host
PublicKey = <peer pub>
AllowedIPs = 10.10.0.2/32

[Peer]  # worker template — one block per node, /32 each
PublicKey = <peer pub>
AllowedIPs = 10.10.0.10/32
```
Spokes are identical minus routing. `systemctl enable --now wg-quick@wg0`.
- PG/PgBouncer bind to mesh IP or localhost only; firewall enforces (see vps-base.md).

## SSH administration model
Principles (from PRD hard rules): **JIT access, no shared/permanent admin credentials,
no password auth anywhere.**

- Key type: ed25519, one keypair per human per purpose; passphrases required.
- No shared `admin` account; humans use named accounts with sudo.
- **JIT grant flow**: need access → request to god/human → deploy-key added with
  expiry comment (`# jit: <ticket> until YYYY-MM-DDTHH:MMZ`) → cron/systemd timer
  prunes expired lines from `authorized_keys` daily:
```
# /etc/cron.d/jit-keys-prune (daily)
0 3 * * * root sed -i '/# jit:.*until \(20[0-9-]\{8\}T[0-9:]\{5\}Z\)/{…prune-if-past…}' /home/*/.ssh/authorized_keys
```
  (exact prune script lands with provisioning assets when hosts exist)
- Root SSH login disabled; sudo via `deploy` group, `visudo` defaults:
  `Defaults use_pty`, `Defaults logfile="/var/log/sudo.log"` (session accountability).
- Emergency/break-glass: console access via provider (human-only), Telegram never
  authorizes production break-glass (PRD rule).
- Host keys recorded in inventory after first boot; TOFU pinning in `known_hosts`.

## Human gates
Same as vps-base.md: real IPs/DNS/keys exist only after human provisioning approval.
