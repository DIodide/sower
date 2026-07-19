import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import type { MessageIngestSummary, UrlOutcome } from './discord-ingest.js';
import {
  announcedTaskIds,
  formatEasternDate,
  ingestMessageLinks,
  reactionFor,
  replyFor,
  runDiscordIngestPoll,
  taskLabel,
} from './discord-ingest.js';
import type { Deps } from './types.js';

/** replyFor stamps fresh outcomes with the CURRENT ET date (ingest = now). */
const TODAY = formatEasternDate(new Date());

const CDN_URL = 'https://cdn.discordapp.com/attachments/1/2/shot.png';

const IMAGE_ATTACHMENT = {
  id: 'att-1',
  filename: 'shot.png',
  content_type: 'image/png',
  url: CDN_URL,
  size: 3,
};

const platformState = vi.hoisted(() => ({
  byUrl: {} as Record<
    string,
    { platform: string; tenant: string | null; externalId: string | null }
  >,
  adapters: new Set<string>(),
  /** resolveUrl mock: redirect map (input → final URL) + call log. */
  resolveTo: {} as Record<string, string>,
  resolveCalls: [] as string[],
}));
const ingestState = vi.hoisted(() => ({
  known: new Set<string>(),
  calls: [] as string[],
  /** jobs.source each ingestJob call carried (source-threading assertions). */
  sources: [] as string[],
  duplicateMeta: {
    taskId: 'task-dup' as string | null,
    originalSource: 'discord',
    originalCreatedAt: new Date('2026-07-13T19:47:00Z'),
  },
}));
const dirState = vi.hoisted(() => ({ byUrl: {} as Record<string, string[]> }));
/** Raw page HTML the mocked fetchPageHtml serves (the REAL sniff runs on it). */
const pageState = vi.hoisted(() => ({ byUrl: {} as Record<string, string> }));
const triggerState = vi.hoisted(() => ({
  calls: [] as string[],
  /** What the mocked trigger reports back (true = investigation fired). */
  fires: false,
}));
/** Verified greenhouse tenant probe: what it reports + how it was called. */
const probeState = vi.hoisted(() => ({
  tenant: null as string | null,
  calls: [] as Array<{ url: string; jobId: string }>,
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
  resolveUrl: async (url: string) => {
    platformState.resolveCalls.push(url);
    return platformState.resolveTo[url] ?? url;
  },
  // Verified tenant probe (unit-tested in @sower/platforms); null = miss.
  deriveGreenhouseTenant: async (url: string, jobId: string) => {
    probeState.calls.push({ url, jobId });
    return probeState.tenant;
  },
}));

vi.mock('./ingest.js', () => ({
  ingestJob: vi.fn(
    async (_deps: unknown, input: { url: string; source?: string }) => {
      ingestState.calls.push(input.url);
      ingestState.sources.push(input.source ?? '');
      return ingestState.known.has(input.url)
        ? { duplicate: true, jobId: 'dup', ...ingestState.duplicateMeta }
        : {
            duplicate: false,
            jobId: 'job-1',
            taskId: 'task-1',
            state: 'QUEUED',
          };
    },
  ),
}));

// Tier-2 form-discovery trigger: recorded so tests can assert exactly which
// parked tasks fire an investigator Job (the real one self-gates + never throws).
vi.mock('./investigate-trigger.js', () => ({
  triggerInvestigation: vi.fn(async (_deps: unknown, taskId: string) => {
    triggerState.calls.push(taskId);
    return triggerState.fires;
  }),
}));

// Keep the real pure helpers (extractUrlsFromText, sniffGreenhouseJob, …);
// only the network fetch and the link filter (fed by dirState) are stubbed.
vi.mock('./link-extract.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./link-extract.js')>()),
  fetchPageHtml: vi.fn(async (url: string) => {
    const html = pageState.byUrl[url];
    if (html !== undefined) {
      return { html, url };
    }
    // Directory fixtures configure links without HTML: serve a blank page so
    // classify proceeds to (the mocked) extractJobLinks. No fixture → no page.
    return dirState.byUrl[url] ? { html: '', url } : null;
  }),
  extractJobLinks: vi.fn(
    (_html: string, url: string) => dirState.byUrl[url] ?? [],
  ),
}));

// Screenshot ingest vaults image bytes; never touch the real vault in tests.
vi.mock('@sower/storage', () => ({
  createStorage: () => ({ put: vi.fn(async () => {}) }),
}));

// The poll re-renders the reply after storing the message id (race fix); stub
// it here so the poll tests don't drive the real DB-backed renderer.
vi.mock('./ingest-reply.js', () => ({
  refreshIngestReply: vi.fn(async () => {}),
}));

beforeEach(() => {
  platformState.byUrl = {};
  platformState.adapters = new Set(['greenhouse', 'ashby', 'lever', 'workday']);
  platformState.resolveTo = {};
  platformState.resolveCalls = [];
  pageState.byUrl = {};
  ingestState.known = new Set();
  ingestState.calls = [];
  ingestState.sources = [];
  ingestState.duplicateMeta = {
    taskId: 'task-dup',
    originalSource: 'discord',
    originalCreatedAt: new Date('2026-07-13T19:47:00Z'),
  };
  dirState.byUrl = {};
  triggerState.calls = [];
  triggerState.fires = false;
  probeState.tenant = null;
  probeState.calls = [];
});

