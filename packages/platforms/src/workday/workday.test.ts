import { readFileSync } from 'node:fs';
import type { PlatformRef } from '@sower/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiCallRecord } from '../recorder.js';
import {
  parseWorkdayJobUrl,
  WorkdayAdapter,
  WorkdayBrowserTierRequiredError,
  WorkdayJobUnavailableError,
} from './index.js';

// Raw cxs job-detail response captured live 2026-07 from
// GET cadence.wd1.myworkdayjobs.com/wday/cxs/cadence/external_careers/job/...
const fixture = JSON.parse(
  readFileSync(new URL('./fixture-cadence.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const url =
  'https://cadence.wd1.myworkdayjobs.com/en-US/external_careers/job/SAN-JOSE/Software-Intern_R53282-1';
const ref: PlatformRef = {
  platform: 'workday',
  tenant: 'cadence',
  externalId: null,
};

describe('parseWorkdayJobUrl', () => {
  it('parses a locale-prefixed URL into the cxs detail endpoint', () => {
    const parts = parseWorkdayJobUrl(url);
    expect(parts).toEqual({
      host: 'cadence.wd1.myworkdayjobs.com',
      tenant: 'cadence',
      site: 'external_careers',
      externalPath: '/job/SAN-JOSE/Software-Intern_R53282-1',
      cxsDetailUrl:
        'https://cadence.wd1.myworkdayjobs.com/wday/cxs/cadence/external_careers/job/SAN-JOSE/Software-Intern_R53282-1',
    });
  });

  it('handles a URL with no locale segment', () => {
    const parts = parseWorkdayJobUrl(
      'https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/Toronto-ON/Intern_R223395',
    );
    expect(parts.site).toBe('Capital_One');
    expect(parts.cxsDetailUrl).toBe(
      'https://capitalone.wd12.myworkdayjobs.com/wday/cxs/capitalone/Capital_One/job/Toronto-ON/Intern_R223395',
    );
  });

  it('strips query params and tolerates the /details/ route keyword', () => {
    const parts = parseWorkdayJobUrl(
      'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/details/US-CA/Intern_JR1?source=indeed&x=1',
    );
    expect(parts.externalPath).toBe('/job/US-CA/Intern_JR1');
    expect(parts.cxsDetailUrl).toBe(
      'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-CA/Intern_JR1',
    );
  });

  it('rejects a non-workday host', () => {
    expect(() =>
      parseWorkdayJobUrl('https://boards.greenhouse.io/acme/jobs/1'),
    ).toThrow(/not a workday job url/);
  });

  it('rejects a URL with no job path after the site', () => {
    expect(() =>
      parseWorkdayJobUrl('https://acme.wd1.myworkdayjobs.com/careers'),
    ).toThrow(/cannot derive workday site\/job path/);
  });

  it('rejects an unparseable URL', () => {
    expect(() => parseWorkdayJobUrl('not a url')).toThrow(
      /invalid workday url/,
    );
  });
});

describe('WorkdayAdapter.discover', () => {
  const adapter = new WorkdayAdapter();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fixture,
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches the cxs detail endpoint derived from the URL', async () => {
    await adapter.discover(ref, url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://cadence.wd1.myworkdayjobs.com/wday/cxs/cadence/external_careers/job/SAN-JOSE/Software-Intern_R53282-1',
    );
  });

  it('normalizes the posting into a read-only, account-required JobSpec', async () => {
    const spec = await adapter.discover(ref, url);
    expect(spec.platform).toBe('workday');
    expect(spec.tenant).toBe('cadence');
    expect(spec.title).toBe('Software Intern');
    expect(spec.location).toBe('SAN JOSE');
    // No discoverable questions at this tier — that is the whole point.
    expect(spec.questions).toEqual([]);
    expect(spec.formAccess).toBe('account-required');
    // Description is derived from the raw HTML jobDescription.
    expect(spec.description).toContain('Cadence');
    expect(spec.descriptionHtml).toContain('<');
  });

  it('falls back to jobReqId for externalId when the ref has none', async () => {
    const spec = await adapter.discover(ref, url);
    expect(spec.externalId).toBe('R53282');
  });

  it('prefers an explicit ref.externalId over the response', async () => {
    const spec = await adapter.discover({ ...ref, externalId: 'PINNED' }, url);
    expect(spec.externalId).toBe('PINNED');
  });

  it('stashes cxs site/path/questionnaire ids in meta for later tiers', async () => {
    const spec = await adapter.discover(ref, url);
    expect(spec.meta).toMatchObject({
      site: 'external_careers',
      externalPath: '/job/SAN-JOSE/Software-Intern_R53282-1',
      questionnaireId: expect.any(String),
    });
  });

  it('uses the canonical externalUrl as the applyUrl when present', async () => {
    const spec = await adapter.discover(ref, url);
    expect(spec.applyUrl).toContain('myworkdayjobs.com');
  });

  it('leaves deadline unset when the posting has no endDate (the fixture)', async () => {
    const spec = await adapter.discover(ref, url);
    expect(spec.deadline).toBeUndefined();
  });

  it('maps an explicit cxs endDate to spec.deadline (UTC midnight)', async () => {
    const info = fixture.jobPostingInfo as Record<string, unknown>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ...fixture,
        jobPostingInfo: { ...info, endDate: '2026-08-01' },
      }),
    });
    const spec = await adapter.discover(ref, url);
    expect(spec.deadline).toBe('2026-08-01T00:00:00.000Z');
  });

  it('ignores an unparseable endDate instead of guessing', async () => {
    const info = fixture.jobPostingInfo as Record<string, unknown>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ...fixture,
        jobPostingInfo: { ...info, endDate: 'until filled' },
      }),
    });
    const spec = await adapter.discover(ref, url);
    expect(spec.deadline).toBeUndefined();
  });

  it('records the discover call when a recorder is supplied', async () => {
    // Use a real Response so the recorder can clone and capture the body.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const calls: ApiCallRecord[] = [];
    await adapter.discover(ref, url, { recorder: (c) => void calls.push(c) });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ phase: 'discover', method: 'GET' });
  });

  it('throws WorkdayJobUnavailableError on 403 (unpublished/filled)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({}),
    });
    await expect(adapter.discover(ref, url)).rejects.toBeInstanceOf(
      WorkdayJobUnavailableError,
    );
  });

  it('throws WorkdayJobUnavailableError on 404', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    await expect(adapter.discover(ref, url)).rejects.toBeInstanceOf(
      WorkdayJobUnavailableError,
    );
  });

  it('throws a generic error on other non-ok statuses', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    await expect(adapter.discover(ref, url)).rejects.toThrow(/status 500/);
  });

  it('throws when the response lacks a job title', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ jobPostingInfo: {} }),
    });
    await expect(adapter.discover(ref, url)).rejects.toThrow(/missing/);
  });
});

describe('WorkdayAdapter submit guardrails', () => {
  const adapter = new WorkdayAdapter();
  const spec = {
    platform: 'workday' as const,
    tenant: 'cadence',
    externalId: 'R53282',
    title: 'Software Intern',
    applyUrl: url,
    questions: [],
  };

  it('buildSubmitPayload throws — no network-tier submission exists', () => {
    expect(() => adapter.buildSubmitPayload(spec, [])).toThrow(
      WorkdayBrowserTierRequiredError,
    );
  });

  it('dryRunSubmit throws (performs no I/O)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(adapter.dryRunSubmit(spec, [], [])).rejects.toBeInstanceOf(
      WorkdayBrowserTierRequiredError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('submit throws (never POSTs)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(adapter.submit(spec, [], [])).rejects.toBeInstanceOf(
      WorkdayBrowserTierRequiredError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
