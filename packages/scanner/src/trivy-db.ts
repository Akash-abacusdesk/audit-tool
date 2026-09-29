import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Keeps trivy's vulnerability DB fresh in a persistent cache directory, OUT of the scan path.
 *
 * Trivy's own downloader gives up after 5 minutes and dies on the first dropped connection ("unexpected EOF"),
 * which on a slow link means a scan can never finish. This fetches the same OCI layer from ghcr.io with HTTP Range
 * resume + retries, verifies its sha256 against the manifest digest, extracts it and swaps it into place, so a scan
 * only ever reads a complete DB (`--skip-db-update`).
 */
export interface RefreshOptions {
  /** the persistent cache dir mounted at /tmp/trivy-cache (TRIVY_CACHE_HOST_DIR). */
  cacheDir: string;
  registry?: string; // default https://ghcr.io
  repository?: string; // default aquasecurity/trivy-db
  tag?: string; // default 2 (schema version)
  attempts?: number; // download attempts, default 20
  fetchImpl?: typeof fetch;
  /** extracts a .tar.gz into a directory; default is the in-process extractTarGz. */
  extract?: (archive: string, into: string) => Promise<void>;
  log?: (msg: string) => void;
}

export interface RefreshResult {
  updated: boolean;
  digest: string;
}

const LAYER_MEDIA_TYPE = 'application/vnd.aquasec.trivy.db.layer.v1.tar+gzip';

/**
 * Minimal streaming tar.gz extractor for the trivy-db layer (plain regular files, no links). In-process on purpose:
 * the `tar` on PATH is not portable (Git-for-Windows' GNU tar reads `C:\x` as a remote host). Files are written flat
 * under `into` using only the entry's base name, so a hostile archive cannot escape the directory.
 */
export async function extractTarGz(archive: string, into: string): Promise<void> {
  let buf: Buffer = Buffer.alloc(0);
  let out: Awaited<ReturnType<typeof open>> | null = null;
  let remaining = 0; // file bytes still to write for the current entry
  let pad = 0; // 512-byte block padding still to skip after the current entry
  const source = createReadStream(archive).pipe(createGunzip());
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (out || remaining > 0) {
          const take = Math.min(remaining, buf.length);
          if (take > 0) {
            if (out) await out.write(buf.subarray(0, take));
            buf = buf.subarray(take);
            remaining -= take;
          }
          if (remaining > 0) break; // need more input
          if (out) {
            await out.close();
            out = null;
          }
        }
        if (pad > 0) {
          const skip = Math.min(pad, buf.length);
          buf = buf.subarray(skip);
          pad -= skip;
          if (pad > 0) break;
        }
        if (buf.length < 512) break;
        const header = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (header.every((b) => b === 0)) continue; // end-of-archive block
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
        const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
        const type = String.fromCharCode(header[156] || 48);
        pad = (512 - (size % 512)) % 512;
        remaining = size;
        if ((type === '0' || type === '\0') && basename(name)) out = await open(join(into, basename(name)), 'w');
        // any other entry type (dirs, pax headers) carries no file we need: its body, if any, is skipped via `remaining`
      }
    }
  } finally {
    await out?.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

export async function refreshTrivyDb(opts: RefreshOptions): Promise<RefreshResult> {
  const f = opts.fetchImpl ?? fetch;
  const base = (opts.registry ?? 'https://ghcr.io').replace(/\/$/, '');
  const repo = opts.repository ?? 'aquasecurity/trivy-db';
  const log = opts.log ?? (() => {});
  const extract = opts.extract ?? extractTarGz;
  const attempts = opts.attempts ?? 20;

  const token = async (): Promise<string> => {
    const r = await f(`${base}/token?scope=repository:${repo}:pull`);
    if (!r.ok) throw new Error(`registry token request failed: ${r.status}`);
    return ((await r.json()) as { token: string }).token;
  };
  const auth = async (): Promise<Record<string, string>> => ({ authorization: `Bearer ${await token()}` });

  const mres = await f(`${base}/v2/${repo}/manifests/${opts.tag ?? '2'}`, {
    headers: { ...(await auth()), accept: 'application/vnd.oci.image.manifest.v1+json' },
  });
  if (!mres.ok) throw new Error(`trivy-db manifest request failed: ${mres.status}`);
  const layer = ((await mres.json()) as { layers: { mediaType: string; digest: string; size: number }[] }).layers.find(
    (l) => l.mediaType === LAYER_MEDIA_TYPE
  );
  if (!layer) throw new Error('trivy-db manifest has no DB layer');
  const want = layer.digest.replace(/^sha256:/, '');

  const dbDir = join(opts.cacheDir, 'db');
  const marker = join(dbDir, '.layer-digest');
  const current = await readFile(marker, 'utf8').catch(() => '');
  if (current.trim() === want && (await stat(join(dbDir, 'trivy.db')).catch(() => null))) {
    log('trivy db already current');
    return { updated: false, digest: want };
  }

  await mkdir(opts.cacheDir, { recursive: true });
  const archive = join(opts.cacheDir, 'db.tar.gz.part');
  for (let attempt = 1; ; attempt++) {
    const have = (await stat(archive).catch(() => null))?.size ?? 0;
    if (have >= layer.size) break;
    try {
      const res = await f(`${base}/v2/${repo}/blobs/${layer.digest}`, {
        headers: { ...(await auth()), ...(have > 0 ? { range: `bytes=${have}-` } : {}) },
        redirect: 'follow',
      });
      if (res.status !== 200 && res.status !== 206) throw new Error(`blob request failed: ${res.status}`);
      // A server that ignores Range answers 200 with the full body: start over rather than appending.
      const resume = res.status === 206 && have > 0;
      if (!resume && have > 0) await rm(archive, { force: true });
      // Write each chunk before reading the next: if the connection drops mid-body, everything received so far is
      // already on disk, so the Range resume continues from there (a stream pipeline can discard buffered bytes on error).
      const fh = await open(archive, resume ? 'a' : 'w');
      try {
        for await (const chunk of Readable.fromWeb(res.body as never) as AsyncIterable<Buffer>) await fh.write(chunk);
      } finally {
        await fh.close();
      }
    } catch (err) {
      log(`trivy db download attempt ${attempt} interrupted: ${(err as Error).message}`);
      if (attempt >= attempts) throw new Error(`trivy db download failed after ${attempts} attempts`);
      await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** attempt)));
    }
  }

  if ((await sha256File(archive)) !== want) {
    await rm(archive, { force: true }); // corrupt or truncated-and-padded: never extract, restart clean next time
    throw new Error('trivy db checksum mismatch');
  }

  const fresh = join(opts.cacheDir, 'db.new');
  await rm(fresh, { recursive: true, force: true });
  await mkdir(fresh, { recursive: true });
  await extract(archive, fresh);
  await writeFile(join(fresh, '.layer-digest'), want);
  // Swap: a scan already running keeps its open file; the next scan sees the new DB.
  const old = join(opts.cacheDir, 'db.old');
  await rm(old, { recursive: true, force: true });
  await rename(dbDir, old).catch(() => {});
  await rename(fresh, dbDir);
  await rm(old, { recursive: true, force: true }).catch(() => {});
  await rm(archive, { force: true });
  log('trivy db updated');
  return { updated: true, digest: want };
}
