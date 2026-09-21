-- 005_git_sync — S3-D1B: provider credential storage for repo sync.
-- Contracts: packages/shared/src/git.ts; crypto: apps/api/src/git/secretbox.ts.
--
-- Tokens are encrypted at rest (AES-256-GCM, key = GIT_CREDENTIALS_KEY env,
-- 32-byte hex). Ciphertext format: base64(iv(12) | tag(16) | data). The
-- plaintext token never appears in payloads, logs, or DTOs.

CREATE TABLE IF NOT EXISTS api_git_credentials (
  connection_id uuid PRIMARY KEY REFERENCES api_git_connections(id) ON DELETE CASCADE,
  algo text NOT NULL DEFAULT 'aes-256-gcm',
  ciphertext text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