describe('ingestMessageLinks', () => {
  it('ingests a supported direct link', async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'acme',
      externalId: '1',
    };
    const s = await ingestMessageLinks({} as Deps, 'apply: https://gh/1');
    expect(s.ingested).toBe(1);
    expect(s.outcomes[0]).toMatchObject({
      kind: 'ingested',
      platform: 'greenhouse',
    });
    expect(ingestState.calls).toEqual(['https://gh/1']);
  });

  it("stamps jobs.source 'discord' by default (existing call sites unchanged)", async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'acme',
      externalId: '1',
    };
    // One supported + one unsupported (record+park) — both carry 'discord'.
    await ingestMessageLinks({} as Deps, 'https://gh/1 https://weirdats/x');
    expect(ingestState.sources).toEqual(['discord', 'discord']);
  });

  it('threads a source override to every ingestJob call, directory children included', async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'acme',
      externalId: '1',
    };
    platformState.byUrl['https://dir/list'] = {
      platform: 'unknown',
      tenant: null,
      externalId: null,
    };
    platformState.byUrl['https://gh/2'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '2',
    };
    // Directory expands to a supported child + an unknown child (parked).
    dirState.byUrl['https://dir/list'] = [
      'https://gh/2',
      'https://weird/child',
    ];
    const s = await ingestMessageLinks(
      {} as Deps,
      'https://gh/1 https://dir/list',
      'manual',
    );
    expect(s).toMatchObject({ ingested: 2, unsupported: 1, directories: 1 });
    expect(ingestState.sources).toEqual(['manual', 'manual', 'manual']);
  });

  it('records an unsupported direct link (parked, never dropped) and triggers form discovery', async () => {
    platformState.byUrl['https://weirdats/x'] = {
      platform: 'unknown',
      tenant: null,
      externalId: null,
    };
    const s = await ingestMessageLinks({} as Deps, 'https://weirdats/x');
    expect(s.unsupported).toBe(1);
    // The gated-off trigger reports not-fired: the outcome stays "recorded".
    expect(s.outcomes[0]).toMatchObject({
      kind: 'unsupported',
      investigating: false,
    });
    // still routed through ingestJob (which records + parks the unknown job)
    expect(ingestState.calls).toEqual(['https://weirdats/x']);
    // a directly-sent (depth-0) unsupported link fires the investigator Job
    expect(triggerState.calls).toEqual(['task-1']);
  });

  it('marks an unsupported link investigating when the trigger reports fired', async () => {
    platformState.byUrl['https://weirdats/x'] = {
      platform: 'unknown',
      tenant: null,
      externalId: null,
    };
    triggerState.fires = true;
    const s = await ingestMessageLinks({} as Deps, 'https://weirdats/x');
    expect(s.outcomes[0]).toMatchObject({
      kind: 'unsupported',
      taskId: 'task-1',
      investigating: true,
    });
  });

  it('does NOT trigger form discovery for a supported link or a duplicate', async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '1',
    };
    platformState.byUrl['https://weirdats/dup'] = {
      platform: 'unknown',
      tenant: null,
      externalId: null,
    };
    ingestState.known = new Set(['https://weirdats/dup']); // already parked
    const s = await ingestMessageLinks(
      {} as Deps,
      'https://gh/1 https://weirdats/dup',
    );
    expect(s).toMatchObject({ ingested: 1, duplicates: 1 });
    // Neither the queued job nor the already-known unsupported one re-fires.
    expect(triggerState.calls).toEqual([]);
  });

  it("does NOT trigger form discovery for a directory's unsupported children", async () => {
    platformState.byUrl['https://dir/list'] = {
      platform: 'unknown',
      tenant: null,
      externalId: null,
    };
    platformState.byUrl['https://gh/2'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '2',
    };
    // https://weird/child stays unknown (the byUrl fallback) and has no links
    // of its own, so at depth 1 it is recorded+parked — but never triggered.
    dirState.byUrl['https://dir/list'] = [
      'https://gh/2',
      'https://weird/child',
    ];

    const s = await ingestMessageLinks({} as Deps, 'board: https://dir/list');
    expect(s.directories).toBe(1);
    expect(s.ingested).toBe(1);
    expect(s.unsupported).toBe(1);
    // A 50-link directory must not spawn 50 browser Jobs: no trigger at depth 1.
    expect(triggerState.calls).toEqual([]);
  });

  it('expands a directory page into its supported job links', async () => {
    platformState.byUrl['https://dir/list'] = {
      platform: 'unknown',
      tenant: null,
      externalId: null,
    };
    platformState.byUrl['https://gh/2'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '2',
    };
    platformState.byUrl['https://ashby/3'] = {
      platform: 'ashby',
      tenant: 'b',
      externalId: '3',
    };
    dirState.byUrl['https://dir/list'] = ['https://gh/2', 'https://ashby/3'];

    const s = await ingestMessageLinks({} as Deps, 'board: https://dir/list');
    expect(s.directories).toBe(1);
    expect(s.ingested).toBe(2);
    // the directory URL itself is NOT ingested; only its children are
    expect(ingestState.calls.sort()).toEqual([
      'https://ashby/3',
      'https://gh/2',
    ]);
    expect(s.outcomes[0]).toMatchObject({ kind: 'directory' });
  });

  it('records (not queues) a workday url without a /job/ path', async () => {
    const url = 'https://caci.wd1.myworkdayjobs.com/External/login';
    platformState.byUrl[url] = {
      platform: 'workday',
      tenant: 'caci',
      externalId: null,
    };
    const s = await ingestMessageLinks({} as Deps, `login page: ${url}`);
    expect(s.ingested).toBe(0);
    expect(s.unsupported).toBe(1);
    expect(s.outcomes[0]).toMatchObject({ kind: 'unsupported', url });
    // still recorded via ingestJob (parked), never dropped
    expect(ingestState.calls).toEqual([url]);
  });

  it('ingests a workday url with a /job/ path', async () => {
    const url = 'https://caci.wd1.myworkdayjobs.com/External/job/Jessup/SWE_1';
    platformState.byUrl[url] = {
      platform: 'workday',
      tenant: 'caci',
      externalId: null,
    };
    const s = await ingestMessageLinks({} as Deps, url);
    expect(s.ingested).toBe(1);
    expect(s.outcomes[0]).toMatchObject({
      kind: 'ingested',
      platform: 'workday',
      url,
    });
  });

  it('unwraps a redirect shim, then short-circuits without resolving', async () => {
    const target = 'https://boards.greenhouse.io/acme/jobs/77';
    platformState.byUrl[target] = {
      platform: 'greenhouse',
      tenant: 'acme',
      externalId: '77',
    };
    const shim = `https://l.instagram.com/?u=${encodeURIComponent(target)}`;
    const s = await ingestMessageLinks({} as Deps, `saw this: ${shim}`);
    expect(s.ingested).toBe(1);
    expect(s.outcomes[0]).toMatchObject({
      kind: 'ingested',
      platform: 'greenhouse',
      url: target,
    });
    expect(ingestState.calls).toEqual([target]);
    // The unwrapped target detects as supported → no resolve round-trip.
    expect(platformState.resolveCalls).toEqual([]);
  });

  it('ingests a supported URL WITHOUT resolving, so a custom-domain redirect cannot hide the platform', async () => {
    const gh = 'https://job-boards.greenhouse.io/stripe/jobs/7031337';
    platformState.byUrl[gh] = {
      platform: 'greenhouse',
      tenant: 'stripe',
      externalId: '7031337',
    };
    // If classify DID resolve, the redirect would land off-greenhouse and the
    // (unknown) stripe.com URL would be parked — the pre-resolve detect must
    // prevent resolveUrl from ever being called.
    platformState.resolveTo[gh] =
      'https://stripe.com/jobs/search?gh_jid=7031337';
    const s = await ingestMessageLinks({} as Deps, gh);
    expect(s.ingested).toBe(1);
    expect(s.outcomes[0]).toMatchObject({
      kind: 'ingested',
      platform: 'greenhouse',
      url: gh,
    });
    expect(ingestState.calls).toEqual([gh]);
    expect(platformState.resolveCalls).toEqual([]);
  });

  it('still resolves an unknown URL (shortener) before detecting', async () => {
    const short = 'https://t.co/abc123';
    const target = 'https://boards.greenhouse.io/acme/jobs/9';
    platformState.resolveTo[short] = target;
    platformState.byUrl[target] = {
      platform: 'greenhouse',
      tenant: 'acme',
      externalId: '9',
    };
    const s = await ingestMessageLinks({} as Deps, short);
    expect(platformState.resolveCalls).toEqual([short]);
    expect(s.ingested).toBe(1);
    expect(s.outcomes[0]).toMatchObject({
      kind: 'ingested',
      platform: 'greenhouse',
      url: target,
    });
  });

  it('sniffs a greenhouse embed out of a custom-domain page and ingests the canonical board URL', async () => {
    const url = 'https://acme-example.com/careers/senior-baker';
    // unknown pre- AND post-resolve (the byUrl fallback), so classify fetches
    // the page; the REAL sniffGreenhouseJob runs over this HTML.
    pageState.byUrl[url] =
      '<div id="grnhse_app"></div>' +
      '<script src="https://boards.greenhouse.io/embed/job_app?for=acme&amp;token=4001"></script>';
    const canonical = 'https://job-boards.greenhouse.io/acme/jobs/4001';
    const s = await ingestMessageLinks({} as Deps, url);
    expect(s.ingested).toBe(1);
    expect(s.outcomes[0]).toMatchObject({
      kind: 'ingested',
      platform: 'greenhouse',
      url: canonical,
    });
    expect(ingestState.calls).toEqual([canonical]);
  });

  it('dedupes a sniffed custom-domain page onto the existing canonical job', async () => {
    const url = 'https://acme-example.com/careers/senior-baker';
    pageState.byUrl[url] =
      '<a href="https://job-boards.greenhouse.io/acme/jobs/4001">Apply</a>';
    const canonical = 'https://job-boards.greenhouse.io/acme/jobs/4001';
    ingestState.known = new Set([canonical]);
    const s = await ingestMessageLinks({} as Deps, url);
    expect(s.duplicates).toBe(1);
    expect(s.outcomes[0]).toMatchObject({ kind: 'duplicate', url: canonical });
  });

  it('recovers a gh_jid stripped by the resolve redirect (sniffs with the original URL)', async () => {
    // Live-observed shape: stripe.com/jobs/search?gh_jid=N 302s to a slug URL
    // WITHOUT gh_jid. The page HTML only names the tenant (board root link),
    // so the job id must come from the ORIGINAL pasted URL.
    const pasted = 'https://acme-example.com/jobs/search?gh_jid=42';
    const stripped = 'https://acme-example.com/jobs/listing/senior-baker';
    platformState.resolveTo[pasted] = stripped;
    pageState.byUrl[stripped] =
      '<a href="https://boards.greenhouse.io/acme">our job board</a>';
    const s = await ingestMessageLinks({} as Deps, pasted);
    expect(s.ingested).toBe(1);
    expect(s.outcomes[0]).toMatchObject({
      kind: 'ingested',
      platform: 'greenhouse',
      url: 'https://job-boards.greenhouse.io/acme/jobs/42',
    });
  });

  it('records a custom-domain page with no greenhouse marker (sniff → null → park)', async () => {
    const url = 'https://acme-example.com/careers/senior-baker';
    pageState.byUrl[url] = '<html><body>join our team</body></html>';
    const s = await ingestMessageLinks({} as Deps, url);
    expect(s.unsupported).toBe(1);
    expect(ingestState.calls).toEqual([url]);
    // No gh_jid anywhere: the tenant probe is never even attempted.
    expect(probeState.calls).toEqual([]);
  });

  it('sniff hit short-circuits the tenant probe (sniff first, probe second)', async () => {
    // gh_jid pins the job AND the HTML names the tenant: the free sniff wins,
    // so the probe (which costs API GETs) must never run.
    const url = 'https://acme-example.com/jobs?gh_jid=42';
    platformState.byUrl[url] = {
      platform: 'greenhouse',
      tenant: null,
      externalId: '42',
    };
    pageState.byUrl[url] =
      '<a href="https://boards.greenhouse.io/acme">our job board</a>';
    probeState.tenant = 'wrong-if-ever-consulted';
    const s = await ingestMessageLinks({} as Deps, url);
    expect(s.ingested).toBe(1);
    expect(s.outcomes[0]).toMatchObject({
      kind: 'ingested',
      url: 'https://job-boards.greenhouse.io/acme/jobs/42',
    });
    expect(probeState.calls).toEqual([]);
  });

  it('sniff null + probe hit ingests the canonical board URL (JS-rendered page, live akuna shape)', async () => {
    // akunacapital.com serves a JS-rendered page with NO greenhouse markers
    // in the HTML — the sniff sees nothing — but the gh_jid URL pins the job
    // id and the probe verifies the tenant against the boards API.
    const url =
      'https://akunacapital.com/careers/job/8018853/swe?gh_jid=8018853';
    platformState.byUrl[url] = {
      platform: 'greenhouse',
      tenant: null,
      externalId: '8018853',
    };
    pageState.byUrl[url] = '<html><body><div id="root"></div></body></html>';
    probeState.tenant = 'akunacapital';
    const canonical =
      'https://job-boards.greenhouse.io/akunacapital/jobs/8018853';
    const s = await ingestMessageLinks({} as Deps, url);
    expect(s.ingested).toBe(1);
    expect(s.outcomes[0]).toMatchObject({
      kind: 'ingested',
      platform: 'greenhouse',
      url: canonical,
    });
    expect(ingestState.calls).toEqual([canonical]);
    expect(probeState.calls).toEqual([{ url, jobId: '8018853' }]);
  });

  it('probes even when the page fetch fails, using the PRE-resolve gh_jid ref', async () => {
    // The redirect strips gh_jid AND the stripped page cannot be fetched:
    // the job id from the ORIGINAL pasted URL still drives the probe.
    const pasted = 'https://acme-example.com/jobs/search?gh_jid=77';
    const stripped = 'https://acme-example.com/jobs/listing/senior-baker';
    platformState.byUrl[pasted] = {
      platform: 'greenhouse',
      tenant: null,
      externalId: '77',
    };
    platformState.resolveTo[pasted] = stripped;
    // No pageState fixture for `stripped`: fetchPageHtml returns null.
    probeState.tenant = 'acme';
    const s = await ingestMessageLinks({} as Deps, pasted);
    expect(s.ingested).toBe(1);
    expect(s.outcomes[0]).toMatchObject({
      kind: 'ingested',
      url: 'https://job-boards.greenhouse.io/acme/jobs/77',
    });
    // Candidates come from the RESOLVED page's host (where the page lives).
    expect(probeState.calls).toEqual([{ url: stripped, jobId: '77' }]);
  });

  it('probe hit outranks directory expansion (probe second, directory third)', async () => {
    const url = 'https://acme-example.com/careers/opening?gh_jid=8';
    platformState.byUrl[url] = {
      platform: 'greenhouse',
      tenant: null,
      externalId: '8',
    };
    platformState.byUrl['https://gh/other'] = {
      platform: 'greenhouse',
      tenant: 'other',
      externalId: '9',
    };
    // The page has extractable job links, but the gh_jid + verified tenant
    // identify THIS page as one posting — never a directory.
    pageState.byUrl[url] = '<html>rendered nav</html>';
    dirState.byUrl[url] = ['https://gh/other'];
    probeState.tenant = 'acme';
    const s = await ingestMessageLinks({} as Deps, url);
    expect(s.directories).toBe(0);
    expect(s.ingested).toBe(1);
    expect(s.outcomes[0]).toMatchObject({
      kind: 'ingested',
      url: 'https://job-boards.greenhouse.io/acme/jobs/8',
    });
  });

  it('parks a gh_jid page exactly as before when the probe finds no tenant', async () => {
    const url =
      'https://akunacapital.com/careers/job/8018853/swe?gh_jid=8018853';
    platformState.byUrl[url] = {
      platform: 'greenhouse',
      tenant: null,
      externalId: '8018853',
    };
    pageState.byUrl[url] = '<html><body><div id="root"></div></body></html>';
    // probeState.tenant stays null: no candidate verified.
    const s = await ingestMessageLinks({} as Deps, url);
    expect(s.unsupported).toBe(1);
    expect(probeState.calls).toEqual([{ url, jobId: '8018853' }]);
    // Recorded + parked through ingestJob with the page URL, same as today.
    expect(ingestState.calls).toEqual([url]);
  });

  it('counts a duplicate and handles a mixed message', async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '1',
    };
    platformState.byUrl['https://weird/x'] = {
      platform: 'unknown',
      tenant: null,
      externalId: null,
    };
    ingestState.known = new Set(['https://gh/1']); // already ingested
    const s = await ingestMessageLinks(
      {} as Deps,
      'https://gh/1 and https://weird/x',
    );
    expect(s).toMatchObject({ urls: 2, duplicates: 1, unsupported: 1 });
    // The duplicate outcome carries the original's task, source, and time.
    expect(s.outcomes[0]).toMatchObject({
      kind: 'duplicate',
      taskId: 'task-dup',
      originalSource: 'discord',
      originalCreatedAt: new Date('2026-07-13T19:47:00Z'),
    });
    // Fresh outcomes carry the created task so the reply can link it.
    expect(s.outcomes[1]).toMatchObject({
      kind: 'unsupported',
      taskId: 'task-1',
    });
  });
});

