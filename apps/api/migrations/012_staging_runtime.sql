-- 012_staging_runtime.sql : Section-11 D2 real container provisioning.
-- Records which docker network/containers/port back a staging run so the
-- test-run and destroy jobs can find them again after the provision job
-- that created them has finished.

ALTER TABLE api_staging_runs ADD COLUMN IF NOT EXISTS runtime jsonb;
