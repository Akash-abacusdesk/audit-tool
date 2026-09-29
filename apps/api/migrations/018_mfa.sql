-- 018_mfa.sql : TOTP second factor for the privileged step-up (auth/step-up).
-- A user with a CONFIRMED row must present a valid code (or a one-time recovery code) to step up.
CREATE TABLE IF NOT EXISTS api_user_mfa (
    user_id         uuid PRIMARY KEY REFERENCES api_users(id) ON DELETE CASCADE,
    secret_enc      text NOT NULL,                 -- AES-GCM sealed base32 secret ('plain:' prefix only when no key is configured, dev)
    confirmed_at    timestamptz,                   -- NULL while enrolling
    last_counter    bigint NOT NULL DEFAULT 0,     -- highest accepted 30s step: a code can't be replayed
    recovery_hashes text[] NOT NULL DEFAULT '{}',  -- sha256 of unused one-time recovery codes
    created_at      timestamptz NOT NULL DEFAULT now()
);
