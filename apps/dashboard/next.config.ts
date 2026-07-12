import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // @sower/db is consumed as raw TypeScript source (internal-package pattern),
  // so Next must transpile it.
  transpilePackages: ['@sower/db'],
  // postgres-js is a Node-only driver; keep it external to the server bundle.
  serverExternalPackages: ['postgres'],
  // @sower/* packages use NodeNext ESM imports ('./schema.js' -> schema.ts);
  // webpack needs to be told to try .ts for .js specifiers.
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.js'] };
    return config;
  },
};

export default nextConfig;
