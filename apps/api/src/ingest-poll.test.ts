import { ingestionRuns } from '@sower/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { runIngestionPoll } from './ingest-poll.js';
import type { Deps } from './types.js';

// Raw listings the mocked fetchListings normalizes (real normalizeListing).
const listingsState = vi.hoisted(() => ({
  raw: [] as Array<{
    url: string;
    company_name: string;
    title: string;
    season?: string;
    terms?: string[];
  }>,
  /** When set, fetchListings rejects with this message (source-down case). */
  throwError: null as string | null,
}));

// Per-URL platform detection + which platforms have an adapter.
const platformState = vi.hoisted(() => ({
  byUrl: {} as Record<
    string,
    { platform: string; tenant: string | null; externalId: string | null }
  >,
  adapters: new Set<string>(),
}));

const ingestState = vi.hoisted(() => ({
  /** URLs already ingested (ingestJob reports them as duplicates). */
  known: new Set<string>(),
  calls: [] as string[],
}));

vi.mock('@sower/platforms', () => ({
  detectPlatform: (url: string) =>
    platformState.byUrl[url] ?? {
      platform: 'unknown',
      tenant: null,
      externalId: null,
    },
  getAdapter: (platform: string) =>
    platformState.adapters.has(platform)
      ? { discover: async () => ({}) }
      : null,
}));

vi.mock('@sower/sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sower/sources')>();
  return {
    ...actual,
    // A distinctive single source so the recorded run's `sources` is checkable.
    SOURCES: [{ name: 'vanshb03', url: 'https://example/listings.json' }],
    fetchListings: vi.fn(async () => {
      if (listingsState.throwError) {
        throw new Error(listingsState.throwError);
      }
      return listingsState.raw.map((raw) =>
        actual.normalizeListing(raw, 'vanshb03'),
      );
    }),
  };
});

vi.mock('./ingest.js', () => ({
  ingestJob: vi.fn(async (_deps: unknown, input: { url: string }) => {
    ingestState.calls.push(input.url);
    return ingestState.known.has(input.url)
      ? { duplicate: true, jobId: 'dup' }
      : { duplicate: false, jobId: 'j', taskId: 't', state: 'QUEUED' };
  }),
}));

const config = {
  SIMPLIFY_TERMS: 'Summer 2027',
  SIMPLIFY_MAX_PER_RUN: 10,
} as unknown as Config;

/**
 * Fake db that captures ingestion_runs inserts and serves the "already
 * ingested" canonical-URL pre-filter select (configurable via knownUrls).
 */
function fakeDb(knownUrls: string[] = []) {
  const runs: Record<string, unknown>[] = [];
  const db = {
    select: () => ({
      from: async () => knownUrls.map((canonicalUrl) => ({ canonicalUrl })),
    }),
    insert: (table: unknown) => ({
      values: async (row: Record<string, unknown>) => {
        if (table === ingestionRuns) runs.push(row);
        return [];
      },
    }),
  };
  return { db: db as unknown as Deps['db'], runs };
}

beforeEach(() => {
  listingsState.raw = [];
  listingsState.throwError = null;
  platformState.byUrl = {};
  platformState.adapters = new Set(['greenhouse', 'ashby', 'lever', 'workday']);
  ingestState.known = new Set();
  ingestState.calls = [];
});

