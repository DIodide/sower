import { readFileSync } from 'node:fs';
import type { JobSpec, PlatformRef, ResolvedAnswer } from '@sower/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmitFile } from '../contract.js';
import type { ApiCallRecord } from '../recorder.js';
import { LeverAdapter } from './index.js';

// Raw response from GET api.lever.co/v0/postings/leverdemo/33538a2f-…?mode=json
// (fetched live 2026-07). Note: `lists` are description content blocks
// ("Qualifications", "Duties"), NOT application questions — the public API
// exposes no application form.
const fixture = JSON.parse(
  readFileSync(new URL('./fixture-leverdemo.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const ref: PlatformRef = {
  platform: 'lever',
  tenant: 'leverdemo',
  externalId: '33538a2f-d27d-4a96-8f05-fa4b0e4d940e',
};
const url =
  'https://jobs.lever.co/leverdemo/33538a2f-d27d-4a96-8f05-fa4b0e4d940e';

const sampleSpec: JobSpec = {
  platform: 'lever',
  tenant: 'leverdemo',
  externalId: '33538a2f-d27d-4a96-8f05-fa4b0e4d940e',
  title: 'Sample',
  applyUrl: `${url}/apply`,
  questions: [],
};

describe('LeverAdapter.discover', () => {
  const adapter = new LeverAdapter();
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

  it('requests the public postings API with mode=json', async () => {
    await adapter.discover(ref, url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.lever.co/v0/postings/leverdemo/33538a2f-d27d-4a96-8f05-fa4b0e4d940e?mode=json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('maps the fixture to a JobSpec', async () => {
    const spec = await adapter.discover(ref, url);
    expect(spec).toEqual({
      platform: 'lever',
      tenant: 'leverdemo',
      externalId: '33538a2f-d27d-4a96-8f05-fa4b0e4d940e',
      title: 'AbelsonTaylor Writer',
      company: 'leverdemo',
      location: 'Arlington, TX',
      applyUrl:
        'https://jobs.lever.co/leverdemo/33538a2f-d27d-4a96-8f05-fa4b0e4d940e/apply',
      questions: [],
    });
  });

  it('NEVER maps description `lists` to questions (truthfulness: no fabrication)', async () => {
    // The fixture has lists: [{text: 'Qualifications', …}, {text: 'Duties', …}]
    expect((fixture.lists as unknown[]).length).toBeGreaterThan(0);
    const spec = await adapter.discover(ref, url);
    expect(spec.questions).toEqual([]);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('does not expose the application form'),
    );
  });

  it('falls back to hostedUrl + /apply when applyUrl is absent', async () => {
    const { applyUrl: _drop, ...withoutApplyUrl } = fixture as {
      applyUrl: string;
      [key: string]: unknown;
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => withoutApplyUrl,
    });
    const spec = await adapter.discover(ref, url);
    expect(spec.applyUrl).toBe(
      'https://jobs.lever.co/leverdemo/33538a2f-d27d-4a96-8f05-fa4b0e4d940e/apply',
    );
  });

  it('throws a descriptive error when tenant is missing', async () => {
    await expect(
      adapter.discover(
        { platform: 'lever', tenant: null, externalId: 'x' },
        url,
      ),
    ).rejects.toThrow(/tenant/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a descriptive error when externalId is missing', async () => {
    await expect(
      adapter.discover(
        { platform: 'lever', tenant: 'leverdemo', externalId: null },
        url,
      ),
    ).rejects.toThrow(/externalId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws with the status code on a non-ok response (lever 404s unknown postings)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ ok: false, error: 'Document not found' }),
    });
    await expect(adapter.discover(ref, url)).rejects.toThrow(/404/);
  });

  it('throws on a 200 response with an unexpected payload shape', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: false }),
    });
    await expect(adapter.discover(ref, url)).rejects.toThrow(
      /unexpected payload/,
    );
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

    expect(spec.title).toBe('AbelsonTaylor Writer');
    expect(recorder).toHaveBeenCalledTimes(1);
    const call = recorder.mock.calls[0]?.[0] as ApiCallRecord;
    expect(call).toMatchObject({
      phase: 'discover',
      method: 'GET',
      url: 'https://api.lever.co/v0/postings/leverdemo/33538a2f-d27d-4a96-8f05-fa4b0e4d940e?mode=json',
      responseStatus: 200,
    });
    expect(call.dryRun).toBeUndefined();
  });
});

describe('LeverAdapter.buildSubmitPayload', () => {
  const adapter = new LeverAdapter();

  it('keys the payload by question id and skips null values', () => {
    const answers: ResolvedAnswer[] = [
      { questionId: 'name', source: 'profile', value: 'Jane' },
      {
        questionId: 'urls[LinkedIn]',
        source: 'bank',
        value: 'https://linkedin.com/in/jane',
      },
      { questionId: 'comments', source: 'default', value: null },
    ];
    expect(adapter.buildSubmitPayload(sampleSpec, answers)).toEqual({
      name: 'Jane',
      'urls[LinkedIn]': 'https://linkedin.com/in/jane',
    });
  });
});

describe('LeverAdapter.dryRunSubmit', () => {
  const adapter = new LeverAdapter();
  const answers: ResolvedAnswer[] = [
    { questionId: 'name', source: 'profile', value: 'Jane' },
    { questionId: 'comments', source: 'default', value: null },
  ];
  const files: SubmitFile[] = [
    {
      questionId: 'resume',
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
      name: 'Jane',
      resume: {
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

describe('LeverAdapter.submit guardrail', () => {
  const adapter = new LeverAdapter();
  const answers: ResolvedAnswer[] = [
    { questionId: 'name', source: 'profile', value: 'Jane' },
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
      expect.stringContaining('DRY RUN — lever submit'),
    );
    // Redaction: the log is a field-key summary, never applicant values.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('fields=['));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
