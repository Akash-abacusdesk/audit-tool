-- S1 core tables owned by services/api (naming per docs/db-conventions.md §4).

CREATE TABLE api_examples (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_idempotency_keys (
    endpoint            text NOT NULL,
    key                 text NOT NULL,
    request_fingerprint text NOT NULL,
    status_code         int  NOT NULL,
    response_body       jsonb NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (endpoint, key)
);

CREATE INDEX api_examples_created_at_idx ON api_examples (created_at DESC);
