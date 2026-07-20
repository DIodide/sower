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

// Per-URL platform detection (default: unknown, like the real detector).
const platformState = vi.hoisted(() => ({
  byUrl: {} as Record<
    string,
    { platform: string; tenant: string | null; externalId: string | null }
  >,
}));

const ingestState = vi.hoisted(() => ({
  /** URLs already ingested (ingestJob reports them as duplicates). */
  known: new Set<string>(),
  /** URLs whose ingest parks NEEDS_INPUT (unknown/tenant-less platforms). */
  parked: new Set<string>(),
  calls: [] as string[],
}));

/** Task ids triggerInvestigation was asked to investigate, in order. */
const investigateState = vi.hoisted(() => ({
  calls: [] as string[],
  /** What the mocked trigger reports back (false = gated/failed). */
  fired: true,
}));

vi.mock('@sower/platforms', () => ({
  detectPlatform: (url: string) =>
    platformState.byUrl[url] ?? {
      platform: 'unknown',
      tenant: null,
      externalId: null,
    },
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
    if (ingestState.known.has(input.url)) {
      return {
        duplicate: true,
        jobId: 'dup',
        taskId: 'task-dup',
        originalSource: 'vanshb03',
        originalCreatedAt: new Date('2026-07-01T12:00:00Z'),
      };
    }
    return ingestState.parked.has(input.url)
      ? {
          duplicate: false,
          jobId: `job:${input.url}`,
          taskId: `task:${input.url}`,
          state: 'NEEDS_INPUT',
        }
      : {
          duplicate: false,
          jobId: `job:${input.url}`,
          taskId: `task:${input.url}`,
          state: 'QUEUED',
        };
  }),
}));

// The trigger itself is proven in investigate-trigger.test.ts; the poll only
// needs its taskId ordering + fired count (it never throws).
vi.mock('./investigate-trigger.js', () => ({
  triggerInvestigation: vi.fn(async (_deps: unknown, taskId: string) => {
    investigateState.calls.push(taskId);
    return investigateState.fired;
  }),
}));

const config = {
  SIMPLIFY_TERMS: 'Summer 2027',
  SIMPLIFY_MAX_PER_RUN: 10,
  SOURCE_INVESTIGATE_PER_RUN: 5,
  SCREENSHOT_INVESTIGATION_ENABLED: false,
} as unknown as Config;

/**
 * Fake db serving, in call order: the known-canonical-URL pre-filter select,
 * then (only when the drip has leftover budget) the parked-backlog select.
 * The backlog query's notExists subquery builds a third select that is never
 * awaited (it defaults to []). ingestion_runs inserts are captured in `runs`.
 */
function fakeDb(opts: { knownUrls?: string[]; backlog?: string[] } = {}) {
  const runs: Record<string, unknown>[] = [];
  const selectResults: unknown[][] = [
    (opts.knownUrls ?? []).map((canonicalUrl) => ({ canonicalUrl })),
    (opts.backlog ?? []).map((taskId) => ({ taskId })),
  ];
  let selectCalls = 0;
  const chain = (result: unknown) => {
    const self = {
      from: () => self,
      where: () => self,
      limit: () => self,
      innerJoin: () => self,
      orderBy: () => self,
      // biome-ignore lint/suspicious/noThenProperty: intentionally thenable to mimic drizzle's awaitable query builder
      then: (onFulfilled: (value: unknown) => unknown) =>
        Promise.resolve(result).then(onFulfilled),
    };
    return self;
  };
  const db = {
    select: () => {
      selectCalls += 1;
      return chain(selectResults.shift() ?? []);
    },
    insert: (table: unknown) => ({
      values: async (row: Record<string, unknown>) => {
        if (table === ingestionRuns) runs.push(row);
        return [];
      },
    }),
  };
  return {
    db: db as unknown as Deps['db'],
    runs,
    selectCallCount: () => selectCalls,
  };
}

/** A Summer-active raw listing (vanshb03 schema). */
function rawListing(url: string, company: string) {
  return { url, company_name: company, title: 'SWE', season: 'Summer' };
}

beforeEach(() => {
  listingsState.raw = [];
  listingsState.throwError = null;
  platformState.byUrl = {};
  ingestState.known = new Set();
  ingestState.parked = new Set();
  ingestState.calls = [];
  investigateState.calls = [];
  investigateState.fired = true;
});

