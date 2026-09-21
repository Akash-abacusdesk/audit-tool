#!/usr/bin/env node
/**
 * Canned GitHub provider stub (S3-D1B integration battery).
 *
 * Runs as its own DETACHED process: on this floor, a listener owned by the
 * same console/job family as the API child is UNREACHABLE from that child
 * (loopback connects blackhole ~10s -> TimeoutError). A detached listener
 * escapes the family and answers instantly. The runner spawns us detached,
 * records our pid, and kills us at teardown.
 *
 * Env: GIT_STUB_PORT (default 6599), GIT_STUB_TOKEN (bearer we accept).
 */
const http = require('node:http');

const PORT = Number(process.env.GIT_STUB_PORT ?? 6599);
const TOKEN = process.env.GIT_STUB_TOKEN ?? 'stub-pat-token-1';

http.createServer((req, res) => {
  const okBody = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) {
    res.writeHead(401);
    res.end('{}');
    return;
  }
  if (req.url?.startsWith('/repos/octo/hello/branches')) {
    okBody([
      { name: 'main', commit: { sha: 'a'.repeat(40) } },
      { name: 'feat/widget', commit: { sha: 'b'.repeat(40) } },
    ]);
  } else if (req.url?.startsWith('/repos/octo/hello/commits')) {
    okBody([
      {
        sha: 'c'.repeat(40),
        commit: {
          author: { email: 'dev@example.com' },
          committer: { date: '2026-08-20T10:00:00Z' },
          message: 'add widget',
        },
      },
    ]);
  } else if (req.url?.startsWith('/repos/octo/hello/pulls')) {
    okBody([
      {
        number: 7,
        state: 'open',
        title: 'Add widget',
        head: { ref: 'feat/widget', sha: 'd'.repeat(40) },
        base: { ref: 'main' },
        updated_at: '2026-08-21T09:00:00Z',
        merged_at: null,
      },
      {
        number: 6,
        state: 'closed',
        title: 'Old thing',
        head: { ref: 'old', sha: 'e'.repeat(40) },
        base: { ref: 'main' },
        updated_at: '2026-08-19T09:00:00Z',
        merged_at: '2026-08-19T10:00:00Z',
      },
    ]);
  } else {
    res.writeHead(404);
    res.end('{}');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`github-stub on ${PORT}`));
