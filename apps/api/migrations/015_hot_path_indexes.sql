-- 015_hot_path_indexes.sql : indexes for queries that were sequential scans or
-- in-memory sorts (found in the scale review). All IF NOT EXISTS, no data change.

-- GET /scans/:scanId filters on scan_id alone; UNIQUE(project_id, scan_id) can't serve it.
CREATE INDEX IF NOT EXISTS api_scan_runs_scan_id_idx ON api_scan_runs (scan_id);

-- Every verified webhook resolves the repo link by external id or full_name; sync looks it up by connection.
CREATE INDEX IF NOT EXISTS api_repo_links_external_idx ON api_repo_links (external_repo_id);
CREATE INDEX IF NOT EXISTS api_repo_links_conn_name_idx ON api_repo_links (connection_id, full_name);

-- Audit listing filters by org/project (newest first); the tenant fence also joins bindings by org.
CREATE INDEX IF NOT EXISTS api_audit_events_org_idx ON api_audit_events (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_audit_events_project_idx ON api_audit_events (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_role_bindings_org_user_idx ON api_role_bindings (org_id, user_id);

-- Commit list is ORDER BY committed_at within a repo link.
CREATE INDEX IF NOT EXISTS api_git_commits_link_time_idx ON api_git_commits (repo_link_id, committed_at DESC);

-- /jit/grants ORDER BY issued_at DESC.
CREATE INDEX IF NOT EXISTS jit_grants_issued_idx ON jit_grants (issued_at DESC);

-- FK without an index slows ON DELETE SET NULL on environments.
CREATE INDEX IF NOT EXISTS api_scan_findings_env_idx ON api_scan_findings (environment_id);