describe('runIngestionPoll', () => {
  it('ingests EVERY filtered listing: supported platforms queue, unknown/tenant-less ones park — nothing is dropped', async () => {
    listingsState.raw = [
      rawListing('https://gh/x', 'A'),
      rawListing('https://ashby/x', 'B'),
      rawListing('https://lever/x', 'C'),
      rawListing('https://wd/x', 'D'),
      // supported platform but NO tenant (gh_jid custom domain) -> ingested;
      // ingestJob's probe fails here, so it parks (still recorded).
      rawListing('https://ghjid/x', 'E'),
      // unsupported platform -> ingested + parked (was silently skipped).
      rawListing('https://icims/x', 'F'),
      // unknown platform -> ingested + parked.
      rawListing('https://careers.example.com/x', 'G'),
      // wrong term -> filtered out before anything else.
      {
        url: 'https://gh/old',
        company_name: 'H',
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
      // careers.example.com falls through to the unknown default.
    };
    ingestState.parked = new Set([
      'https://ghjid/x',
      'https://icims/x',
      'https://careers.example.com/x',
    ]);

    const { db, runs } = fakeDb();
    const result = await runIngestionPoll({ db, config } as Deps);

    expect(result.fetched).toBe(8);
    expect(result.filtered).toBe(7); // wrong-term one filtered out
    expect(result.fresh).toBe(7);
    expect(result.ingested).toBe(4); // gh/ashby/lever/wd queued
    expect(result.parked).toBe(3); // ghjid + icims + unknown recorded, parked
    expect(result.duplicates).toBe(0);
    expect(result.capDeferred).toBe(0);
    expect(result.byPlatform).toEqual({
      greenhouse: 2,
      ashby: 1,
      lever: 1,
      workday: 1,
      icims: 1,
      unknown: 1,
    });
    // EVERY filtered listing was handed to ingestJob — no platform gate.
    expect(ingestState.calls.sort()).toEqual([
      'https://ashby/x',
      'https://careers.example.com/x',
      'https://gh/x',
      'https://ghjid/x',
      'https://icims/x',
      'https://lever/x',
      'https://wd/x',
    ]);

    // Exactly one run row recorded: legacy int columns stay sensible
    // (matched = fresh, ingested = queued + parked, skipped = capDeferred)
    // and the jsonb by_platform carries the full funnel breakdown.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      scanned: 7,
      matched: 7,
      ingested: 7,
      duplicates: 0,
      skipped: 0,
      ok: true,
      error: null,
      terms: ['Summer 2027'],
      sources: ['vanshb03'],
      byPlatform: {
        greenhouse: 2,
        ashby: 1,
        lever: 1,
        workday: 1,
        icims: 1,
        unknown: 1,
        funnel: {
          fetched: 8,
          filtered: 7,
          fresh: 7,
          ingested: 4,
          parked: 3,
          duplicates: 0,
          investigationsTriggered: 0,
          capDeferred: 0,
        },
      },
    });
    expect(typeof runs[0]?.durationMs).toBe('number');
  });

  it('counts duplicates and defers fresh listings beyond SIMPLIFY_MAX_PER_RUN as capDeferred', async () => {
    listingsState.raw = [
      rawListing('https://gh/1', 'A'),
      rawListing('https://gh/2', 'B'),
      rawListing('https://gh/3', 'C'),
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

    // 3 fresh candidates but only 2 attempted (the cap); of those, 1 dup +
    // 1 new; the third is visible as capDeferred, not lost.
    expect(result.fresh).toBe(3);
    expect(ingestState.calls).toHaveLength(2);
    expect(result.duplicates).toBe(1);
    expect(result.ingested).toBe(1);
    expect(result.capDeferred).toBe(1);
    expect(runs[0]).toMatchObject({
      matched: 3,
      ingested: 1,
      duplicates: 1,
      skipped: 1,
    });
    expect(runs[0]?.byPlatform).toMatchObject({
      funnel: { fresh: 3, ingested: 1, duplicates: 1, capDeferred: 1 },
    });
  });

  it('pre-skips candidates already in the jobs table so the cap covers fresh ones', async () => {
    listingsState.raw = [
      rawListing('https://gh/1', 'A'),
      rawListing('https://gh/2', 'B'),
      rawListing('https://gh/3', 'C'),
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
    const { db, runs } = fakeDb({
      knownUrls: ['https://gh/1', 'https://gh/2'],
    });
    const result = await runIngestionPoll({ db, config: cappedConfig } as Deps);

    expect(ingestState.calls).toEqual(['https://gh/3']);
    expect(result.filtered).toBe(3);
    expect(result.fresh).toBe(1);
    expect(result.ingested).toBe(1);
    expect(result.duplicates).toBe(0);
    expect(result.capDeferred).toBe(0);
    expect(runs[0]).toMatchObject({ scanned: 3, matched: 1, ingested: 1 });
  });

  describe('investigation drip', () => {
    const dripConfig = {
      ...config,
      SCREENSHOT_INVESTIGATION_ENABLED: true,
    } as unknown as Config;

    /** N fresh unknown-platform listings that all ingest + park. */
    function seedUnknownParks(n: number) {
      listingsState.raw = Array.from({ length: n }, (_, i) =>
        rawListing(`https://unknown/${i}`, `U${i}`),
      );
      ingestState.parked = new Set(listingsState.raw.map((l) => l.url));
    }

    it("triggers at most SOURCE_INVESTIGATE_PER_RUN of this run's fresh parks, in file order; the rest park quietly", async () => {
      seedUnknownParks(7);

      const { db, runs, selectCallCount } = fakeDb();
      const result = await runIngestionPoll({ db, config: dripConfig } as Deps);

      expect(result.parked).toBe(7);
      expect(investigateState.calls).toEqual([
        'task:https://unknown/0',
        'task:https://unknown/1',
        'task:https://unknown/2',
        'task:https://unknown/3',
        'task:https://unknown/4',
      ]);
      expect(result.investigationsTriggered).toBe(5);
      // Budget exhausted by fresh parks: the backlog query never runs
      // (1 select = the known-canonical pre-filter only).
      expect(selectCallCount()).toBe(1);
      expect(runs[0]?.byPlatform).toMatchObject({
        funnel: { parked: 7, investigationsTriggered: 5 },
      });
    });

    it('spends leftover budget on the oldest never-investigated parked backlog', async () => {
      seedUnknownParks(2);

      const { db, runs } = fakeDb({
        backlog: ['backlog-1', 'backlog-2', 'backlog-3'],
      });
      const result = await runIngestionPoll({ db, config: dripConfig } as Deps);

      // Fresh first (file order), then the backlog fills the remainder.
      expect(investigateState.calls).toEqual([
        'task:https://unknown/0',
        'task:https://unknown/1',
        'backlog-1',
        'backlog-2',
        'backlog-3',
      ]);
      expect(result.investigationsTriggered).toBe(5);
      expect(runs[0]?.byPlatform).toMatchObject({
        funnel: { parked: 2, investigationsTriggered: 5 },
      });
    });

    it('only unknown-platform parks join the drip (a parked tenant-less greenhouse waits for manual triage)', async () => {
      listingsState.raw = [
        rawListing('https://ghjid/x', 'E'),
        rawListing('https://unknown/x', 'U'),
      ];
      platformState.byUrl['https://ghjid/x'] = {
        platform: 'greenhouse',
        tenant: null,
        externalId: '5',
      };
      ingestState.parked = new Set(['https://ghjid/x', 'https://unknown/x']);

      const { db } = fakeDb();
      const result = await runIngestionPoll({ db, config: dripConfig } as Deps);

      expect(result.parked).toBe(2);
      // Fresh drip covers only the unknown one; the (empty) backlog query
      // spends the leftover budget.
      expect(investigateState.calls).toEqual(['task:https://unknown/x']);
      expect(result.investigationsTriggered).toBe(1);
    });

    it('is fully dormant when SCREENSHOT_INVESTIGATION_ENABLED is off: no triggers, no backlog query', async () => {
      seedUnknownParks(3);

      const { db, runs, selectCallCount } = fakeDb({
        backlog: ['backlog-1'],
      });
      const result = await runIngestionPoll({ db, config } as Deps);

      expect(result.parked).toBe(3); // still ingested + parked
      expect(investigateState.calls).toEqual([]);
      expect(result.investigationsTriggered).toBe(0);
      expect(selectCallCount()).toBe(1); // known-URL pre-filter only
      expect(runs[0]?.byPlatform).toMatchObject({
        funnel: { parked: 3, investigationsTriggered: 0 },
      });
    });

    it('is fully dormant when SOURCE_INVESTIGATE_PER_RUN is 0', async () => {
      seedUnknownParks(2);
      const zeroBudget = {
        ...dripConfig,
        SOURCE_INVESTIGATE_PER_RUN: 0,
      } as unknown as Config;

      const { db, selectCallCount } = fakeDb();
      const result = await runIngestionPoll({ db, config: zeroBudget } as Deps);

      expect(investigateState.calls).toEqual([]);
      expect(result.investigationsTriggered).toBe(0);
      expect(selectCallCount()).toBe(1);
    });

    it('records only investigations that actually fired', async () => {
      seedUnknownParks(2);
      investigateState.fired = false; // e.g. GCP project/region unset

      const { db, runs } = fakeDb();
      const result = await runIngestionPoll({ db, config: dripConfig } as Deps);

      expect(investigateState.calls).toHaveLength(2);
      expect(result.investigationsTriggered).toBe(0);
      expect(runs[0]?.byPlatform).toMatchObject({
        funnel: { investigationsTriggered: 0 },
      });
    });
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
      scanned: 0,
      matched: 0,
      ingested: 0,
      skipped: 0,
    });
    expect(runs[0]?.byPlatform).toEqual({
      funnel: {
        fetched: 0,
        filtered: 0,
        fresh: 0,
        ingested: 0,
        parked: 0,
        duplicates: 0,
        investigationsTriggered: 0,
        capDeferred: 0,
      },
    });
  });
});
