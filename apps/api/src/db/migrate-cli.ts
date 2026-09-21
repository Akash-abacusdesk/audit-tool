import { loadConfig } from '../config.js';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';

/** CLI entry: apply pending migrations, print what ran, exit non-zero on failure. */
const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl);
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'no pending migrations');
} finally {
  await pool.end();
}
