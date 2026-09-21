/** Env-only config, fail-fast on missing required values. See infra/.env.example. */
export interface Config {
  port: number;
  databaseUrl: string;
  pgbossUrl: string;
  logLevel: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadConfig(): Config {
  const databaseUrl = required('DATABASE_URL');
  return {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl,
    // Same PG instance by default; pg-boss keeps its own 'pgboss' schema.
    pgbossUrl: process.env.PGBOSS_URL ?? databaseUrl,
    logLevel: process.env.LOG_LEVEL ?? 'info',
  };
}
