import { readFileSync } from 'node:fs';
import type { JobSpec, PlatformRef, ResolvedAnswer } from '@sower/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmitFile } from '../contract.js';
import type { ApiCallRecord } from '../recorder.js';
import {
  fetchLeverApplicationForm,
  LeverAdapter,
  parseLeverApplicationForm,
} from './index.js';

// Raw response from GET api.lever.co/v0/postings/leverdemo/33538a2f-…?mode=json
// (fetched live 2026-07). `lists` are description content blocks, NOT questions;
// the postings API has no form, so discover parses it from the hosted apply
// page's server-rendered HTML instead (see parseLeverApplicationForm tests).
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
    // The postings fetch reads .json(); the apply-page fetch reads .text().
    // Default: postings JSON + an empty apply page (no form -> 0 questions).
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fixture,
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requests the public postings API with mode=json, then the apply page', async () => {
    await adapter.discover(ref, url);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.lever.co/v0/postings/leverdemo/33538a2f-d27d-4a96-8f05-fa4b0e4d940e?mode=json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // Second call fetches the hosted apply page for the form HTML.
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/apply');
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
      // categories.commitment IS the employment type; categories.department
      // is the department; workplaceType is the arrangement — all verbatim.
      employmentType: 'Regular Full Time (Salary)',
      department: 'Customer Success',
      locationType: 'hybrid',
      applyUrl:
        'https://jobs.lever.co/leverdemo/33538a2f-d27d-4a96-8f05-fa4b0e4d940e/apply',
      questions: [],
      // descriptionHtml/descriptionPlain come straight from the postings API.
      descriptionHtml: fixture.description as string,
      description: fixture.descriptionPlain as string,
    });
  });

  it('falls back to categories.team for department and omits absent metadata', async () => {
    const categories = fixture.categories as Record<string, unknown>;
    const trimmed = {
      ...fixture,
      categories: {
        ...categories,
        commitment: undefined,
        department: undefined,
        team: 'Professional Services',
      },
      workplaceType: undefined,
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => trimmed,
      text: async () => '',
    });

    const spec = await adapter.discover(ref, url);
    expect(spec.department).toBe('Professional Services');
    expect(spec.employmentType).toBeUndefined();
    expect(spec.locationType).toBeUndefined();
  });

  it('NEVER maps description `lists` to questions (truthfulness: no fabrication)', async () => {
    // The fixture has lists: [{text: 'Qualifications', …}, {text: 'Duties', …}]
    expect((fixture.lists as unknown[]).length).toBeGreaterThan(0);
    const spec = await adapter.discover(ref, url);
    expect(spec.questions).toEqual([]);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not read the application form'),
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
      text: async () => '',
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

  it('records the postings discover call and the apply-page form fetch', async () => {
    // Fresh Response per call: postings JSON first, then apply-page HTML.
    let n = 0;
    fetchMock.mockImplementation(async () => {
      n += 1;
      return n === 1
        ? new Response(JSON.stringify(fixture), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response('<html>no form</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
    });
    const recorder = vi.fn();

    const spec = await adapter.discover(ref, url, { recorder });

    expect(spec.title).toBe('AbelsonTaylor Writer');
    expect(recorder).toHaveBeenCalledTimes(2);
    const call = recorder.mock.calls[0]?.[0] as ApiCallRecord;
    expect(call).toMatchObject({
      phase: 'discover',
      method: 'GET',
      url: 'https://api.lever.co/v0/postings/leverdemo/33538a2f-d27d-4a96-8f05-fa4b0e4d940e?mode=json',
      responseStatus: 200,
    });
    expect(call.dryRun).toBeUndefined();
    expect(recorder.mock.calls[1]?.[0]).toMatchObject({
      phase: 'discover_form',
    });
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

describe('parseLeverApplicationForm', () => {
  // Compact but faithful to Lever's server-rendered structure: a required
  // resume, a required text field (✱ marker), a radio select with options, a
  // URL text field followed by an EEO gender select (to prove no option bleed),
  // and a custom survey checkbox multiselect.
  const html = `
    <ul class="application-fields">
    <li class="application-question required"><div class="application-label full-width">Resume/CV ✱</div><div class="application-field"><input type="file" name="resume" required /></div></li>
    <li class="application-question required"><div class="application-label full-width">Full name ✱</div><div class="application-field"><input name="name" required /></div></li>
    <li class="application-question"><div class="application-label full-width multiple-choice"><div class="text">Pronouns</div></div><div class="application-field"><ul data-qa="multiple-choice"><li><label><input type="radio" name="pronouns" value="He/him" /><span class="application-answer-alternative">He/him</span></label></li><li><label><input type="radio" name="pronouns" value="She/her" /><span class="application-answer-alternative">She/her</span></label></li></ul></div></li>
    <li class="application-question"><div class="application-label full-width">Video Link URL</div><div class="application-field"><input name="urls[Video Link ]" /></div></li>
    <li class="application-question"><div class="application-label full-width multiple-choice"><div class="text">What is your ethnicity?</div></div><div class="application-field"><ul data-qa="multiple-choice"><li><label><input type="checkbox" name="surveysResponses[abc][responses][field0]" value="White" /><span class="application-answer-alternative">White</span></label></li><li><label><input type="checkbox" name="surveysResponses[abc][responses][field0]" value="Black" /><span class="application-answer-alternative">Black</span></label></li></ul></div></li>
    </ul></form>
    <select name="eeo[gender]"><option value="M">Male</option><option value="F">Female</option></select>`;

  it('parses fields with correct types, labels, required flags, and options', () => {
    const qs = parseLeverApplicationForm(html);
    const byId = Object.fromEntries(qs.map((q) => [q.id, q]));
    expect(byId.resume).toMatchObject({
      type: 'file',
      required: true,
      label: 'Resume/CV',
    });
    expect(byId.name).toMatchObject({
      type: 'text',
      required: true,
      label: 'Full name',
    });
    expect(byId.pronouns).toMatchObject({ type: 'select', required: false });
    expect(byId.pronouns?.options).toEqual([
      { label: 'He/him', value: 'He/him' },
      { label: 'She/her', value: 'She/her' },
    ]);
    expect(byId['surveysResponses[abc][responses][field0]']).toMatchObject({
      type: 'multiselect',
    });
  });

  it('does NOT bleed a following EEO select into a plain URL text field', () => {
    const byId = Object.fromEntries(
      parseLeverApplicationForm(html).map((q) => [q.id, q]),
    );
    // The Video Link URL field must stay a plain text field even though an
    // eeo[gender] <select> follows it in the document.
    expect(byId['urls[Video Link ]']).toMatchObject({ type: 'text' });
    expect(byId['urls[Video Link ]']?.options).toBeUndefined();
  });

  it('returns [] for markup with no application-question blocks', () => {
    expect(parseLeverApplicationForm('<html><body>nope</body></html>')).toEqual(
      [],
    );
  });

  it('fetchLeverApplicationForm returns [] on a non-200 (never fabricates)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('blocked', { status: 403 })),
    );
    expect(
      await fetchLeverApplicationForm('https://jobs.lever.co/x/y/apply'),
    ).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('fetchLeverApplicationForm parses a 200 HTML response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(html, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );
    const qs = await fetchLeverApplicationForm(
      'https://jobs.lever.co/x/y/apply',
    );
    expect(qs.length).toBeGreaterThanOrEqual(5);
    vi.unstubAllGlobals();
  });
});
