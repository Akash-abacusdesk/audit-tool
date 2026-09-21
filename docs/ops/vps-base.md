# Central VPS base + firewall baseline

Scope: S1-D2. **Reference configs and runbook only — no real server has been touched.**
Provisioning is human-gated (see "Human gates" below).

## Base image & first boot (any Debian 12 / Ubuntu 24.04 VPS, any size)
Capacity policy: no fixed instance size. Provisioners pick smallest viable tier;
all service limits come from env/config knobs (see `docker-dev-env.md`).

```bash
# as root, once:
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh   # authorized_keys added per JIT grant

apt update && apt -y upgrade
apt -y install unattended-upgrades fail2ban nftables wireguard-tools ca-certificates curl ufw
dpkg-reconfigure -f noninteractive unattended-upgrades   # auto security updates ON

# Docker engine (official repo), rootless NOT required for v1; document if adopted later
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy
```

## sshd baseline (applies to ALL hosts — see networking-ssh.md for key model)
```
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
MaxAuthTries 3
AllowUsers deploy
```

## Firewall baseline (nftables; default-drop inbound, stateful, allow-list)
`/etc/nftables.conf`:
```
#!/usr/sbin/nft -f
flush ruleset

table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    iif lo accept
    ct state established,related accept
    ct state invalid drop
    tcp dport 22 ip saddr 10.10.0.0/24 accept   # SSH: mgmt/WireGuard subnet ONLY
    icmp type echo-request limit rate 5/second accept
    # WireGuard mesh:
    udp dport 51820 accept
    # Caddy public edge (central VPS only):
    tcp dport { 80, 443 } accept
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    ct state established,related accept
    iifname "wg0" oifname "wg0" accept          # mesh routing between nodes
    # docker forwarding inserted by Docker; keep explicit accepts narrow
  }
  chain output {
    type filter hook output priority 0; policy accept;
  }
}
```
Enable: `systemctl enable --now nftables && nft -f /etc/nftables.conf`.
fail2ban default sshd jail enabled. PostgreSQL/PgBouncer ports are **never** public — mesh or loopback only.

## Port matrix (defaults; adjust per host role)
| Port | Proto | Exposed to | Purpose |
|---|---|---|---|
| 22 | tcp | mgmt mesh subnet | SSH (JIT keys only) |
| 51820 | udp | peers | WireGuard |
| 80/443 | tcp | internet (central VPS only) | Caddy edge |
| 5432/6432 | tcp | mesh only | PG direct / PgBouncer |

## Human gates (parked for god → humanQA on S1-D2)
1. Actual VPS account/provider credentials + which provider/region.
2. DNS zone control for platform domains.
3. Approval to run provisioning scripts against real hosts.
Until approved: everything above stays config-as-code in this repo.
