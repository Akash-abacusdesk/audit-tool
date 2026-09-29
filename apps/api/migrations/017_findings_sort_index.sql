-- 017_findings_sort_index.sql : the findings list orders by severity rank, then newest. That was an expression
-- (CASE severity ...) no index could serve, so every page sorted all matching rows. Materialize the rank as a
-- generated column and index the exact ORDER BY. (Adds a stored column: rewrites the table once.)
ALTER TABLE api_scan_findings
  ADD COLUMN IF NOT EXISTS severity_rank smallint GENERATED ALWAYS AS (
    CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
  ) STORED;

CREATE INDEX IF NOT EXISTS api_scan_findings_list_idx
  ON api_scan_findings (project_id, severity_rank, created_at DESC, id DESC);

-- Substring search (ILIKE '%x%') on title/description. pg_trgm is a trusted extension; where the role may not
-- create it, skip quietly - search then falls back to a scan, as before.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS api_scan_findings_title_trgm_idx ON api_scan_findings USING gin (title gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm unavailable (%), skipping trigram index', SQLERRM;
END
$$;
