'use client';

// Task-page error boundary: same stale-deploy auto-recovery as the root
// boundary (a click on a page rendered by a previous deploy fails with
// "Server Action ... was not found" — a reload fixes it). One shared
// implementation lives in app/error.tsx.
export { default } from '../../error';