describe('reactionFor / replyFor', () => {
  const base: MessageIngestSummary = {
    urls: 1,
    ingested: 0,
    duplicates: 0,
    unsupported: 0,
    directories: 0,
    errors: 0,
    screenshots: 0,
    outcomes: [],
    screenshotOutcomes: [],
  };
  const BASE_URL = 'https://sower-dashboard-abc.run.app';

  it('picks the highest-signal emoji', () => {
    expect(reactionFor({ ...base, ingested: 1 })).toBe('✅');
    expect(reactionFor({ ...base, directories: 1 })).toBe('🔎');
    expect(reactionFor({ ...base, unsupported: 1 })).toBe('⚠️');
    expect(reactionFor({ ...base, duplicates: 1 })).toBe('♻️');
    expect(reactionFor({ ...base })).toBe('❌');
  });

  it('marks a screenshot-only message handled (never ❌)', () => {
    expect(reactionFor({ ...base, screenshots: 1 })).toBe('🖼️');
    // A queued link still outranks the screenshot marker.
    expect(reactionFor({ ...base, screenshots: 1, ingested: 1 })).toBe('✅');
  });

  it('links ingested, unsupported, and screenshot outcomes to their tasks', () => {
    const reply = replyFor(
      {
        ...base,
        urls: 2,
        ingested: 1,
        unsupported: 1,
        screenshots: 1,
        outcomes: [
          {
            url: 'https://gh/1',
            kind: 'ingested',
            platform: 'greenhouse',
            jobId: 'job-1',
            taskId: 'task-1111-aaaa',
          },
          {
            url: 'https://weird/x',
            kind: 'unsupported',
            jobId: 'job-2',
            taskId: 'task-2222-bbbb',
          },
        ],
        screenshotOutcomes: [
          {
            kind: 'screenshot',
            jobId: 'job-3',
            taskId: 'task-3333-cccc',
            filename: 'shot.png',
            stored: true,
          },
        ],
      },
      BASE_URL,
    );
    // Labels are the shortened URL / filename + the ingest date — the task id
    // is only ever the link TARGET, never the visible text.
    expect(reply).toContain(
      `✅ [gh/1](${BASE_URL}/tasks/task-1111-aaaa) · queued · greenhouse · ${TODAY}`,
    );
    expect(reply).toContain(
      `⚠️ [weird/x](${BASE_URL}/tasks/task-2222-bbbb) · recorded (unsupported) · ${TODAY}`,
    );
    expect(reply).toContain(
      `🖼️ [shot.png](${BASE_URL}/tasks/task-3333-cccc) · screenshot recorded · ${TODAY}`,
    );
    expect(reply).not.toContain('`task-');
    expect(reply).not.toMatch(/\[[^\]]*task-\d{4}[^\]]*\]/);
  });

  it('renders "discovering form…" for an unsupported outcome under investigation', () => {
    const reply = replyFor(
      {
        ...base,
        unsupported: 1,
        outcomes: [
          {
            url: 'https://weird/x',
            kind: 'unsupported',
            jobId: 'job-2',
            taskId: 'task-2222-bbbb',
            investigating: true,
          },
        ],
      },
      BASE_URL,
    );
    expect(reply).toContain(
      `🔎 [weird/x](${BASE_URL}/tasks/task-2222-bbbb) · discovering form… · ${TODAY}`,
    );
    expect(reply).not.toContain('recorded (unsupported)');
  });

  it('links a duplicate to the existing task with original time + repo source', () => {
    const reply = replyFor(
      {
        ...base,
        duplicates: 1,
        outcomes: [
          {
            url: 'https://gh/1',
            kind: 'duplicate',
            jobId: 'job-1',
            taskId: 'task-orig-1',
            originalSource: 'SimplifyJobs/Summer2027-Internships',
            // 19:47 UTC = 3:47 PM in America/New_York (EDT).
            originalCreatedAt: new Date('2026-07-13T19:47:00Z'),
          },
        ],
      },
      BASE_URL,
    );
    expect(reply).toContain(
      `♻️ [gh/1](${BASE_URL}/tasks/task-orig-1) · duplicate`,
    );
    expect(reply).toContain('originally added Jul 13, 3:47 PM ET');
    expect(reply).toContain(
      '[SimplifyJobs/Summer2027-Internships](https://github.com/SimplifyJobs/Summer2027-Internships)',
    );
  });

  it('renders a non-repo duplicate source (discord) as plain text', () => {
    const reply = replyFor(
      {
        ...base,
        duplicates: 1,
        outcomes: [
          {
            url: 'https://gh/1',
            kind: 'duplicate',
            jobId: 'job-1',
            taskId: 'task-orig-1',
            originalSource: 'discord',
            originalCreatedAt: new Date('2026-07-13T19:47:00Z'),
          },
        ],
      },
      BASE_URL,
    );
    expect(reply).toContain('via discord');
    expect(reply).not.toContain('github.com/discord');
  });

  it('degrades to bold link-less labels (never the id) when no dashboard base URL is set', () => {
    const reply = replyFor({
      ...base,
      urls: 2,
      ingested: 1,
      duplicates: 1,
      screenshots: 1,
      outcomes: [
        {
          url: 'https://gh/1',
          kind: 'ingested',
          platform: 'greenhouse',
          jobId: 'job-1',
          taskId: 'task-1111-aaaa',
        },
        {
          url: 'https://gh/2',
          kind: 'duplicate',
          jobId: 'job-2',
          taskId: 'task-orig-1',
          originalSource: 'discord',
          originalCreatedAt: new Date('2026-07-13T19:47:00Z'),
        },
      ],
      screenshotOutcomes: [
        {
          kind: 'screenshot',
          jobId: 'job-3',
          taskId: 'task-3333-cccc',
          filename: 'shot.png',
          stored: true,
        },
      ],
    });
    expect(reply).toContain(`✅ **gh/1** · queued · greenhouse · ${TODAY}`);
    expect(reply).toContain('♻️ **gh/2** · duplicate');
    expect(reply).toContain(`🖼️ **shot.png** · screenshot recorded · ${TODAY}`);
    expect(reply).toContain('originally added Jul 13, 3:47 PM ET via discord');
    expect(reply).not.toContain('](');
    // The raw task ids appear nowhere at all without a link target.
    expect(reply).not.toContain('task-1111-aaaa');
    expect(reply).not.toContain('task-orig-1');
    expect(reply).not.toContain('task-3333-cccc');
  });

  it('summarizes a directory outcome with child counts', () => {
    const reply = replyFor(
      {
        ...base,
        directories: 1,
        ingested: 2,
        unsupported: 1,
        outcomes: [
          {
            url: 'https://dir/list',
            kind: 'directory',
            children: [
              {
                url: 'https://gh/1',
                kind: 'ingested',
                platform: 'greenhouse',
                jobId: 'j1',
                taskId: 't1',
              },
              {
                url: 'https://gh/2',
                kind: 'ingested',
                platform: 'ashby',
                jobId: 'j2',
                taskId: 't2',
              },
              {
                url: 'https://weird/x',
                kind: 'unsupported',
                jobId: 'j3',
                taskId: 't3',
              },
            ],
          },
        ],
      },
      BASE_URL,
    );
    expect(reply).toContain(
      '🔎 3 links from a directory (2 queued, 1 recorded)',
    );
  });

  it('itemizes an error with a shortened url', () => {
    const reply = replyFor(
      {
        ...base,
        errors: 1,
        outcomes: [
          {
            url: 'https://broken.example/jobs/1',
            kind: 'error',
            error: 'boom',
          },
        ],
      },
      BASE_URL,
    );
    expect(reply).toContain('❌ broken.example/jobs/1: boom');
  });

  it('caps a long reply under 2000 chars with a "…+N more" summary', () => {
    const outcomes: UrlOutcome[] = Array.from({ length: 40 }, (_, i) => ({
      url: `https://gh/${i}`,
      kind: 'ingested' as const,
      platform: 'greenhouse',
      jobId: `job-${i}`,
      taskId: `task-${String(i).padStart(4, '0')}-abcdef-ghijkl`,
    }));
    const reply = replyFor(
      { ...base, urls: 40, ingested: 40, outcomes },
      BASE_URL,
    );
    expect(reply.length).toBeLessThanOrEqual(2000);
    expect(reply).toContain('…+30 more');
    // 10 itemized lines + the summary line.
    expect(reply.split('\n')).toHaveLength(11);
  });

  it('keeps the empty-message reply', () => {
    expect(replyFor({ ...base }, BASE_URL)).toMatch(/No job links/);
    expect(replyFor({ ...base })).toMatch(/No job links/);
  });
});

