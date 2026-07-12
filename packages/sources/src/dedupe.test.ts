import type { PlatformRef } from '@sower/core';
import { describe, expect, it } from 'vitest';
import { computeDedupeKey } from './dedupe.js';

describe('computeDedupeKey', () => {
  it('yields identical keys for boards vs job-boards hosts of the same job', () => {
    // detectPlatform resolves both greenhouse hosts to the same ref; only the
    // canonical URLs differ, and they must not leak into the key.
    const ref: PlatformRef = {
      platform: 'greenhouse',
      tenant: 'acme',
      externalId: '4011',
    };

    const fromBoards = computeDedupeKey(
      ref,
      'https://boards.greenhouse.io/acme/jobs/4011',
    );
    const fromJobBoards = computeDedupeKey(
      ref,
      'https://job-boards.greenhouse.io/acme/jobs/4011',
    );

    expect(fromBoards).toBe('greenhouse:acme:4011');
    expect(fromJobBoards).toBe(fromBoards);
  });

  it('uses platform:tenant:externalId when all three are present', () => {
    const ref: PlatformRef = {
      platform: 'lever',
      tenant: 'plaid',
      externalId: 'abc-123',
    };
    expect(computeDedupeKey(ref, 'https://jobs.lever.co/plaid/abc-123')).toBe(
      'lever:plaid:abc-123',
    );
  });

  it('uses platform:jid:externalId when the tenant is unknown', () => {
    const ref: PlatformRef = {
      platform: 'greenhouse',
      tenant: null,
      externalId: '4011',
    };
    expect(computeDedupeKey(ref, 'https://example.com/x')).toBe(
      'greenhouse:jid:4011',
    );
  });

  it('falls back to the canonical URL without an externalId', () => {
    const ref: PlatformRef = {
      platform: 'greenhouse',
      tenant: 'acme',
      externalId: null,
    };
    expect(computeDedupeKey(ref, 'https://boards.greenhouse.io/acme')).toBe(
      'https://boards.greenhouse.io/acme',
    );
  });

  it('falls back to the canonical URL for unknown platforms', () => {
    const ref: PlatformRef = {
      platform: 'unknown',
      tenant: null,
      externalId: null,
    };
    expect(computeDedupeKey(ref, 'https://careers.example.com/j/1')).toBe(
      'https://careers.example.com/j/1',
    );
  });
});
