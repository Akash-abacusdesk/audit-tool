import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, verifyTotp } from '../../apps/api/src/auth/totp.js';

// RFC 4226 appendix D / RFC 6238 appendix B secret: ASCII "12345678901234567890"
const SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totp', () => {
  it('base32 round-trips and matches the RFC secret', () => {
    expect(base32Encode(Buffer.from('12345678901234567890'))).toBe(SECRET_B32);
    expect(base32Decode(SECRET_B32).toString()).toBe('12345678901234567890');
  });

  it('matches the RFC 4226 HOTP test vectors', () => {
    const s = Buffer.from('12345678901234567890');
    expect([0, 1, 2, 3, 9].map((c) => hotp(s, c))).toEqual(['755224', '287082', '359152', '969429', '520489']);
  });

  it('verifies within +-1 step, returns the step, and rejects others', () => {
    const t = 59_000; // RFC 6238: step 1 -> 287082 (6-digit form)
    expect(verifyTotp(SECRET_B32, '287082', t)).toBe(1);
    expect(verifyTotp(SECRET_B32, '287082', t + 30_000)).toBe(1); // one step late still accepted
    expect(verifyTotp(SECRET_B32, '287082', t + 90_000)).toBeNull();
    expect(verifyTotp(SECRET_B32, '000000', t)).toBeNull();
    expect(verifyTotp(SECRET_B32, 'abcdef', t)).toBeNull();
  });
});