describe('taskLabel', () => {
  const url = 'https://apply.workable.com/tickpick/j/436CCC1027/';

  it('renders Title · Company when both are known', () => {
    expect(
      taskLabel({ title: 'Data Scientist', company: 'TickPick', url }),
    ).toBe('Data Scientist · TickPick');
  });

  it('renders the lone known part when only one is present', () => {
    expect(taskLabel({ title: 'Data Scientist', url })).toBe('Data Scientist');
    expect(taskLabel({ title: null, company: 'TickPick', url })).toBe(
      'TickPick',
    );
    // Blank strings count as unknown, not as a label.
    expect(taskLabel({ title: '  ', company: '', url })).toBe(
      'apply.workable.com/tickpick/j/436CCC1027',
    );
  });

  it('falls back to the URL, scheme + www. stripped and trailing slash dropped', () => {
    expect(taskLabel({ url: 'https://www.example.com/careers/123/' })).toBe(
      'example.com/careers/123',
    );
    expect(taskLabel({ url })).toBe('apply.workable.com/tickpick/j/436CCC1027');
  });

  it('caps a long URL fallback at 48 chars with a trailing ellipsis', () => {
    const long = `https://boards.example.com/${'a'.repeat(80)}`;
    const label = taskLabel({ url: long });
    expect(label).toHaveLength(48);
    expect(label.endsWith('…')).toBe(true);
    expect(label.startsWith('boards.example.com/')).toBe(true);
  });

  it('escapes markdown-breaking characters so a title cannot corrupt the link', () => {
    expect(
      taskLabel({ title: 'C++ Dev [Sr] `beta`', company: 'A*B_C', url }),
    ).toBe('C++ Dev \\[Sr\\] \\`beta\\` · A\\*B\\_C');
  });
});

