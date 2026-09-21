/**
 * GitHub REST client for repo snapshot sync (S3-D1B). Zero new deps —
 * global fetch only. GIT_API_BASE_URL overrides the API root (integration
 * tests point it at a canned stub; production default is api.github.com).
 *
 * ponytail: first page only (per_page=100). Walk Link headers when repos
 * outgrow 100 branches/commits/PRs per snapshot.
 */
import type { PullRequestState } from '@platform/shared';

export interface GitHubBranch {
  name: string;
  headSha: string | null;
}

export interface GitHubCommit {
  sha: string;
  authorEmail: string | null;
  message: string | null;
  committedAt: Date | null;
}

export interface GitHubPullRequest {
  externalId: string;
  sourceBranch: string;
  targetBranch: string;
  state: PullRequestState;
  title: string | null;
  headSha: string | null;
  updatedAt: Date;
}

export interface RepoSnapshot {
  branches: GitHubBranch[];
  commits: GitHubCommit[];
  pullRequests: GitHubPullRequest[];
}

export interface FetchSnapshotOptions {
  fullName: string;
  token?: string | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Commits are listed for this ref; defaults to the repo's default branch. */
  branch?: string;
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

function shaOrNull(value: unknown): string | null {
  return typeof value === 'string' && SHA_RE.test(value) ? value : null;
}

/** GitHub PR wire state -> our tri-state (open / merged / closed). */
export function derivePrState(state: unknown, mergedAt: unknown): PullRequestState {
  if (state === 'open') return 'open';
  return typeof mergedAt === 'string' ? 'merged' : 'closed';
}

export function mapBranch(raw: unknown): GitHubBranch | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const commit = r.commit as Record<string, unknown> | undefined;
  const name = typeof r.name === 'string' && r.name.length > 0 ? r.name : null;
  if (!name) return null;
  return { name, headSha: shaOrNull(commit?.sha) };
}

export function mapCommit(raw: unknown): GitHubCommit | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const inner = r.commit as Record<string, unknown> | undefined;
  const author = inner?.author as Record<string, unknown> | undefined;
  const committer = inner?.committer as Record<string, unknown> | undefined;
  if (typeof r.sha !== 'string' || !SHA_RE.test(r.sha)) return null;
  const date = typeof committer?.date === 'string' ? new Date(committer.date) : null;
  return {
    sha: r.sha,
    authorEmail: typeof author?.email === 'string' ? author.email : null,
    message: typeof inner?.message === 'string' ? inner.message : null,
    committedAt: date && !Number.isNaN(date.getTime()) ? date : null,
  };
}

export function mapPullRequest(raw: unknown): GitHubPullRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const head = r.head as Record<string, unknown> | undefined;
  const base = r.base as Record<string, unknown> | undefined;
  const updatedAt = typeof r.updated_at === 'string' ? new Date(r.updated_at) : new Date(0);
  return {
    externalId: String(r.number),
    sourceBranch: typeof head?.ref === 'string' ? head.ref : '',
    targetBranch: typeof base?.ref === 'string' ? base.ref : '',
    state: derivePrState(r.state, r.merged_at),
    title: typeof r.title === 'string' ? r.title : null,
    headSha: shaOrNull(head?.sha),
    updatedAt: Number.isNaN(updatedAt.getTime()) ? new Date(0) : updatedAt,
  };
}

async function getJson(
  url: string,
  token: string | null | undefined,
  fetchImpl: typeof fetch
): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'devsecops-platform-api',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  // ponytail: hard provider timeout — an unbounded fetch hangs the sync
  // request path forever (observed deterministically in integration runs);
  // upgrade path: per-provider retry policy if flakiness ever shows.
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw Object.assign(
      new Error(`github ${url.split('?')[0]} unreachable: ${(err as Error)?.name ?? 'error'}`),
      { status: 503, providerUnreachable: true }
    );
  }
  if (!res.ok) {
    throw Object.assign(new Error(`github ${url.split('?')[0]} -> ${res.status}`), {
      status: res.status,
    });
  }
  return res.json();
}

export async function fetchRepoSnapshot(opts: FetchSnapshotOptions): Promise<RepoSnapshot> {
  const f = opts.fetchImpl ?? fetch;
  const base = (opts.baseUrl ?? process.env.GIT_API_BASE_URL ?? 'https://api.github.com').replace(/\/$/, '');
  const slash = opts.fullName.indexOf('/');
  if (slash <= 0 || slash === opts.fullName.length - 1) {
    throw new Error(`invalid repository full_name: ${opts.fullName}`);
  }
  // Encode segments separately — the "/" between owner and repo is path structure.
  const repoBase = `${base}/repos/${encodeURIComponent(opts.fullName.slice(0, slash))}/${encodeURIComponent(opts.fullName.slice(slash + 1))}`;
  const q = `?per_page=100`;
  const [bRaw, cRaw, pRaw] = await Promise.all([
    getJson(`${repoBase}/branches${q}`, opts.token, f),
    getJson(
      `${repoBase}/commits${q}${opts.branch ? `&sha=${encodeURIComponent(opts.branch)}` : ''}`,
      opts.token,
      f
    ),
    getJson(`${repoBase}/pulls?state=all&sort=updated&direction=desc&per_page=100`, opts.token, f),
  ]);
  const compact = <T>(raw: unknown, map: (x: unknown) => T | null): T[] =>
    Array.isArray(raw) ? raw.map(map).filter((x): x is T => x !== null) : [];
  return {
    branches: compact(bRaw, mapBranch),
    commits: compact(cRaw, mapCommit),
    pullRequests: compact(pRaw, mapPullRequest),
  };
}
