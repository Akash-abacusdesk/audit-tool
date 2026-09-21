/**
 * WordPress-style version comparison for advisory correlation (S10-D3).
 *
 * WP versions are dotted numerics ("6.3.1", "1.2.3", occasionally "6.4").
 * Comparison is numeric per-segment with zero-padding so "6.4" < "6.4.1".
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * A version `v` is vulnerable when any range matches:
 *   (introduced == null || v >= introduced) && (fixed == null || v < fixed)
 * `fixed` is the first non-vulnerable version (exclusive upper bound).
 */
export interface VersionRange {
  introduced?: string;
  fixed?: string;
}

export function isVulnerable(v: string, ranges: VersionRange[]): boolean {
  return ranges.some((r) => {
    const introduces = r.introduced === undefined || compareVersions(v, r.introduced) >= 0;
    const belowFixed = r.fixed === undefined || compareVersions(v, r.fixed) < 0;
    return introduces && belowFixed;
  });
}
