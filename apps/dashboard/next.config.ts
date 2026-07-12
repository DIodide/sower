import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Resume/cover-letter uploads flow through Server Actions; the default 1 MB
  // body cap would reject real resumes, and the upload form advertises 15 MB.
  experimental: { serverActions: { bodySizeLimit: '15mb' } },
  // @sower/* packages are consumed as raw TypeScript source (internal-package
  // pattern), so Next must transpile them.
  transpilePackages: [
    '@sower/answers',
    '@sower/core',
    '@sower/db',
    '@sower/storage',
  ],
  // Node-only drivers stay external to the server bundle.
  serverExternalPackages: ['postgres', '@google-cloud/storage'],
  // @sower/* packages use NodeNext ESM imports ('./schema.js' -> schema.ts);
  // webpack needs to be told to try .ts for .js specifiers.
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.js'] };
    return config;
  },
};

export default nextConfig;
