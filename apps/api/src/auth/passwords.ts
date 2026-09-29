import { randomBytes, scrypt as cbScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(cbScrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number }
) => Promise<Buffer>;

// ponytail: OWASP-recommended scrypt params; bump N only with a rehash-on-login path.
const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 64;

/** Hash format: scrypt$N$r$p$salthex$hashhex (self-describing, upgrade-friendly). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex!, 'hex');
  const expected = Buffer.from(hashHex!, 'hex');
  const actual = await scrypt(password, salt, expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;
/** Burn one scrypt so unknown/inactive accounts take as long as a real check (no account-existence timing oracle). */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('timing-equalizer');
  await verifyPassword(password, await dummyHash);
}
