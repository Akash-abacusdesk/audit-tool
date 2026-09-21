# Git provider credentials at rest (S3-D1B)

## Choice

AES-256-GCM via `node:crypto` (zero new deps). Table `api_git_credentials`
(migration 005), one row per connection:

- `algo` = `aes-256-gcm`
- `ciphertext` = base64(`iv[12] | authTag[16] | data`)
- key = env `GIT_CREDENTIALS_KEY`, 64 hex chars (32 bytes). Provision it in
  `infrastructure/.env` (gitignored) alongside `POSTGRES_PASSWORD`.

Implementation: `apps/api/src/git/secretbox.ts`. Rotation = re-issue
`PUT /api/v1/git-connections/:id/credential` with the new token.

## Properties

- Plaintext never appears in DTOs, logs, audit details, or API responses.
- Tamper/auth-tag failure on decrypt returns null -> sync falls back to
  anonymous access rather than crashing.
- Missing/misconfigured `GIT_CREDENTIALS_KEY` makes credential writes return
  503 UNAVAILABLE; syncs of uncredentialed connections still work.

## Threat model notes

- Day-one this is encryption-at-rest only; the process holds plaintext in
  memory during sync by necessity. Host compromise is out of scope here —
  the privileged-admin plane (S2-D2) is the boundary for that.
- GitHub-only day-one (DEC): GitLab/bitbucket connections are rejected by the
  sync path's provider allowlist when they gain clients.
