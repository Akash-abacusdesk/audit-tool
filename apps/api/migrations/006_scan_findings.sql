-- 006_scan_findings — Section 5 (S5-D1): normalized findings + scan-run
-- persistence + lifecycle state.
--
-- Owned by services/api (naming per docs/db-conventions.md §4 -> api_ prefix).
-- SCANNING-CONVENTIONS.md §4 names these scan_runs/scan_findings; in this
-- monorepo the API service *is* the scanning service, so the api_ prefix is
-- applied. Cross-service SQL stays forbidden regardless of the table name.
--
-- Ingestion contract: adapters POST the §2 envelope to
-- POST /api/v1/scans/:scanId/findings. finding_fingerprint is the dedup key;
-- UNIQUE (project_id, finding_fingerprint) so re-scans / retries never
-- duplicate a row (idempotent upsert), without risking cross-tenant collision.

CREATE TABLE IF NOT EXISTS api_scan_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id            text NOT NULL,
  project_id         uuid NOT NULL REFERENCES api_projects(id) ON DELETE CASCADE,
  environment_id     uuid REFERENCES api_environments(id) ON DELETE SET NULL,
  tool_name          text NOT NULL,
  tool_version       text,
  image_digest       text,
  target_kind        text,
  target_ref         text,
  target_branch      text,
  started_at         timestamptz,
  finished_at        timestamptz,
  status             text NOT NULL CHECK (status IN ('completed', 'failed', 'partial')),
  error_summary      text,
  raw_artifact_path  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, scan_id)
);

CREATE TABLE IF NOT EXISTS api_scan_findings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_run_id         uuid NOT NULL REFERENCES api_scan_runs(id) ON DELETE CASCADE,
  project_id          uuid NOT NULL REFERENCES api_projects(id) ON DELETE CASCADE,
  environment_id      uuid REFERENCES api_environments(id) ON DELETE SET NULL,
  finding_fingerprint text NOT NULL,
  rule_id             text,
  title               text NOT NULL,
  description         text,
  severity            text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  native_severity     text,
  confidence          text NOT NULL DEFAULT 'firm' CHECK (confidence IN ('certain', 'firm', 'tentative')),
  scanner             text NOT NULL,
  scanner_version     text,
  image_digest        text,
  target_ref          text,
  target_branch       text,
  location            jsonb,
  evidence            text,
  remediation         jsonb,
  cve_ids             jsonb,
  advisory_ids        jsonb,
  metadata            jsonb,
  raw_artifact_path   text,
  status              text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'in_progress', 'resolved', 'false_positive', 'dismissed')),
  assigned_to         uuid REFERENCES api_users(id) ON DELETE SET NULL,
  assigned_by         uuid REFERENCES api_users(id) ON DELETE SET NULL,
  assigned_at         timestamptz,
  remediation_status  text NOT NULL DEFAULT 'not_started'
                        CHECK (remediation_status IN ('not_started', 'in_progress', 'done', 'wont_fix')),
  resolved_at         timestamptz,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, finding_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_scan_findings_project
  ON api_scan_findings (project_id, severity, status);
CREATE INDEX IF NOT EXISTS idx_scan_findings_run
  ON api_scan_findings (scan_run_id);
CREATE INDEX IF NOT EXISTS idx_scan_findings_open
  ON api_scan_findings (project_id, severity) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_scan_runs_project
  ON api_scan_runs (project_id, created_at DESC);
