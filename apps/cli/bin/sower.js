#!/usr/bin/env node
// Thin launcher: register tsx's ESM loader, then run the TypeScript entry
// directly — the same no-build tsx runtime every other app in this repo
// uses. Node resolves this file's real path through pnpm's bin symlink, so
// the relative import lands on apps/cli/src/main.ts.
import { register } from 'tsx/esm/api';

register();
await import('../src/main.ts');
