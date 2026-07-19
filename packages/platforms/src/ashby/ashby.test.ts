import { readFileSync } from 'node:fs';
import type { JobSpec, PlatformRef, ResolvedAnswer } from '@sower/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmitFile } from '../contract.js';
import type { ApiCallRecord } from '../recorder.js';
import {
  AshbyAdapter,
  fetchAshbyApplicationForm,
  mapAshbyApplicationForm,
} from './index.js';

// Raw response from GET api.ashbyhq.com/posting-api/job-board/linear?includeCompensation=true
// (fetched live 2026-07; trimmed to 3 jobs, descriptions truncated). This
// metadata endpoint carries NO applicationForm, so discover falls back to the
// public job-board GraphQL for the real form (see fixture-form.json).
const fixture = JSON.parse(
  readFileSync(new URL('./fixture-linear.json', import.meta.url), 'utf8'),
) as { jobs: Record<string, unknown>[]; apiVersion: number };

const ref: PlatformRef = {
  platform: 'ashby',
  tenant: 'linear',
  externalId: 'd3bc1ced-3ce4-4086-a050-555055dbb1ff',
};
const url =
  'https://jobs.ashbyhq.com/linear/d3bc1ced-3ce4-4086-a050-555055dbb1ff';

const sampleSpec: JobSpec = {
  platform: 'ashby',
  tenant: 'linear',
  externalId: 'd3bc1ced-3ce4-4086-a050-555055dbb1ff',
  title: 'Sample',
  applyUrl: `${url}/application`,
  questions: [],
};

