# Caddy edge + secret-injection mechanism

Scope: S1-D2. Config-as-code; no real domain/TLS issued yet.

## Initial Caddy configuration (central VPS edge)
Caddy is the ONLY publicly exposed service (80/443). It terminates TLS (ACME) and
reverse-proxies to services over the WireGuard mesh.

`Caddyfile` (template; domains are placeholders until DNS gate clears):
```
{
    # capacity-agnostic knobs instead of silent defaults
    admin off                      # no admin endpoint on public edge
    servers {
        protocols h1 h2 h3
    }
}

portal.example.com {
    encode zstd gzip
    reverse_proxy 10.10.0.10:3000   # Portal (Next.js) via mesh
}
api.example.com {
    encode zstd gzip
    reverse_proxy 10.10.0.10:8080   # API via mesh
}
```
Run as systemd unit (`caddy run --config /etc/caddy/Caddyfile`) with
`CAP_NET_BIND_SERVICE`; logs to journald. Certificates auto-managed (ACME HTTP-01
or DNS-01 once provider creds exist — DNS-01 preferred so 80 stays closed where possible).

## Secret-injection mechanism (dev → prod, one model)
Principle: secrets live in files outside git, injected as environment variables;
**no secret values in code, images, compose defaults, or docs.**

| Layer | Mechanism |
|---|---|
| Local dev | `infrastructure/.env` (gitignored; `.env.example` committed template) loaded by docker compose |
| VPS services | Per-service env drop-ins: `/etc/platform/<svc>.env` chmod 600 root-owned, wired via `EnvironmentFile=` in the systemd unit (docker/compose services included) |
| Caddy | Secrets referenced as `{env.VAR}` in Caddyfile; actual values come from its env file above |
| Mesh/WG keys, DB passwords, ACME DNS creds | Written to those env files at provision time by the human-approved provisioning script |

Rotation: edit env file → `systemctl restart <svc>` → confirm healthcheck; old value
revoked at source (DB role password change, provider token revoke).

Rules:
- `.env` is gitignored via `infrastructure/.gitignore`; any future env-file location must add its own ignore rule.
- CI/CD later reads the same env-file shape — one convention everywhere.

## Human gates
Real domains, DNS provider API token (for DNS-01), and any real secret values are
human-supplied after provisioning approval — parked via god → humanQA on S1-D2.
