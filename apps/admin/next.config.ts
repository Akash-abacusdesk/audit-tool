import type { NextConfig } from 'next';

// Same-origin proxy to the real API: avoids CORS entirely and keeps the
// bearer token off any cross-origin request. Point API_BASE_URL at wherever
// apps/api actually runs (default: local dev boot on :3000).
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000';

const nextConfig: NextConfig = {
  // Self-contained server output (no full node_modules) for a small runtime image.
  output: 'standalone',
  // Next 16 dev otherwise writes AGENTS.md / CLAUDE.md into this app on every start.
  agentRules: false,
  // Dev only: let the HMR socket connect when the app is opened as 127.0.0.1 rather than localhost.
  allowedDevOrigins: ['127.0.0.1'],
  experimental: { optimizePackageImports: ['motion'] },
  async headers() {
    const isProd = process.env.NODE_ENV === 'production';
    // Next's own bootstrap needs inline scripts/styles, so script-src keeps 'unsafe-inline'; everything else is
    // locked to same-origin. The dev server uses eval (HMR), so CSP is production-only. The point is to cut the ways
    // injected content could load code or leak the session token: no third-party origins, no framing, no plugins.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; ');
    return [
      {
        source: '/:path*',
        headers: [
          ...(isProd ? [{ key: 'Content-Security-Policy', value: csp }] : []),
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        ],
      },
    ];
  },
  async rewrites() {
    return [{ source: '/api-proxy/:path*', destination: `${API_BASE_URL}/api/v1/:path*` }];
  },
};

export default nextConfig;