describe('AshbyAdapter.discover', () => {
  const adapter = new AshbyAdapter();
  let fetchMock: ReturnType<typeof vi.fn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fixture,
    });
    vi.stubGlobal('fetch', fetchMock);
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requests the documented posting API with includeCompensation=true', async () => {
    await adapter.discover(ref, url);
    // First call is the posting-api metadata endpoint; because that endpoint
    // carries no form, a second call to the GraphQL form endpoint follows.
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.ashbyhq.com/posting-api/job-board/linear?includeCompensation=true',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      'jobs.ashbyhq.com/api/non-user-graphql',
    );
  });

  it('maps the posting found by id to a JobSpec', async () => {
    const job0 = fixture.jobs[0] as {
      descriptionHtml: string;
      descriptionPlain: string;
    };
    const spec = await adapter.discover(ref, url);
    expect(spec).toEqual({
      platform: 'ashby',
      tenant: 'linear',
      externalId: 'd3bc1ced-3ce4-4086-a050-555055dbb1ff',
      title: 'Senior / Staff Fullstack Engineer',
      company: 'linear',
      location: 'Europe',
      // Posting-API metadata: employmentType 'FullTime' is rendered the way
      // the hosted board displays it; workplaceType/department map directly.
      // The fixture's compensation summaries are null, so no compensation.
      employmentType: 'Full time',
      locationType: 'Remote',
      department: 'Product',
      applyUrl:
        'https://jobs.ashbyhq.com/linear/d3bc1ced-3ce4-4086-a050-555055dbb1ff/application',
      questions: [],
      // descriptionHtml comes straight from the posting API; description is
      // markdown converted from it (the fixture's HTML is one <p>, so the
      // markdown is its text — note it is NOT descriptionPlain, whose text
      // was truncated differently).
      descriptionHtml: job0.descriptionHtml,
      description:
        "At Linear, we're building the product development system for teams and agents. AI is fundame… [truncated for fixture]",
    });
  });

  it('converts structured descriptionHtml to markdown (bullets/bold kept)', async () => {
    const posting = {
      ...fixture.jobs[0],
      descriptionHtml:
        '<h2>About the role</h2><p><strong>Requirements:</strong></p><ul><li>Ship &amp; iterate</li><li>Talk to users</li></ul>',
      descriptionPlain:
        'About the role Requirements: Ship & iterate Talk to users',
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ jobs: [posting], apiVersion: 1 }),
    });
    const spec = await adapter.discover(ref, url);
    expect(spec.description).toBe(
      '## About the role\n\n**Requirements:**\n\n- Ship & iterate\n- Talk to users',
    );
    expect(spec.description).not.toMatch(/<[^>]+>/);
  });

  it('falls back to descriptionPlain when no descriptionHtml exists', async () => {
    const posting = {
      ...fixture.jobs[0],
      descriptionHtml: null,
      descriptionPlain: 'Plain text only.',
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ jobs: [posting], apiVersion: 1 }),
    });
    const spec = await adapter.discover(ref, url);
    expect(spec.description).toBe('Plain text only.');
    expect(spec.descriptionHtml).toBeUndefined();
  });

  it('maps Intern employment type, team fallback, and compensation tiers', async () => {
    const posting = {
      ...fixture.jobs[0],
      employmentType: 'Intern',
      department: null,
      team: 'Engineering',
      workplaceType: null,
      isRemote: true,
      compensation: {
        compensationTierSummary: null,
        scrapeableCompensationSalarySummary: '$50 - $65 per hour',
        compensationTiers: [
          { title: 'Zone A', tierSummary: '$60 – $65 / hr' },
          { title: 'Zone B', tierSummary: '$50 – $55 / hr' },
        ],
      },
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ jobs: [posting], apiVersion: 1 }),
    });

    const spec = await adapter.discover(ref, url);
    expect(spec.employmentType).toBe('Intern');
    // No department → team; no workplaceType → isRemote fallback.
    expect(spec.department).toBe('Engineering');
    expect(spec.locationType).toBe('Remote');
    // Tiers joined with ' · ' (the board-level summary is null here).
    expect(spec.compensation).toBe(
      'Zone A: $60 – $65 / hr · Zone B: $50 – $55 / hr',
    );
  });

  it('prefers the board-level compensation summary and passes unknown employment types through', async () => {
    const posting = {
      ...fixture.jobs[0],
      employmentType: 'SomeFutureType',
      compensation: {
        compensationTierSummary: '$114K – $172K • Offers Equity',
        scrapeableCompensationSalarySummary: '$114K - $172K',
        compensationTiers: [{ title: 'US', tierSummary: '$114K – $172K' }],
      },
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ jobs: [posting], apiVersion: 1 }),
    });

    const spec = await adapter.discover(ref, url);
    // Unknown types are never re-labeled — only what the source said.
    expect(spec.employmentType).toBe('SomeFutureType');
    expect(spec.compensation).toBe('$114K – $172K • Offers Equity');
  });

  it('finds a different posting on the same board by external id', async () => {
    const spec = await adapter.discover(
      {
        platform: 'ashby',
        tenant: 'linear',
        externalId: 'cd5ae036-0223-427a-b038-ba16ef9dcb32',
      },
      'https://jobs.ashbyhq.com/linear/cd5ae036-0223-427a-b038-ba16ef9dcb32',
    );
    expect(spec.title).toBe('Senior / Staff Fullstack Engineer');
    expect(spec.location).toBe('North America');
  });

  it('returns questions: [] with a logged note when the form is unavailable (never fabricates)', async () => {
    const spec = await adapter.discover(ref, url);
    expect(spec.questions).toEqual([]);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('no application form available'),
    );
  });

  it('maps an applicationForm when a payload carries one', async () => {
    const posting = {
      ...fixture.jobs[0],
      applicationForm: {
        sections: [
          {
            fieldEntries: [
              {
                isRequired: true,
                field: {
                  path: '_systemfield_name',
                  title: 'Name',
                  type: 'String',
                },
              },
              {
                isRequired: true,
                field: {
                  path: '_systemfield_resume',
                  title: 'Resume',
                  type: 'File',
                },
              },
              {
                isRequired: false,
                field: {
                  path: 'custom_visa',
                  title: 'Will you require sponsorship?',
                  type: 'ValueSelect',
                  selectableValues: [
                    { label: 'Yes', value: 'yes' },
                    { label: 'No', value: 'no' },
                  ],
                },
              },
            ],
          },
        ],
      },
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ jobs: [posting], apiVersion: 1 }),
    });

    const spec = await adapter.discover(ref, url);
    expect(spec.questions).toEqual([
      {
        id: '_systemfield_name',
        label: 'Name',
        type: 'text',
        required: true,
      },
      {
        id: '_systemfield_resume',
        label: 'Resume',
        type: 'file',
        required: true,
      },
      {
        id: 'custom_visa',
        label: 'Will you require sponsorship?',
        type: 'select',
        required: false,
        options: [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
      },
    ]);
  });

  it('throws when the posting id is not on the board', async () => {
    await expect(
      adapter.discover(
        { platform: 'ashby', tenant: 'linear', externalId: 'nope' },
        'https://jobs.ashbyhq.com/linear/nope',
      ),
    ).rejects.toThrow(/not found on job board linear/);
  });

  it('throws a descriptive error when tenant is missing', async () => {
    await expect(
      adapter.discover(
        { platform: 'ashby', tenant: null, externalId: 'x' },
        url,
      ),
    ).rejects.toThrow(/tenant/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a descriptive error when externalId is missing', async () => {
    await expect(
      adapter.discover(
        { platform: 'ashby', tenant: 'linear', externalId: null },
        url,
      ),
    ).rejects.toThrow(/externalId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws with the status code on a non-ok response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    await expect(adapter.discover(ref, url)).rejects.toThrow(/404/);
  });

  it('passes the recorder through recordedFetch and records the discover call', async () => {
    // Give the metadata payload a form so discover needs no second GraphQL
    // fetch — this isolates the recorder behavior on the primary call.
    const withForm = {
      jobs: [
        {
          ...fixture.jobs[0],
          applicationForm: {
            sections: [
              {
                fieldEntries: [
                  {
                    isRequired: true,
                    field: {
                      path: '_systemfield_name',
                      title: 'Name',
                      type: 'String',
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
      apiVersion: 1,
    };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(withForm), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const recorder = vi.fn();

    const spec = await adapter.discover(ref, url, { recorder });

    expect(spec.title).toBe('Senior / Staff Fullstack Engineer');
    expect(recorder).toHaveBeenCalledTimes(1);
    const call = recorder.mock.calls[0]?.[0] as ApiCallRecord;
    expect(call).toMatchObject({
      phase: 'discover',
      method: 'GET',
      url: 'https://api.ashbyhq.com/posting-api/job-board/linear?includeCompensation=true',
      responseStatus: 200,
    });
    expect(call.dryRun).toBeUndefined();
  });
});

describe('mapAshbyApplicationForm edge cases', () => {
  it('returns [] for absent/unrecognized shapes instead of fabricating', () => {
    expect(mapAshbyApplicationForm(undefined)).toEqual([]);
    expect(mapAshbyApplicationForm(null)).toEqual([]);
    expect(mapAshbyApplicationForm('html form')).toEqual([]);
    expect(mapAshbyApplicationForm({ someOtherKey: true })).toEqual([]);
  });

  it('skips entries whose id/label cannot be determined', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    expect(
      mapAshbyApplicationForm({
        fieldEntries: [{ field: { type: 'String' } }, 'garbage', 42],
      }),
    ).toEqual([]);
    expect(debugSpy).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('maps LongText to textarea and MultiValueSelect to multiselect', () => {
    expect(
      mapAshbyApplicationForm({
        fieldEntries: [
          {
            isRequired: false,
            field: { path: 'about', title: 'About you', type: 'LongText' },
          },
          {
            isRequired: true,
            field: {
              path: 'offices',
              title: 'Preferred offices',
              type: 'MultiValueSelect',
              selectableValues: [
                { label: 'NYC', value: 'nyc' },
                { label: 'SF', value: 'sf' },
              ],
            },
          },
        ],
      }),
    ).toEqual([
      { id: 'about', label: 'About you', type: 'textarea', required: false },
      {
        id: 'offices',
        label: 'Preferred offices',
        type: 'multiselect',
        required: true,
        options: [
          { label: 'NYC', value: 'nyc' },
          { label: 'SF', value: 'sf' },
        ],
      },
    ]);
  });

  it('represents Boolean fields as a two-option select (their exact domain)', () => {
    expect(
      mapAshbyApplicationForm({
        fieldEntries: [
          {
            isRequired: true,
            field: {
              path: 'remote_ok',
              title: 'Open to remote?',
              type: 'Boolean',
            },
          },
        ],
      }),
    ).toEqual([
      {
        id: 'remote_ok',
        label: 'Open to remote?',
        type: 'select',
        required: true,
        options: [
          { label: 'Yes', value: 'true' },
          { label: 'No', value: 'false' },
        ],
      },
    ]);
  });

  it('keeps unknown field types WITH options as select, without as text', () => {
    expect(
      mapAshbyApplicationForm({
        fieldEntries: [
          {
            field: {
              path: 'widget',
              title: 'Future widget',
              type: 'SomeFutureWidget',
              selectableValues: [{ label: 'A', value: 'a' }],
            },
          },
          {
            field: {
              path: 'plain',
              title: 'Plain future',
              type: 'SomeFutureWidget',
            },
          },
        ],
      }),
    ).toEqual([
      {
        id: 'widget',
        label: 'Future widget',
        type: 'select',
        required: false,
        options: [{ label: 'A', value: 'a' }],
      },
      { id: 'plain', label: 'Plain future', type: 'text', required: false },
    ]);
  });
});

describe('AshbyAdapter.buildSubmitPayload', () => {
  const adapter = new AshbyAdapter();

  it('keys the payload by question id and skips null values', () => {
    const answers: ResolvedAnswer[] = [
      { questionId: '_systemfield_name', source: 'profile', value: 'Jane' },
      { questionId: 'offices', source: 'bank', value: ['nyc'] },
      { questionId: 'about', source: 'default', value: null },
    ];
    expect(adapter.buildSubmitPayload(sampleSpec, answers)).toEqual({
      _systemfield_name: 'Jane',
      offices: ['nyc'],
    });
  });
});

describe('AshbyAdapter.dryRunSubmit', () => {
  const adapter = new AshbyAdapter();
  const answers: ResolvedAnswer[] = [
    { questionId: '_systemfield_name', source: 'profile', value: 'Jane' },
    { questionId: 'about', source: 'default', value: null },
  ];
  const files: SubmitFile[] = [
    {
      questionId: '_systemfield_resume',
      storagePath: 'documents/00000000-0000-4000-8000-000000000000/resume.pdf',
      filename: 'resume.pdf',
    },
  ];

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('NEVER invokes global fetch (zero network I/O)', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('dryRunSubmit performed network I/O — forbidden');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const recorder = vi.fn();

    await adapter.dryRunSubmit(sampleSpec, answers, files, { recorder });
    await adapter.dryRunSubmit(sampleSpec, answers, files); // no recorder path

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns file metadata (not contents) in the payload and records one dryRun call', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const recorder = vi.fn();

    const result = await adapter.dryRunSubmit(sampleSpec, answers, files, {
      recorder,
    });

    expect(result.dryRun).toBe(true);
    expect(result.payload).toEqual({
      _systemfield_name: 'Jane',
      _systemfield_resume: {
        kind: 'file',
        filename: 'resume.pdf',
        storagePath:
          'documents/00000000-0000-4000-8000-000000000000/resume.pdf',
      },
    });
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(recorder).toHaveBeenCalledWith({
      phase: 'submit_dryrun',
      method: 'POST',
      url: sampleSpec.applyUrl,
      requestBody: result.payload,
      dryRun: true,
      durationMs: 0,
    });
  });

  it('swallows recorder failures and still returns the payload', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failingRecorder = vi.fn().mockRejectedValue(new Error('db down'));

    const result = await adapter.dryRunSubmit(sampleSpec, answers, files, {
      recorder: failingRecorder,
    });

    expect(result.dryRun).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('AshbyAdapter.submit guardrail', () => {
  const adapter = new AshbyAdapter();
  const answers: ResolvedAnswer[] = [
    { questionId: '_systemfield_name', source: 'profile', value: 'Jane' },
  ];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('throws when SOWER_SUBMIT_ENABLED is unset', async () => {
    delete process.env.SOWER_SUBMIT_ENABLED;
    await expect(adapter.submit(sampleSpec, answers)).rejects.toThrow(
      'submit disabled: SOWER_SUBMIT_ENABLED guardrail',
    );
  });

  it('throws when SOWER_SUBMIT_ENABLED is "false"', async () => {
    vi.stubEnv('SOWER_SUBMIT_ENABLED', 'false');
    await expect(adapter.submit(sampleSpec, answers)).rejects.toThrow(
      'submit disabled: SOWER_SUBMIT_ENABLED guardrail',
    );
  });

  it('only dry-runs when enabled: logs the payload, returns dryRun, sends no request', async () => {
    vi.stubEnv('SOWER_SUBMIT_ENABLED', 'true');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await adapter.submit(sampleSpec, answers);

    expect(result).toEqual({ dryRun: true });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('DRY RUN — ashby submit'),
    );
    // Redaction: the log is a field-key summary, never applicant values.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('fields=['));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Ashby application form (public GraphQL)', () => {
  const formFixture = JSON.parse(
    readFileSync(new URL('./fixture-form.json', import.meta.url), 'utf8'),
  ) as unknown;

  it('maps the real GraphQL form fixture to typed questions', () => {
    const questions = mapAshbyApplicationForm(formFixture);
    expect(questions.length).toBe(9);
    const byId = Object.fromEntries(questions.map((q) => [q.id, q]));
    expect(byId._systemfield_name?.type).toBe('text');
    expect(byId._systemfield_email?.type).toBe('text');
    expect(byId._systemfield_resume?.type).toBe('file');
    // Boolean fields become two-option Yes/No selects (faithful, not invented).
    const booleans = questions.filter(
      (q) => q.type === 'select' && q.options?.length === 2,
    );
    expect(booleans.length).toBeGreaterThanOrEqual(1);
    for (const b of booleans) {
      expect(b.options?.map((o) => o.label).sort()).toEqual(['No', 'Yes']);
    }
    // Every question has a non-empty id (real Ashby paths) and label.
    for (const q of questions) {
      expect(q.id.length).toBeGreaterThan(0);
      expect(q.label.length).toBeGreaterThan(0);
    }
  });

  it('fetchAshbyApplicationForm extracts the form from a GraphQL response', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: { jobPosting: { applicationForm: formFixture } },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const form = await fetchAshbyApplicationForm('ramp', 'posting-1');
    expect(mapAshbyApplicationForm(form).length).toBe(9);
    // POSTs the GraphQL endpoint with the tenant + posting id in variables.
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toContain('jobs.ashbyhq.com/api/non-user-graphql');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('ramp');
    expect(String(init.body)).toContain('posting-1');
    vi.unstubAllGlobals();
  });

  it('fetchAshbyApplicationForm returns undefined on a non-200 (never fabricates)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    expect(await fetchAshbyApplicationForm('ramp', 'x')).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
