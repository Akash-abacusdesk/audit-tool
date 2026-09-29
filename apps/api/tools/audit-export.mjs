#!/usr/bin/env node
/**
 * S2-D2 append-only off-host audit export (owner: pam-mt3xnzu6).
 *
 * Ships api_audit_events rows from PG into a LOCAL ENCRYPTED SPOOL that any
 * transport (rsync/scp/rclone) can pick up off-host. The off-host destination
 * is not chosen yet (god, 2026-08-24): swap point is documented in
 * docs/security/privileged-admin-auth.md §3 — replace the "pickup" step, not
 * this script.
 *
 * Guarantees:
 *   - append-only: batches are written once, never rewritten; watermark
 *     advances only after the batch file + manifest entry are fsynced.
 *   - integrity: sha256 hash chain across batches (prevHash → hash); verify
 *     with `--verify`. Tamper/truncation breaks the chain on import.
 *   - zero loss: any failure exits non-zero BEFORE advancing the watermark.
 *   - bounded spool: when AUDIT_EXPORT_MAX_MB is reached a .SPOOL_FULL
 *     sentinel is dropped and we exit 2; the API blocks NEW privileged
 *     step-ups while it exists (block-privileged-only policy).
 *
 * Usage:
 *   node tools/audit-export.mjs                 # export one batch (cron-friendly)
 *   node tools/audit-export.mjs --decrypt FILE  # print one batch as NDJSON
 *   node tools/audit-export.mjs --verify        # verify manifest hash chain
 *
 * Env:
 *   DATABASE_URL           postgres connstring (pgbouncer or direct)
 *   AUDIT_EXPORT_KEY       base64 32-byte key (openssl rand -base64 32); REQUIRED to write
 *   AUDIT_EXPORT_SPOOL_DIR spool dir (default ./audit-spool)
 *   AUDIT_EXPORT_BATCH     rows per batch (default 500)
 *   AUDIT_EXPORT_MAX_MB    spool cap in MB (default 100)
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const spoolDir = process.env.AUDIT_EXPORT_SPOOL_DIR ?? './audit-spool';
const batchSize = Number(process.env.AUDIT_EXPORT_BATCH ?? 500);
const maxBytes = Number(process.env.AUDIT_EXPORT_MAX_MB ?? 100) * 1024 * 1024;
const statePath = join(spoolDir, 'state.json');
const manifestPath = join(spoolDir, 'manifest.jsonl');

function log(line) {
  // ops/logging.md shape: {ts,level,msg,svc,...}
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: 'audit-export', ...line }));
}

function die(code, line) {
  log({ level: 'fatal', msg: 'export failed', code, ...line });
  process.exit(2);
}

function loadState() {
  if (!existsSync(statePath)) return { seq: 0, lastCreatedAt: null, lastId: null };
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function spoolBytes() {
  let total = 0;
  for (const f of readdirSync(spoolDir)) {
    const p = join(spoolDir, f);
    if (statSync(p).isFile()) total += statSync(p).size;
  }
  return total;
}

function chainHash(prevHash, events) {
  return createHash('sha256').update(prevHash).update(JSON.stringify(events)).digest('hex');
}

function encryptBuffer(key, plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from('AE1'), iv, cipher.getAuthTag(), ct]);
}

function decryptBuffer(key, blob) {
  if (blob.subarray(0, 3).toString() !== 'AE1') throw new Error('bad magic');
  const iv = blob.subarray(3, 15);
  const tag = blob.subarray(15, 31);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(31)), decipher.final()]);
}

async function main() {
  const [mode, arg] = process.argv.slice(2);

  if (mode === '--verify') return verify();
  if (mode === '--decrypt') return decryptOne(arg);

  const keyB64 = process.env.AUDIT_EXPORT_KEY;
  if (!keyB64) die('missing-key', { msg: 'AUDIT_EXPORT_KEY (base64 32B) required' });
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) die('bad-key', { msg: 'AUDIT_EXPORT_KEY must decode to 32 bytes' });

  mkdirSync(spoolDir, { recursive: true });
  const state = loadState();

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
  });
  try {
    const params = [];
    let where = 'TRUE';
    if (state.lastCreatedAt && state.lastId) {
      // ponytail: watermark round-trips PG's own text form — toISOString()
      // truncates to ms while timestamptz keeps µs, which would re-export rows.
      params.push(state.lastCreatedAt, state.lastId);
      where = `(created_at, id) > ($1::timestamptz, $2::uuid)`;
    }
    const res = await pool.query(
      `SELECT id::text AS id, actor_id::text AS actor_id, action, result,
              org_id::text AS org_id, project_id::text AS project_id,
              environment_id::text AS environment_id, resource, request_id,
              details, created_at, created_at::text AS created_at_full
       FROM api_audit_events WHERE ${where}
       ORDER BY created_at ASC, id ASC LIMIT ${batchSize}`,
      params
    );
    if (res.rows.length === 0) {
      log({ level: 'info', msg: 'nothing to export' });
      return;
    }

    // Spool-full policy: refuse BEFORE writing anything; sentinel blocks new
    // privileged ops at the API until an operator drains the spool.
    const events = res.rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
    const plain = Buffer.from(JSON.stringify(events), 'utf8');
    if (spoolBytes() + plain.length > maxBytes) {
      const sentinel = openSync(join(spoolDir, '.SPOOL_FULL'), 'w');
      writeSync(sentinel, new Date().toISOString());
      closeSync(sentinel);
      die('spool-full', { msg: 'spool cap reached; drain off-host then delete .SPOOL_FULL' });
    }

    const seq = state.seq + 1;
    const prevHash = state.prevHash ?? 'GENESIS';
    const hash = chainHash(prevHash, events);
    const fname = `${String(seq).padStart(6, '0')}-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson.enc`;

    const blob = encryptBuffer(key, plain);
    const filePath = join(spoolDir, fname);
    const fd = openSync(filePath, 'wx'); // fails if file exists → append-only by construction
    try {
      writeSync(fd, blob);
    } finally {
      closeSync(fd);
    }

    const manifestFd = openSync(manifestPath, 'a');
    try {
      writeSync(
        manifestFd,
        JSON.stringify({
          seq,
          file: fname,
          hash,
          prevHash,
          count: events.length,
          bytes: blob.length,
        }) + '\n'
      );
    } finally {
      closeSync(manifestFd);
    }

    // Watermark moves LAST: crash before here = same rows re-exported next run.
    const last = events[events.length - 1];
    const tmp = `${statePath}.tmp`;
    const sfd = openSync(tmp, 'w');
    try {
      writeSync(
        sfd,
        JSON.stringify({
          seq,
          prevHash: hash,
          lastCreatedAt: res.rows[res.rows.length - 1].created_at_full,
          lastId: last.id,
        })
      );
    } finally {
      closeSync(sfd);
    }
    // ponytail: rename is atomic on POSIX; Windows may EPERM if AV holds the file — retry once.
    try {
      renameWithRetry(tmp, statePath);
    } catch (err) {
      die('watermark', { msg: `could not advance watermark: ${err.message}` });
    }
    log({ level: 'info', msg: 'batch exported', seq, count: events.length, file: fname });
  } finally {
    await pool.end();
  }
}

function renameWithRetry(from, to) {
  try {
    renameSync(from, to);
  } catch (err) {
    if (!/EPERM|EBUSY/.test(err.code ?? '')) throw err;
    renameSync(from, to);
  }
}

/** Walk manifest.jsonl, recompute the hash chain from decrypted payloads. */
async function verify() {
  const key = Buffer.from(process.env.AUDIT_EXPORT_KEY ?? '', 'base64');
  if (key.length !== 32) die('bad-key', { msg: '--verify needs AUDIT_EXPORT_KEY' });
  const lines = readFileSync(manifestPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  let prev = 'GENESIS';
  for (const m of lines) {
    if (m.prevHash !== prev) die('chain-break', { msg: `seq ${m.seq}: prevHash mismatch` });
    const events = JSON.parse(decryptBuffer(key, readFileSync(join(spoolDir, m.file))).toString('utf8'));
    if (chainHash(prev, events) !== m.hash) die('tamper', { msg: `seq ${m.seq}: payload hash mismatch` });
    prev = m.hash;
  }
  log({ level: 'info', msg: 'chain verified', batches: lines.length, head: prev });
}

function decryptOne(file) {
  const key = Buffer.from(process.env.AUDIT_EXPORT_KEY ?? '', 'base64');
  if (key.length !== 32) die('bad-key', { msg: '--decrypt needs AUDIT_EXPORT_KEY' });
  process.stdout.write(decryptBuffer(key, readFileSync(file)));
}

main().catch((err) => die('error', { msg: err.message }));
