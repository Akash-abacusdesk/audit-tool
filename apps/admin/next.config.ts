import type { NextConfig } from 'next';

// Same-origin proxy to the real API: avoids CORS entirely and keeps the
// bearer token off any cross-origin request. Point API_BASE_URL at wherever
// apps/api actually runs (default: local dev boot on :3000).
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000';

const nextConfig: NextConfig = {
  // Self-contained server output (no full node_modules) for a small runtime image.
  output: 'standalone',
  experimental: { optimizePackageImports: ['motion'] },
  async rewrites() {
    return [{ source: '/api-proxy/:path*', destination: `${API_BASE_URL}/api/v1/:path*` }];
  },
};

export default nextConfig;
