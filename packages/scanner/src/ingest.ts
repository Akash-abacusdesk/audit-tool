import type { ScanEnvelope } from '@platform/shared';

export interface IngestDeps {
  fetch?: typeof fetch;
}

/**
 * Transport (SCANNING-CONVENTIONS §4.3): POST the normalized envelope to the
 * scanning service sink. Idempotency comes from `finding_fingerprint` upsert,
 * mirrored here by the Idempotency-Key header so retried batches are safe.
 */
export async function ingestEnvelope(
  baseUrl: string,
  scanId: string,
  envelope: ScanEnvelope,
  idempotencyKey: string,
  deps: IngestDeps = {},
): Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/scans/${scanId}/findings`;
  return doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(envelope),
  });
}
