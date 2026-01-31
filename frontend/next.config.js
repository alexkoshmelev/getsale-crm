/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  reactStrictMode: true,
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
  async rewrites() {
    // Use API_URL for server-side (Docker service hostname) or NEXT_PUBLIC_API_URL for client-side (localhost)
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

