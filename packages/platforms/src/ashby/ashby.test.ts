import { readFileSync } from 'node:fs';
import type { JobSpec, PlatformRef, ResolvedAnswer } from '@sower/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmitFile } from '../contract.js';
import type { ApiCallRecord } from '../recorder.js';
import { AshbyAdapter, mapAshbyApplicationForm } from './index.js';

// Raw response from GET api.ashbyhq.com/posting-api/job-board/linear?includeCompensation=true
// (fetched live 2026-07; trimmed to 3 jobs, descriptions truncated). The
// public posting API exposes NO applicationForm for any org we probed
// (ramp, notion, openai, linear) — so real discoveries yield 0 questions.
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.ashbyhq.com/posting-api/job-board/linear?includeCompensation=true',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('maps the posting found by id to a JobSpec', async () => {
    const spec = await adapter.discover(ref, url);
    expect(spec).toEqual({
      platform: 'ashby',
      tenant: 'linear',
      externalId: 'd3bc1ced-3ce4-4086-a050-555055dbb1ff',
      title: 'Senior / Staff Fullstack Engineer',
      company: 'linear',
      location: 'Europe',
      applyUrl:
        'https://jobs.ashbyhq.com/linear/d3bc1ced-3ce4-4086-a050-555055dbb1ff/application',
      questions: [],
    });
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

  it('passes the recorder through recordedFetch and records exactly one discover call', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(fixture), {
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