describe('runIngestionPoll', () => {
  it('auto-ingests every supported platform with a tenant, skips the rest', async () => {
    listingsState.raw = [
      {
        url: 'https://gh/x',
        company_name: 'A',
        title: 'SWE',
        season: 'Summer',
      },
      {
        url: 'https://ashby/x',
        company_name: 'B',
        title: 'SWE',
        season: 'Summer',
      },
      {
        url: 'https://lever/x',
        company_name: 'C',
        title: 'SWE',
        season: 'Summer',
      },
      {
        url: 'https://wd/x',
        company_name: 'D',
        title: 'SWE',
        season: 'Summer',
      },
      // supported platform but NO tenant (gh_jid) -> skipped.
      {
        url: 'https://ghjid/x',
        company_name: 'E',
        title: 'SWE',
        season: 'Summer',
      },
      // unsupported platform -> skipped.
      {
        url: 'https://icims/x',
        company_name: 'F',
        title: 'SWE',
        season: 'Summer',
      },
      // wrong term -> filtered out before platform matching.
      {
        url: 'https://gh/old',
        company_name: 'G',
        title: 'SWE',
        terms: ['Fall 2028'],
      },
    ];
    platformState.byUrl = {
      'https://gh/x': { platform: 'greenhouse', tenant: 'a', externalId: '1' },
      'https://ashby/x': { platform: 'ashby', tenant: 'b', externalId: '2' },
      'https://lever/x': { platform: 'lever', tenant: 'c', externalId: '3' },
      'https://wd/x': { platform: 'workday', tenant: 'd', externalId: '4' },
      'https://ghjid/x': {
        platform: 'greenhouse',
        tenant: null,
        externalId: '5',
      },
      'https://icims/x': { platform: 'icims', tenant: 'f', externalId: '6' },
    };

    const { db, runs } = fakeDb();
    const result = await runIngestionPoll({ db, config } as Deps);

    expect(result.scanned).toBe(6); // wrong-term one filtered out
    expect(result.matched).toBe(4); // gh/ashby/lever/wd with tenant
    expect(result.ingested).toBe(4);
    expect(result.duplicates).toBe(0);
    expect(result.skipped).toBe(2); // no-tenant greenhouse + unsupported icims
    expect(result.byPlatform).toEqual({
      greenhouse: 2,
      ashby: 1,
      lever: 1,
      workday: 1,
      icims: 1,
    });
    // All four supported+tenant listings were handed to ingestJob.
    expect(ingestState.calls.sort()).toEqual([
      'https://ashby/x',
      'https://gh/x',
      'https://lever/x',
      'https://wd/x',
    ]);

    // Exactly one run row recorded, ok, with the funnel + sources + terms.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      scanned: 6,
      matched: 4,
      ingested: 4,
      duplicates: 0,
      skipped: 2,
      ok: true,
      error: null,
      terms: ['Summer 2027'],
      sources: ['vanshb03'],
    });
    expect(typeof runs[0]?.durationMs).toBe('number');
  });

  it('counts duplicates and respects SIMPLIFY_MAX_PER_RUN', async () => {
    listingsState.raw = [
      {
        url: 'https://gh/1',
        company_name: 'A',
        title: 'SWE',
        season: 'Summer',
      },
      {
        url: 'https://gh/2',
        company_name: 'B',
        title: 'SWE',
        season: 'Summer',
      },
      {
        url: 'https://gh/3',
        company_name: 'C',
        title: 'SWE',
        season: 'Summer',
      },
    ];
    for (const [i, l] of listingsState.raw.entries()) {
      platformState.byUrl[l.url] = {
        platform: 'greenhouse',
        tenant: 'a',
        externalId: String(i),
      };
    }
    ingestState.known = new Set(['https://gh/1']); // first is a dup
    const cappedConfig = {
      ...config,
      SIMPLIFY_MAX_PER_RUN: 2,
    } as unknown as Config;

    const { db, runs } = fakeDb();
    const result = await runIngestionPoll({ db, config: cappedConfig } as Deps);

    // matched=3 candidates but only 2 attempted (the cap); of those, 1 dup + 1 new.
    expect(result.matched).toBe(3);
    expect(ingestState.calls).toHaveLength(2);
    expect(result.duplicates).toBe(1);
    expect(result.ingested).toBe(1);
    expect(runs[0]).toMatchObject({ matched: 3, ingested: 1, duplicates: 1 });
  });

  it('pre-skips candidates already in the jobs table so the cap covers fresh ones', async () => {
    listingsState.raw = [
      {
        url: 'https://gh/1',
        company_name: 'A',
        title: 'SWE',
        season: 'Summer',
      },
      {
        url: 'https://gh/2',
        company_name: 'B',
        title: 'SWE',
        season: 'Summer',
      },
      {
        url: 'https://gh/3',
        company_name: 'C',
        title: 'SWE',
        season: 'Summer',
      },
    ];
    for (const [i, l] of listingsState.raw.entries()) {
      platformState.byUrl[l.url] = {
        platform: 'greenhouse',
        tenant: 'a',
        externalId: String(i),
      };
    }
    // gh/1 + gh/2 are already ingested (in jobs) — even though they're the
    // newest, they're pre-skipped so the cap covers the still-fresh gh/3.
    // Without this the newest-N cap would re-attempt gh/1+gh/2 forever and
    // gh/3 would never ingest.
    const cappedConfig = {
      ...config,
      SIMPLIFY_MAX_PER_RUN: 2,
    } as unknown as Config;
    const { db, runs } = fakeDb(['https://gh/1', 'https://gh/2']);
    const result = await runIngestionPoll({ db, config: cappedConfig } as Deps);

    expect(ingestState.calls).toEqual(['https://gh/3']);
    expect(result.matched).toBe(3); // matched still counts all auto-ingestable
    expect(result.ingested).toBe(1);
    expect(result.duplicates).toBe(0);
    expect(runs[0]).toMatchObject({ matched: 3, ingested: 1 });
  });

  it('records a failed run and rethrows when the source fetch throws', async () => {
    listingsState.throwError = 'github 503';

    const { db, runs } = fakeDb();
    await expect(runIngestionPoll({ db, config } as Deps)).rejects.toThrow(
      /github 503/,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      ok: false,
      error: 'github 503',
      matched: 0,
    });
  });
});