describe('announcedTaskIds', () => {
  const base: MessageIngestSummary = {
    urls: 0,
    ingested: 0,
    duplicates: 0,
    unsupported: 0,
    directories: 0,
    errors: 0,
    screenshots: 0,
    outcomes: [],
    screenshotOutcomes: [],
  };

  it('collects fresh ingested/unsupported/screenshot tasks, deduped', () => {
    const ids = announcedTaskIds({
      ...base,
      outcomes: [
        {
          url: 'https://gh/1',
          kind: 'ingested',
          platform: 'greenhouse',
          jobId: 'j1',
          taskId: 'task-a',
        },
        {
          url: 'https://weird/x',
          kind: 'unsupported',
          jobId: 'j2',
          taskId: 'task-b',
        },
        // Same task announced twice (e.g. the same URL pasted twice).
        {
          url: 'https://gh/1',
          kind: 'ingested',
          platform: 'greenhouse',
          jobId: 'j1',
          taskId: 'task-a',
        },
      ],
      screenshotOutcomes: [
        {
          kind: 'screenshot',
          jobId: 'j3',
          taskId: 'task-c',
          filename: 'shot.png',
          stored: true,
        },
      ],
    });
    expect(ids).toEqual(['task-a', 'task-b', 'task-c']);
  });

  it('skips duplicates, directory children, errors, and null/absent task ids', () => {
    const ids = announcedTaskIds({
      ...base,
      outcomes: [
        {
          url: 'https://gh/1',
          kind: 'duplicate',
          jobId: 'j1',
          taskId: 'task-orig', // an EXISTING task announced elsewhere
          originalSource: 'discord',
          originalCreatedAt: new Date('2026-07-13T19:47:00Z'),
        },
        {
          url: 'https://dir/list',
          kind: 'directory',
          children: [
            {
              url: 'https://gh/2',
              kind: 'ingested',
              platform: 'greenhouse',
              jobId: 'j2',
              taskId: 'task-child', // collapses into one summary line
            },
          ],
        },
        { url: 'https://broken/x', kind: 'error', error: 'boom' },
        { url: 'https://weird/y', kind: 'unsupported', jobId: 'j4' },
      ],
      screenshotOutcomes: [
        {
          kind: 'screenshot',
          jobId: 'j5',
          taskId: null,
          filename: 'shot.png',
          stored: false,
        },
      ],
    });
    expect(ids).toEqual([]);
  });
});

