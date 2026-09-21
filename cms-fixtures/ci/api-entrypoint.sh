#!/usr/bin/env sh
# S6-D2 CI entrypoint: wait for postgres, run all migrations, boot the API sink.
set -e

DB="${DATABASE_URL:-postgres://platform:devsecops@postgres:5432/platform?sslmode=disable}"
echo "s6 api: waiting for postgres at ${DB}"

node -e "
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL });
(async () => {
  for (let i = 0; i < 30; i++) {
    try { await c.connect(); await c.end(); console.log('s6 api: pg ready'); return; }
    catch (e) { await new Promise(r => setTimeout(r, 2000)); }
  }
  console.error('s6 api: postgres not reachable'); process.exit(1);
})();
" 2>&1

echo "s6 api: running migrations (incl 006_scan_findings)"
cd /app/apps/api
node dist/db/migrate-cli.js

echo "s6 api: booting"
exec node dist/main.js
