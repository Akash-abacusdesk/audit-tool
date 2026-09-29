import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const dir = join(root, 'infrastructure', 'recovery-host');
const compose = join(dir, 'docker-compose.yml');
const env = join(dir, '.env.example');

if (!existsSync(compose) || !existsSync(env)) {
  console.error('missing recovery-host compose or env example');
  process.exit(1);
}

for (const path of ['backups', 'wal']) {
  if (!existsSync(join(dir, path))) {
    console.error(`missing recovery-host ${path} directory`);
    process.exit(1);
  }
}

for (const path of ['backup.env.example', 'bin/basebackup-recovery-host.sh', 'bin/backup-recovery-host.sh', 'bin/verify-recovery-backups.sh', 'bin/restore-recovery-host.sh']) {
  if (!existsSync(join(dir, path))) {
    console.error(`missing recovery-host ${path}`);
    process.exit(1);
  }
}

const result = spawnSync(
  'docker',
  ['compose', '-f', compose, '--env-file', env, 'config', '--quiet'],
  { stdio: 'inherit', shell: process.platform === 'win32' }
);

process.exit(result.status ?? 1);
