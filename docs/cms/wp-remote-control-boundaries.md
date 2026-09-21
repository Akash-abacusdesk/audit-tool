# WordPress Remote-Control Boundaries

What the central control plane may command on a production WordPress host, and what it may not.
Reviewed against JIT requirements (PRD 2.1(5) lines 63-65, §11 lines 915-943) and the
production-host lightweight rule (§3 lines 91-95, §4.3 lines 208-235).

## Command surface (allow-listed only)

The ONLY sanctioned path to production WP is the restricted command wrapper (§9.2 lines 854-884):
Ed25519/short-lived machine credentials, source-IP allow-listing, dedicated restricted account,
server-side sudoers allow-list, no interactive root shell, every invocation emits an audit event.

In-scope high-level operations (PRD lines 867-873):

| Operation | Notes |
|---|---|
| `site-control inventory <site>` | read-only narrow metadata: core version, plugin list+versions, deployment ID (line 218) |
| `site-control deploy <site> <artifact-id>` | artifact promotion only |
| `site-control update-plugin <site> <plugin> <version>` | fires only inside the safe-update workflow (§15); never blind (15.1 line 1220) |
| `site-control rollback <site> <rollback-id>` | to a retained rollback point (line 1238) |
| `site-control health <site>` | health/readiness surface |

Wrapper validates site mapping, command, args, approved artifact/version, authorization context,
request ID (lines 875-882). No arbitrary `docker run/exec/cp`, no volume mounts, deploy account has
no Docker-group membership (§9.1 lines 848-853).

## JIT interplay

- Developers get temporary WP admin sessions via one-time redemption (hash-only storage, atomic
  consume, short-lived auto-revoked user; §11.2 steps lines 923-941). No shared permanent admin
  passwords exist anywhere in the platform (2.1(5), non-goal line 97).
- JIT session create/revoke events are part of the MU-plugin mutation event set (line 898) so every
  privileged human action on WP is attributable (actor, grant/session ID, request ID, IP — lines
  900-911).
- JIT grants authorize *human* WP-admin access; they never widen the machine command surface above.
  A developer with an active JIT grant still cannot invoke `site-control` commands outside policy.
- Telegram alone never finalizes production overrides; approval chains live server-side (2.1(6)
  lines 67-69).

## Hard "no" list (production host)

From §3 non-goals and §4.3 not-allowed list (lines 223-234):

- No scanner execution of any kind: Semgrep, Gitleaks history, Trivy FS sweeps, ClamAV/Maldet,
  ZAP, Playwright browsers, repo-wide SAST, weekly deep-audit workers.
- No WPScan runs on the host — vuln correlation happens centrally from collected version inventory
  (line 94).
- No defect normalization or AI remediation processing on-host.
- No unrestricted Docker daemon access from or for the management plane.
- Production TLS/network checks are external, non-destructive, rate-limited posture assessments
  only (line 95).

## Inbound direction: prod → central

Mutation events and inventory callbacks are untrusted input (every managed site treated as
potentially hostile, §12.3 lines 988-1006): signed + authenticated, replay-protected,
schema-validated, size-bounded, rate-limited, processed asynchronously, never triggering command
execution or central worker fan-out directly. A compromised site must not pivot into central RCE
(line 1006).

## S1 boundary

Definitions only: no MU-plugin implementation, no wrapper implementation, no live WP instance in
Section 1. Wrapper mechanics belong to later sections; this doc is the contract they must satisfy.
