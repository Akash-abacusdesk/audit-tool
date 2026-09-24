-- 011_ai_remediation_requests.sql : Section-20 developer-triggered AI
-- remediation (S20-D1). Human-triggered and finding-scoped (PRD §8.4) --
-- the platform never autonomously patches production. A row here is a
-- proposed patch for human review; nothing writes to a branch/PR from this
-- table alone (PRD §8.4 steps 7-8 require explicit human approval first,
-- and real PR creation needs a live Git provider connection -- Phase 3).

CREATE TABLE IF NOT EXISTS api_ai_remediation_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id    uuid NOT NULL,
  project_id    uuid NOT NULL,
  environment_id uuid,
  requested_by  uuid NOT NULL,
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  provider      text,
  model         text,
  patch         text,
  explanation   text,
  test_guidance text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_ai_remediation_requests_finding_idx ON api_ai_remediation_requests (finding_id, created_at DESC);
