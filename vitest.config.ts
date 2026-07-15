import { defaultExclude, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    // Never collect test-file copies from build output: the Next.js
    // standalone bundle (apps/dashboard/.next/standalone) embeds apps/api
    // sources, and its tsconfig cannot resolve outside the bundle.
    exclude: [...defaultExclude, '**/.next/**'],
  },
});