describe('runDiscordIngestPoll', () => {
  function fakeDeps(
    messages: unknown[],
    options: { updateThrows?: boolean } = {},
  ) {
    const reactions: { id: string; emoji: string }[] = [];
    const replies: string[] = [];
    const inserted: Record<string, unknown>[] = [];
    const updated: Record<string, unknown>[] = [];
    const notify = {
      fetchChannelMessages: vi.fn(async () => messages),
      addReaction: vi.fn(async (_c: string, id: string, emoji: string) => {
        reactions.push({ id, emoji });
      }),
      postChannelMessage: vi.fn(async (_c: string, text: string) => {
        replies.push(text);
        return { id: `reply-${replies.length}` };
      }),
      editChannelMessage: vi.fn(async () => {}),
    };
    // Minimal db: captures the documents rows screenshot ingest inserts and
    // the application_tasks reply-ref updates the poll performs.
    const db = {
      insert: () => ({
        values: async (row: Record<string, unknown>) => {
          inserted.push(row);
          return [];
        },
      }),
      update: () => ({
        set: (arg: Record<string, unknown>) => ({
          where: async () => {
            if (options.updateThrows) {
              throw new Error('db down');
            }
            updated.push(arg);
          },
        }),
      }),
    };
    const deps = {
      config: {
        DISCORD_ENABLED: true,
        DISCORD_INGEST_CHANNEL_ID: 'chan-1',
        DISCORD_APP_ID: 'app-self',
        DASHBOARD_BASE_URL: 'https://dash.test',
      } as unknown as Config,
      notify,
      db,
    } as unknown as Deps;
    return { deps, notify, reactions, replies, inserted, updated };
  }

  it('processes fresh messages with links from any author; skips reacted + no-link', async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '1',
    };
    // newest-first as Discord returns them
    const messages = [
      { id: 'm-nolink', content: 'just chatting', author: { id: 'u' } },
      {
        id: 'm-done',
        content: 'https://gh/1',
        author: { id: 'u' },
        reactions: [{ me: true, emoji: { name: '✅' } }],
      },
      // A link forwarded by another bot/webhook must still ingest (no author skip).
      { id: 'm-bot', content: 'https://gh/1', author: { id: 'b', bot: true } },
      {
        id: 'm-fresh',
        content: 'please add https://gh/1',
        author: { id: 'u' },
      },
    ];
    const { deps, reactions, replies } = fakeDeps(messages);

    const result = await runDiscordIngestPoll(deps);

    // oldest-first: m-fresh (ingest) → m-bot (ingest) → m-done (reacted, skip)
    // → m-nolink (no url, skip).
    expect(result).toMatchObject({ enabled: true, scanned: 4, processed: 2 });
    expect(reactions).toEqual([
      { id: 'm-fresh', emoji: '✅' },
      { id: 'm-bot', emoji: '✅' },
    ]);
    expect(replies).toHaveLength(2);
    expect(ingestState.calls).toEqual(['https://gh/1', 'https://gh/1']);
  });

  it('skips the bot own reply, and never ingests a dashboard/IAP link (no self-loop)', async () => {
    platformState.byUrl['https://gh/2'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '2',
    };
    const messages = [
      // The bot's own reply (author.id === app id) — must be skipped entirely,
      // even though it embeds a dashboard task link.
      {
        id: 'm-self',
        content: '✅ [`abc`](https://dash.test/tasks/abc) queued',
        author: { id: 'app-self', bot: true },
      },
      // A human message that (oddly) contains a dashboard link + a real job link:
      // the dashboard link is dropped, the job link still ingests.
      {
        id: 'm-mixed',
        content: 'see https://dash.test/tasks/xyz and https://gh/2',
        author: { id: 'u' },
      },
    ];
    const { deps, reactions } = fakeDeps(messages);

    const result = await runDiscordIngestPoll(deps);

    // m-self skipped (self-authored); m-mixed processed but only the job link.
    expect(result).toMatchObject({ processed: 1 });
    expect(reactions).toEqual([{ id: 'm-mixed', emoji: '✅' }]);
    expect(ingestState.calls).toEqual(['https://gh/2']); // dashboard link dropped
  });

  it('processes an image-only message: parked + stored, 🖼️ reaction', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    try {
      const messages = [
        {
          id: 'm-shot',
          content: 'saw this on a flyer',
          author: { id: 'u' },
          attachments: [IMAGE_ATTACHMENT],
        },
      ];
      const { deps, reactions, replies, inserted } = fakeDeps(messages);

      const result = await runDiscordIngestPoll(deps);

      // NOT skipped despite having no URL in its content.
      expect(result).toMatchObject({ enabled: true, scanned: 1, processed: 1 });
      expect(reactions).toEqual([{ id: 'm-shot', emoji: '🖼️' }]);
      expect(replies).toHaveLength(1);
      // The reply links the parked task on the dashboard under its filename.
      expect(replies[0]).toContain(
        `🖼️ [shot.png](https://dash.test/tasks/task-1) · screenshot recorded · ${TODAY}`,
      );
      // Parked via ingestJob and linked to the job via a documents row.
      expect(ingestState.calls).toEqual([CDN_URL]);
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({
        kind: 'screenshot',
        filename: 'shot.png',
        jobId: 'job-1',
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('handles a mixed message: link ingested AND screenshot recorded', async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '1',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    try {
      const messages = [
        {
          id: 'm-mixed',
          content: 'apply https://gh/1',
          author: { id: 'u' },
          attachments: [IMAGE_ATTACHMENT],
        },
      ];
      const { deps, reactions, replies, inserted } = fakeDeps(messages);

      const result = await runDiscordIngestPoll(deps);

      expect(result).toMatchObject({ enabled: true, scanned: 1, processed: 1 });
      // The queued link wins the reaction; the reply itemizes both outcomes,
      // each linked to its dashboard task.
      expect(reactions).toEqual([{ id: 'm-mixed', emoji: '✅' }]);
      expect(replies[0]).toContain(
        `✅ [gh/1](https://dash.test/tasks/task-1) · queued · greenhouse · ${TODAY}`,
      );
      expect(replies[0]).toContain(
        `🖼️ [shot.png](https://dash.test/tasks/task-1) · screenshot recorded · ${TODAY}`,
      );
      // Both the text link and the attachment went through ingestJob.
      expect(ingestState.calls).toEqual(['https://gh/1', CDN_URL]);
      expect(inserted).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('is a no-op when Discord or the ingest channel is unconfigured', async () => {
    const deps = {
      config: { DISCORD_ENABLED: false } as unknown as Config,
      notify: { fetchChannelMessages: vi.fn() },
    } as unknown as Deps;
    const result = await runDiscordIngestPoll(deps);
    expect(result).toEqual({ enabled: false, scanned: 0, processed: 0 });
  });

  it('stores the reply channel + message id on the tasks the message created', async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '1',
    };
    const messages = [
      { id: 'm-fresh', content: 'https://gh/1', author: { id: 'u' } },
    ];
    const { deps, updated } = fakeDeps(messages);

    await runDiscordIngestPoll(deps);

    // One update per posted reply, tagging its fresh tasks with the ref.
    expect(updated).toEqual([
      { ingestChannelId: 'chan-1', ingestMessageId: 'reply-1' },
    ]);
  });

  it('does not update tasks when the reply itself failed to post', async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '1',
    };
    const messages = [
      { id: 'm-fresh', content: 'https://gh/1', author: { id: 'u' } },
    ];
    const { deps, notify, updated } = fakeDeps(messages);
    notify.postChannelMessage.mockRejectedValueOnce(new Error('discord down'));

    const result = await runDiscordIngestPoll(deps);

    // The poll still completed (reply failure is best-effort)...
    expect(result).toMatchObject({ enabled: true, processed: 1 });
    // ...and no reply ref was written (there is no message to edit later).
    expect(updated).toEqual([]);
  });

  it('never fails the poll when storing the reply ref throws (best-effort)', async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '1',
    };
    const messages = [
      { id: 'm-fresh', content: 'https://gh/1', author: { id: 'u' } },
    ];
    const { deps, replies } = fakeDeps(messages, { updateThrows: true });

    const result = await runDiscordIngestPoll(deps);

    expect(result).toMatchObject({ enabled: true, scanned: 1, processed: 1 });
    expect(replies).toHaveLength(1);
  });
});
