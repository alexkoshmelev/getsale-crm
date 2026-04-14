/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  output: 'standalone',
  // Monorepo: two lockfiles (root + frontend); trace files from repo root so standalone output is correct
  outputFileTracingRoot: path.join(__dirname, '..'),
  reactStrictMode: true,
  // Next.js 16: Turbopack is default for dev; we keep webpack for build (form-data alias). Empty config silences the warning.
  turbopack: {},
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000',
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3004',
  },
  // Alias form-data to stub on server so axios doesn't pull in broken es-set-tostringtag in Docker
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.resolve.alias = config.resolve.alias || {};
      config.resolve.alias['form-data'] = path.join(__dirname, 'lib', 'stub-form-data.js');
    }
    return config;
  },
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
  async rewrites() {
    // Prefer API_URL at build (Docker: http://api-gateway:8000) so /api/* proxies inside the stack, not cross-origin to api-crm.
    const apiUrl = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
    return [
      {
        source: '/api/:path*',
        destination: `${apiUrl}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;

