import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { decryptToken, encryptToken, loadCredentialsKey } from '../git/secretbox.js';
import { generateSecret, verifyTotp } from './totp.js';

/** Key for sealing TOTP secrets: MFA_ENCRYPTION_KEY, else the shared credentials key; none = dev-only plaintext. */
function key(): Buffer | null {
  try {
    return loadCredentialsKey(process.env.MFA_ENCRYPTION_KEY);
  } catch {
    return null;
  }
}

function seal(secret: string): string {
  const k = key();
  if (!k) {
    if (process.env.NODE_ENV === 'production') throw new Error('MFA_ENCRYPTION_KEY (or GIT_CREDENTIALS_KEY) is required in production');
    return `plain:${secret}`;
  }
  return `enc:${encryptToken(secret, k)}`;
}

function open(stored: string): string | null {
  if (stored.startsWith('plain:')) return stored.slice(6);
  const k = key();
  return k && stored.startsWith('enc:') ? decryptToken(stored.slice(4), k) : null;
}

const sha = (s: string): string => createHash('sha256').update(s.trim().toUpperCase()).digest('hex');

export async function isMfaActive(pool: Pool, userId: string): Promise<boolean> {
  const r = await pool.query('SELECT 1 FROM api_user_mfa WHERE user_id = $1 AND confirmed_at IS NOT NULL', [userId]);
  return (r.rowCount ?? 0) > 0;
}

/** (Re)start enrollment. Returns null when a confirmed factor exists (disable it first). */
export async function beginEnrollment(pool: Pool, userId: string): Promise<string | null> {
  const secret = generateSecret();
  const r = await pool.query(
    `INSERT INTO api_user_mfa (user_id, secret_enc) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, last_counter = 0, recovery_hashes = '{}'
       WHERE api_user_mfa.confirmed_at IS NULL
     RETURNING user_id`,
    [userId, seal(secret)]
  );
  return r.rowCount === 1 ? secret : null;
}

/** Accept a TOTP code once per 30s step (replay-guarded). needConfirmed=false checks the enrolling factor. */
async function checkTotp(pool: Pool, userId: string, code: string, needConfirmed: boolean): Promise<boolean> {
  const row = await pool.query<{ secret_enc: string; last_counter: string }>(
    `SELECT secret_enc, last_counter::text FROM api_user_mfa WHERE user_id = $1 AND (confirmed_at IS NOT NULL) = $2`,
    [userId, needConfirmed]
  );
  const m = row.rows[0];
  if (!m) return false;
  const secret = open(m.secret_enc);
  const counter = secret ? verifyTotp(secret, code) : null;
  if (counter === null) return false;
  // Atomic replay guard: only a strictly newer step wins.
  const upd = await pool.query('UPDATE api_user_mfa SET last_counter = $2 WHERE user_id = $1 AND last_counter < $2', [userId, counter]);
  return upd.rowCount === 1;
}

/** Finish enrollment with the first valid code; returns one-time recovery codes (shown once) or null. */
export async function confirmEnrollment(pool: Pool, userId: string, code: string): Promise<string[] | null> {
  if (!(await checkTotp(pool, userId, code, false))) return null;
  const codes = Array.from({ length: 8 }, () => randomBytes(5).toString('hex').toUpperCase()); // 10 hex chars each
  const r = await pool.query(
    `UPDATE api_user_mfa SET confirmed_at = now(), recovery_hashes = $2::text[] WHERE user_id = $1 AND confirmed_at IS NULL`,
    [userId, codes.map(sha)]
  );
  return r.rowCount === 1 ? codes : null;
}

/** A valid TOTP code OR an unused recovery code (consumed on use). */
export async function verifySecondFactor(pool: Pool, userId: string, input: { code?: unknown; recoveryCode?: unknown }): Promise<boolean> {
  if (typeof input.code === 'string' && (await checkTotp(pool, userId, input.code, true))) return true;
  if (typeof input.recoveryCode === 'string' && input.recoveryCode.trim()) {
    const r = await pool.query(
      `UPDATE api_user_mfa SET recovery_hashes = array_remove(recovery_hashes, $2)
        WHERE user_id = $1 AND confirmed_at IS NOT NULL AND $2 = ANY(recovery_hashes)`,
      [userId, sha(input.recoveryCode)]
    );
    return r.rowCount === 1;
  }
  return false;
}

export async function disableMfa(pool: Pool, userId: string): Promise<void> {
  await pool.query('DELETE FROM api_user_mfa WHERE user_id = $1', [userId]);
}
