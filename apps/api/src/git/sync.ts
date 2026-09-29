/**
 * Repo snapshot sync (S3-D1B): provider fetch -> idempotent upsert of
 * branches/commits/pull-requests inside one transaction. Tables come from
 * migration 004; credentials from 005 (encrypted at rest via secretbox).
 */
import { Pool } from 'pg';
import { ApiError } from '@platform/shared';
import { decryptToken, encryptToken, loadCredentialsKey } from './secretbox.js';
import { fetchRepoSnapshot } from './github.js';

export interface SyncCounts {
  branches: number;
  commits: number;
  pullRequests: number;
}

interface LinkContext {
  repoLinkId: string;
  connectionId: string;
  fullName: string;
  defaultBranch: string;
  connectionStatus: string;
}

async function loadLink(pool: Pool, repoLinkId: string): Promise<LinkContext> {
  const row = await pool.query<{
    repo_link_id: string;
    connection_id: string;
    full_name: string;
    default_branch: string;
    connection_status: string;
  }>(
    `SELECT l.id::text AS repo_link_id, l.connection_id::text, l.full_name,
            l.default_branch, c.status AS connection_status
     FROM api_repo_links l JOIN api_git_connections c ON c.id = l.connection_id
     WHERE l.id = $1`,
    [repoLinkId]
  );
  const r = row.rows[0];
  if (!r) throw new ApiError('NOT_FOUND', `repo-link ${repoLinkId} not found`);
  if (r.connection_status !== 'active') {
    throw new ApiError('CONFLICT', `git connection is ${r.connection_status}`);
  }
  return {
    repoLinkId: r.repo_link_id,
    connectionId: r.connection_id,
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    connectionStatus: r.connection_status,
  };
}

/** Stored token for a connection, or null when none/anon is usable. */
async function loadToken(pool: Pool, connectionId: string): Promise<string | null> {
  const row = await pool.query<{ ciphertext: string }>(
    'SELECT ciphertext FROM api_git_credentials WHERE connection_id = $1',
    [connectionId]
  );
  if (!row.rows[0]) return null;
  try {
    return decryptToken(row.rows[0].ciphertext, loadCredentialsKey());
  } catch {
    // Key missing/misconfigured: treat as anonymous rather than failing the sync.
    return null;
  }
}

export async function storeCredential(
  pool: Pool,
  connectionId: string,
  token: string
): Promise<void> {
  const ciphertext = encryptToken(token, loadCredentialsKey());
  await pool.query(
    `INSERT INTO api_git_credentials (connection_id, ciphertext)
     VALUES ($1, $2)
     ON CONFLICT (connection_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
    [connectionId, ciphertext]
  );
}

export async function fetchSnapshotForLink(pool: Pool, link: LinkContext) {
  return fetchRepoSnapshot({
    fullName: link.fullName,
    token: await loadToken(pool, link.connectionId),
    branch: link.defaultBranch,
  });
}

export async function upsertSnapshot(pool: Pool, repoLinkId: string, snap: Awaited<ReturnType<typeof fetchSnapshotForLink>>, branchAttribution: string): Promise<SyncCounts> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let n = 0;
    for (const b of snap.branches) {
      await client.query(
        `INSERT INTO api_git_branches (repo_link_id, name, head_sha) VALUES ($1, $2, $3)
         ON CONFLICT (repo_link_id, name)
         DO UPDATE SET head_sha = EXCLUDED.head_sha, updated_at = now()`,
        [repoLinkId, b.name, b.headSha]
      );
      n++;
    }
    let c = 0;
    for (const k of snap.commits) {
      await client.query(
        `INSERT INTO api_git_commits (repo_link_id, sha, branch, author_email, message, committed_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (repo_link_id, sha)
         DO UPDATE SET author_email = EXCLUDED.author_email, message = EXCLUDED.message,
                       committed_at = EXCLUDED.committed_at`,
        [repoLinkId, k.sha, branchAttribution, k.authorEmail, k.message, k.committedAt]
      );
      c++;
    }
    let p = 0;
    for (const pr of snap.pullRequests) {
      await client.query(
        `INSERT INTO api_git_pull_requests
           (repo_link_id, external_id, source_branch, target_branch, state, title, head_sha, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (repo_link_id, external_id)
         DO UPDATE SET source_branch = EXCLUDED.source_branch, target_branch = EXCLUDED.target_branch,
                       state = EXCLUDED.state, title = EXCLUDED.title, head_sha = EXCLUDED.head_sha,
                       updated_at = now()`,
        [repoLinkId, pr.externalId, pr.sourceBranch || 'unknown', pr.targetBranch || 'unknown', pr.state, pr.title, pr.headSha, pr.updatedAt]
      );
      p++;
    }
    await client.query('COMMIT');
    return { branches: n, commits: c, pullRequests: p };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Manual sync trigger: resolve -> fetch -> upsert. Throws ApiError on the way. */
export async function syncRepoLink(pool: Pool, repoLinkId: string): Promise<{ counts: SyncCounts; syncedAt: Date }> {
  const link = await loadLink(pool, repoLinkId);
  let snap;
  try {
    snap = await fetchSnapshotForLink(pool, link);
  } catch (err) {
    throw new ApiError('UNAVAILABLE', `provider sync failed: ${(err as Error).message}`);
  }
  const counts = await upsertSnapshot(pool, link.repoLinkId, snap, link.defaultBranch);
  return { counts, syncedAt: new Date() };
}

/**
 * Consumer side of pam's webhook envelope (JOB.webhookReceived, payload
 * { eventId }): locate the persisted delivery, re-sync every repo link that
 * matches its repository full_name, then mark processed_at.
 */
export async function handleWebhookReceived(
  pool: Pool,
  eventId: string,
  log?: { error: (o: object, m: string) => void }
): Promise<void> {
  const ev = await pool.query<{ connection_id: string; full_name: string | null }>(
    `SELECT connection_id::text, payload #>> '{repository,full_name}' AS full_name
     FROM api_webhook_events WHERE id = $1 AND verified = true`,
    [eventId]
  );
  const e = ev.rows[0];
  if (!e || !e.full_name) {
    await markProcessed(pool, eventId);
    return;
  }
  const links = await pool.query<{ id: string }>(
    'SELECT id::text FROM api_repo_links WHERE connection_id = $1 AND full_name = $2',
    [e.connection_id, e.full_name]
  );
  let failed = 0;
  for (const l of links.rows) {
    try {
      await syncRepoLink(pool, l.id);
    } catch (err) {
      failed++;
      log?.error({ err, eventId, repoLinkId: l.id }, 'webhook-triggered sync failed');
    }
  }
  // A failed sync must not be recorded as processed: throw so pg-boss retries the delivery.
  if (failed > 0) throw new Error(`webhook ${eventId}: ${failed}/${links.rows.length} repo link sync(s) failed`);
  await markProcessed(pool, eventId);
}

async function markProcessed(pool: Pool, eventId: string): Promise<void> {
  await pool.query('UPDATE api_webhook_events SET processed_at = now() WHERE id = $1', [eventId]);
}
