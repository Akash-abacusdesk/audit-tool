# WordPress Deployment Patterns

Definitions for how managed WordPress sites are deployed and observed. Production hosts stay
application-serving systems, not security-worker nodes (PRD §4.3, lines 208-235).

## Pattern W1 — Traditional WordPress (monolithic)

Classic WP/PHP site serving both admin and public traffic behind Caddy.

- **Artifact flow**: build/assemble site artifact (core pin + plugin/theme set + `wp-config.php`
  template) centrally → deploy via restricted wrapper command
  (`site-control deploy <site> <artifact-id>`, PRD lines 869, 854-884). No git-pull-on-prod,
  no unattended auto-updates.
- **Identity**: every deployment carries a `deployment_id` + application version; inventory
  metadata (core version, plugin list, versions, deployment ID) is exposed to the central plane
  via the allowed narrow inventory surface (PRD line 218).
- **Secrets**: injected at runtime per §17.3 (mounted files / short-lived retrieval); never baked
  into artifacts or images.
- **Observability**: signed MU-plugin emits async HTTPS mutation events (admin changes, role
  changes, plugin activate/install/update/delete, core updates, JIT session events; PRD §10,
  lines 888-911). Implementation deferred — boundary defined in
  [wp-remote-control-boundaries.md](wp-remote-control-boundaries.md).
- **Updates**: never blind on production. All updates flow through the safe-update engine
  (staging copy → one plugin/group at a time → tests → approval → controlled promotion →
  rollback point retained; PRD §15 lines 1224-1275, objective 2.1(4) lines 57-61).
- **Hard limits on prod host** (non-goals §3 lines 91-95, §4.3 lines 223-234): no Semgrep/Gitleaks/
  Trivy/ClamAV/ZAP/Playwright/deep-audit workers; WPScan-style checks are correlated centrally from
  version inventory, not run on the host.

## Pattern W2 — WordPress as headless CMS backend

WP exposes REST/GraphQL to a decoupled Next.js frontend. Everything in W1 applies, plus:

- Frontend/backend relationship recorded as explicit project relationship metadata so cross-stack
  API-boundary gates run without per-repo manual config (PRD lines 51, 554-556).
- WP admin surface stays on its own origin/path; frontend deploys independently of WP content.
- WP remains subject to safe-update engine; frontend stack follows the headless integration
  pattern doc.

## Pattern W3 — Managed multi-site on shared host

Multiple low-traffic WP sites on one production VPS.

- Per-site isolation: separate document roots/artifact sets, per-site DB identity and secret scope
  (least-privilege principals, PRD §17.1 lines 1335-1346), per-site `deployment_id`.
- Wrapper commands always take `<site>`; blast radius of any single update/rollback is one site.
- One compromised site must not pivot into the control plane: inbound mutation events are treated
  as hostile regardless of source site (§12.3 lines 988-1006).

## Rollback model

Every production change produces a rollback point retained after promotion (PRD line 1238);
`site-control rollback <site> <rollback-id>` (line 871) is the only sanctioned reversal path.
