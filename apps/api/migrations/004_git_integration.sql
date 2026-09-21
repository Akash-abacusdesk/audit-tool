-- 004_git_integration — Section 3 (S3-D1): git connections, webhook events,
-- repo links + branch/commit/PR mapping, stack-detection results, policy
-- assignments. Contracts: packages/shared/src/git.ts.
--
-- ORDERING NOTE: 003_privileged_admin.sql is owned by pam's in-flight branch;
-- this file assumes it merges first (migrate runner gap-checks numbering).
-- Authorization model: every row hangs off Section-2 scopes
-- (api_orgs > api_projects > api_environments); no new permission tables.

-- Provider connections (org ↔ github/gitlab/bitbucket). Tokens/secrets live
-- server-side only; nothing secret is stored in these rows.
CREATE TABLE IF NOT EXISTS api_git_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES api_orgs(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('github', 'gitlab', 'bitbucket')),
  display_name text,
  external_account_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
  created_by uuid NOT NULL REFERENCES api_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider, external_account_id)
);

-- Raw webhook deliveries after signature verification; delivery_id dedupes replays.
CREATE TABLE IF NOT EXISTS api_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES api_git_connections(id) ON DELETE CASCADE,
  delivery_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'push', 'pull_request.opened', 'pull_request.synchronize', 'pull_request.closed')),
  verified boolean NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (connection_id, delivery_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_unprocessed
  ON api_webhook_events (received_at) WHERE processed_at IS NULL;

-- Internal repo ↔ project binding.
CREATE TABLE IF NOT EXISTS api_repo_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES api_orgs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES api_projects(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES api_git_connections(id) ON DELETE CASCADE,
  external_repo_id text NOT NULL,
  full_name text NOT NULL,
  default_branch text NOT NULL DEFAULT 'main',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, connection_id, external_repo_id)
);

CREATE TABLE IF NOT EXISTS api_git_branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_link_id uuid NOT NULL REFERENCES api_repo_links(id) ON DELETE CASCADE,
  name text NOT NULL,
  head_sha text CHECK (head_sha ~ '^[0-9a-f]{7,40}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_link_id, name)
);

CREATE TABLE IF NOT EXISTS api_git_commits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_link_id uuid NOT NULL REFERENCES api_repo_links(id) ON DELETE CASCADE,
  sha text NOT NULL CHECK (sha ~ '^[0-9a-f]{7,40}$'),
  branch text NOT NULL,
  author_email text,
  message text,
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_link_id, sha)
);

CREATE TABLE IF NOT EXISTS api_git_pull_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_link_id uuid NOT NULL REFERENCES api_repo_links(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  source_branch text NOT NULL,
  target_branch text NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'merged', 'closed')),
  title text,
  head_sha text CHECK (head_sha ~ '^[0-9a-f]{7,40}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_link_id, external_id)
);

-- Stack-detection persistence (kevin's detector output verbatim:
-- { stacks, headless, evidence }). Enum membership enforced by the shared zod
-- contract at the API boundary; schema keeps text[] for forward-compat.
CREATE TABLE IF NOT EXISTS api_stack_detections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES api_projects(id) ON DELETE CASCADE,
  environment_id uuid REFERENCES api_environments(id) ON DELETE SET NULL,
  stacks text[] NOT NULL DEFAULT '{}',
  headless boolean NOT NULL,
  evidence jsonb,
  source_commit_sha text CHECK (source_commit_sha ~ '^[0-9a-f]{7,40}$'),
  detector_version text NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stack_detections_project
  ON api_stack_detections (project_id, detected_at DESC);

-- Policy assignments bind policy-catalog keys to RBAC scopes; uniqueness per
-- exact scope path via partial unique indexes.
CREATE TABLE IF NOT EXISTS api_policy_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id text NOT NULL,
  org_id uuid NOT NULL REFERENCES api_orgs(id) ON DELETE CASCADE,
  project_id uuid REFERENCES api_projects(id) ON DELETE CASCADE,
  environment_id uuid REFERENCES api_environments(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES api_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_assignment_org
  ON api_policy_assignments (policy_id, org_id)
  WHERE project_id IS NULL AND environment_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_assignment_project
  ON api_policy_assignments (policy_id, project_id)
  WHERE project_id IS NOT NULL AND environment_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_assignment_env
  ON api_policy_assignments (policy_id, environment_id)
  WHERE environment_id IS NOT NULL;
