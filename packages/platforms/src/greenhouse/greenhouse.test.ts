import { readFileSync } from 'node:fs';
import type {
  JobSpec,
  PlatformRef,
  Question,
  ResolvedAnswer,
} from '@sower/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmitFile } from '../contract.js';
import type { ApiCallRecord } from '../recorder.js';
import { GreenhouseAdapter } from './index.js';

// Raw response from GET boards-api.greenhouse.io/v1/boards/stripe/jobs/7954688?questions=true
const fixture = JSON.parse(
  readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

// Raw response from GET boards-api.greenhouse.io/v1/boards/stripe/jobs/7893199?questions=true
// Has location_questions with input_hidden fields and a demographic_questions section.
const stripeLocationFixture = JSON.parse(
  readFileSync(
    new URL('./fixture-stripe-location.json', import.meta.url),
    'utf8',
  ),
) as Record<string, unknown>;

// Raw response from GET boards-api.greenhouse.io/v1/boards/gitlab/jobs/8565469002?questions=true
// Has compliance (EEOC) questions with string option values and multi-field
// Resume/CV + Cover Letter questions with textarea alternates.
const gitlabFixture = JSON.parse(
  readFileSync(new URL('./fixture-gitlab.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const ref: PlatformRef = {
  platform: 'greenhouse',
  tenant: 'stripe',
  externalId: '7954688',
};
const url = 'https://boards.greenhouse.io/stripe/jobs/7954688';

const sampleSpec: JobSpec = {
  platform: 'greenhouse',
  tenant: 'stripe',
  externalId: '7954688',
  title: 'Sample',
  applyUrl: url,
  questions: [],
};

function findQuestion(spec: JobSpec, id: string): Question {
  const question = spec.questions.find((q) => q.id === id);
  if (!question) {
    throw new Error(`question ${id} not found in spec`);
  }
  return question;
}

describe('GreenhouseAdapter.discover', () => {
  const adapter = new GreenhouseAdapter();
  let fetchMock: ReturnType<typeof vi.fn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fixture,
    });
    vi.stubGlobal('fetch', fetchMock);
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requests the boards API with questions=true', async () => {
    await adapter.discover(ref, url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://boards-api.greenhouse.io/v1/boards/stripe/jobs/7954688?questions=true',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('maps the fixture to a JobSpec', async () => {
    const spec = await adapter.discover(ref, url);
    expect(spec.platform).toBe('greenhouse');
    expect(spec.tenant).toBe('stripe');
    expect(spec.externalId).toBe('7954688');
    expect(spec.title).toBe('Account Executive, AI Sales (Grower)');
    expect(spec.company).toBe('Stripe');
    expect(spec.location).toBe('San Francisco, CA');
    expect(spec.applyUrl).toBe('https://stripe.com/jobs/search?gh_jid=7954688');
  });

  it('flattens questions, location_questions, and compliance questions', async () => {
    const spec = await adapter.discover(ref, url);
    // 17 questions (2 of which have a textarea alternate) + 3
    // location_questions (2 hidden-only, omitted) + 4 compliance questions
    expect(spec.questions).toHaveLength(24);
    // location_questions then compliance questions are appended after the
    // main questions
    expect(spec.questions.slice(19).map((q) => q.id)).toEqual([
      'location',
      'disability_status',
      'veteran_status',
      'race',
      'gender',
    ]);
  });

  it('maps input_text to text with the field name as id', async () => {
    const spec = await adapter.discover(ref, url);
    const question = findQuestion(spec, 'first_name');
    expect(question).toEqual({
      id: 'first_name',
      label: 'First Name',
      type: 'text',
      required: true,
    });
  });

  it('maps input_file to file and preserves required=false', async () => {
    const spec = await adapter.discover(ref, url);
    const question = findQuestion(spec, 'resume');
    expect(question.type).toBe('file');
    expect(question.required).toBe(false);
    expect(question.options).toBeUndefined();
  });

  it('maps multi_value_single_select to select with {label, value} options', async () => {
    const spec = await adapter.discover(ref, url);
    const question = findQuestion(spec, 'question_67165645');
    expect(question.type).toBe('select');
    expect(question.required).toBe(true);
    expect(question.options).toHaveLength(29);
    expect(question.options?.[0]).toEqual({
      label: 'Australia',
      value: 724302171,
    });
  });

  it('maps multi_value_multi_select to multiselect', async () => {
    const spec = await adapter.discover(ref, url);
    const question = findQuestion(spec, 'question_67165646[]');
    expect(question.type).toBe('multiselect');
    expect(question.options).toHaveLength(29);
  });

  it('omits input_hidden fields: hidden-only questions disappear entirely', async () => {
    const spec = await adapter.discover(ref, url);
    // Longitude/Latitude location_questions only contain machine-populated
    // input_hidden fields — they must never surface as human questions.
    expect(spec.questions.find((q) => q.id === 'longitude')).toBeUndefined();
    expect(spec.questions.find((q) => q.id === 'latitude')).toBeUndefined();
    // The human-facing Location question survives.
    expect(findQuestion(spec, 'location')).toEqual({
      id: 'location',
      label: 'Location',
      type: 'text',
      required: true,
    });
    // Omissions are logged for debuggability.
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('"Longitude"'),
    );
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('"Latitude"'),
    );
  });

  it('emits additional non-hidden fields as optional alternate questions', async () => {
    const spec = await adapter.discover(ref, url);
    // Resume/CV has fields [resume (input_file), resume_text (textarea)]
    const primary = findQuestion(spec, 'resume');
    expect(primary.label).toBe('Resume/CV');
    expect(primary.type).toBe('file');
    const alternate = findQuestion(spec, 'resume_text');
    expect(alternate).toEqual({
      id: 'resume_text',
      label: 'Resume/CV (alternate: resume_text)',
      type: 'textarea',
      required: false,
    });
    // The alternate directly follows its primary.
    const ids = spec.questions.map((q) => q.id);
    expect(ids.indexOf('resume_text')).toBe(ids.indexOf('resume') + 1);
    expect(findQuestion(spec, 'cover_letter_text').label).toBe(
      'Cover Letter (alternate: cover_letter_text)',
    );
  });

  it('includes compliance questions as selects with string option values', async () => {
    const spec = await adapter.discover(ref, url);
    const question = findQuestion(spec, 'disability_status');
    expect(question.type).toBe('select');
    expect(question.required).toBe(false);
    expect(question.options?.[0]).toEqual({
      label: 'I do not want to answer',
      value: '3',
    });
    expect(
      question.options?.every((option) => typeof option.value === 'string'),
    ).toBe(true);
  });

  it('throws a descriptive error when tenant is missing', async () => {
    await expect(
      adapter.discover(
        { platform: 'greenhouse', tenant: null, externalId: '7954688' },
        url,
      ),
    ).rejects.toThrow(/tenant/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a descriptive error when externalId is missing', async () => {
    await expect(
      adapter.discover(
        { platform: 'greenhouse', tenant: 'stripe', externalId: null },
        url,
      ),
    ).rejects.toThrow(/externalId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes the recorder through recordedFetch and records exactly one call', async () => {
    // Use a real Response so the recorder can clone and capture the body.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const recorder = vi.fn();

    const spec = await adapter.discover(ref, url, { recorder });

    expect(spec.title).toBe('Account Executive, AI Sales (Grower)');
    expect(recorder).toHaveBeenCalledTimes(1);
    const call = recorder.mock.calls[0]?.[0] as ApiCallRecord;
    expect(call).toMatchObject({
      phase: 'discover',
      method: 'GET',
      url: 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs/7954688?questions=true',
      responseStatus: 200,
    });
    expect(call.durationMs).toBeGreaterThanOrEqual(0);
    expect(call.dryRun).toBeUndefined();
  });

  it('throws with the status code on a non-ok response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    await expect(adapter.discover(ref, url)).rejects.toThrow(/404/);
  });
});

describe('GreenhouseAdapter.discover — stripe location/demographic fixture', () => {
  const adapter = new GreenhouseAdapter();
  const locationRef: PlatformRef = {
    platform: 'greenhouse',
    tenant: 'stripe',
    externalId: '7893199',
  };
  const locationUrl = 'https://boards.greenhouse.io/stripe/jobs/7893199';

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => stripeLocationFixture,
      }),
    );
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('omits hidden longitude/latitude location fields', async () => {
    const spec = await adapter.discover(locationRef, locationUrl);
    const ids = spec.questions.map((q) => q.id);
    expect(ids).not.toContain('longitude');
    expect(ids).not.toContain('latitude');
    expect(ids).toContain('location');
    // 19 questions (2 with textarea alternates) + 1 visible location
    // question + 0 compliance + 1 demographic
    expect(spec.questions).toHaveLength(23);
  });

  it('maps demographic_questions to Questions with numeric option values', async () => {
    const spec = await adapter.discover(locationRef, locationUrl);
    const question = findQuestion(spec, 'demographic_question_591[]');
    expect(question).toEqual({
      id: 'demographic_question_591[]',
      label: 'Gender',
      type: 'multiselect',
      required: false,
      options: [
        { label: 'Male', value: 3098 },
        { label: 'Female', value: 3251 },
        { label: 'Decline to Self Identify', value: 3250 },
      ],
    });
    // Demographic questions are appended last.
    expect(spec.questions.at(-1)?.id).toBe('demographic_question_591[]');
  });
});

describe('GreenhouseAdapter.discover — gitlab compliance fixture', () => {
  const adapter = new GreenhouseAdapter();
  const gitlabRef: PlatformRef = {
    platform: 'greenhouse',
    tenant: 'gitlab',
    externalId: '8565469002',
  };
  const gitlabUrl = 'https://job-boards.greenhouse.io/gitlab/jobs/8565469002';

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => gitlabFixture,
      }),
    );
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps a required primary and emits an optional textarea alternate for Resume/CV', async () => {
    const spec = await adapter.discover(gitlabRef, gitlabUrl);
    expect(findQuestion(spec, 'resume')).toEqual({
      id: 'resume',
      label: 'Resume/CV',
      type: 'file',
      required: true,
    });
    expect(findQuestion(spec, 'resume_text')).toEqual({
      id: 'resume_text',
      label: 'Resume/CV (alternate: resume_text)',
      type: 'textarea',
      required: false,
    });
    expect(findQuestion(spec, 'cover_letter_text')).toEqual({
      id: 'cover_letter_text',
      label: 'Cover Letter (alternate: cover_letter_text)',
      type: 'textarea',
      required: false,
    });
  });

  it('includes all EEOC compliance questions with string option values', async () => {
    const spec = await adapter.discover(gitlabRef, gitlabUrl);
    const ids = spec.questions.map((q) => q.id);
    expect(ids.slice(-4)).toEqual([
      'disability_status',
      'veteran_status',
      'race',
      'gender',
    ]);
    for (const id of [
      'disability_status',
      'veteran_status',
      'race',
      'gender',
    ]) {
      const question = findQuestion(spec, id);
      expect(question.type).toBe('select');
      expect(question.options?.length).toBeGreaterThan(0);
      expect(
        question.options?.every((option) => typeof option.value === 'string'),
      ).toBe(true);
    }
    // 17 questions (2 with textarea alternates) + 4 compliance questions
    expect(spec.questions).toHaveLength(23);
  });
});

describe('GreenhouseAdapter.discover — field type edge cases', () => {
  const adapter = new GreenhouseAdapter();

  function stubPayload(questions: unknown[]): void {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          title: 'Synthetic',
          absolute_url: 'https://example.com/jobs/1',
          questions,
        }),
      }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('maps unknown field types WITH values to select so option matching applies', async () => {
    stubPayload([
      {
        label: 'Pronouns',
        required: true,
        fields: [
          {
            name: 'pronouns',
            type: 'some_future_widget',
            values: [
              { label: 'She/Her', value: 1 },
              { label: 'He/Him', value: 2 },
            ],
          },
        ],
      },
    ]);
    const spec = await adapter.discover(ref, url);
    expect(spec.questions).toEqual([
      {
        id: 'pronouns',
        label: 'Pronouns',
        type: 'select',
        required: true,
        options: [
          { label: 'She/Her', value: 1 },
          { label: 'He/Him', value: 2 },
        ],
      },
    ]);
  });

  it('maps unknown field types WITHOUT values to text', async () => {
    stubPayload([
      {
        label: 'Signature',
        required: false,
        fields: [{ name: 'signature', type: 'input_signature' }],
      },
    ]);
    const spec = await adapter.discover(ref, url);
    expect(spec.questions).toEqual([
      { id: 'signature', label: 'Signature', type: 'text', required: false },
    ]);
  });

  it('omits hidden-only questions and logs a debug message', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    stubPayload([
      {
        label: 'Tracking Token',
        required: true,
        fields: [{ name: 'tracking_token', type: 'input_hidden' }],
      },
    ]);
    const spec = await adapter.discover(ref, url);
    expect(spec.questions).toEqual([]);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('tracking_token'),
    );
  });

  it('skips hidden fields inside mixed questions without demoting the primary', async () => {
    stubPayload([
      {
        label: 'Location',
        required: true,
        fields: [
          { name: 'internal_geo', type: 'input_hidden' },
          { name: 'location', type: 'input_text' },
        ],
      },
    ]);
    const spec = await adapter.discover(ref, url);
    expect(spec.questions).toEqual([
      { id: 'location', label: 'Location', type: 'text', required: true },
    ]);
  });
});

describe('GreenhouseAdapter.buildSubmitPayload', () => {
  const adapter = new GreenhouseAdapter();

  it('keys the payload by question id and skips null values', () => {
    const answers: ResolvedAnswer[] = [
      { questionId: 'first_name', source: 'profile', value: 'Jane' },
      {
        questionId: 'question_67165646[]',
        source: 'bank',
        value: ['United States'],
      },
      { questionId: 'cover_letter', source: 'default', value: null },
    ];
    expect(adapter.buildSubmitPayload(sampleSpec, answers)).toEqual({
      first_name: 'Jane',
      'question_67165646[]': ['United States'],
    });
  });
});

describe('GreenhouseAdapter.dryRunSubmit', () => {
  const adapter = new GreenhouseAdapter();
  const answers: ResolvedAnswer[] = [
    { questionId: 'first_name', source: 'profile', value: 'Jane' },
    { questionId: 'question_67165646[]', source: 'bank', value: ['US'] },
    { questionId: 'cover_letter_text', source: 'default', value: null },
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

  it('returns the payload with answers keyed by question id and file metadata', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const result = await adapter.dryRunSubmit(sampleSpec, answers, files);

    expect(result.dryRun).toBe(true);
    expect(result.payload).toEqual({
      first_name: 'Jane',
      'question_67165646[]': ['US'],
      resume: {
        kind: 'file',
        filename: 'resume.pdf',
        storagePath:
          'documents/00000000-0000-4000-8000-000000000000/resume.pdf',
      },
    });
  });

  it('file metadata wins over a storage-path answer for the same question', async () => {
    const withDocAnswer: ResolvedAnswer[] = [
      ...answers,
      { questionId: 'resume', source: 'profile', value: 'stale-path' },
    ];

    const result = await adapter.dryRunSubmit(sampleSpec, withDocAnswer, files);

    expect(result.payload.resume).toEqual({
      kind: 'file',
      filename: 'resume.pdf',
      storagePath: 'documents/00000000-0000-4000-8000-000000000000/resume.pdf',
    });
  });

  it('records exactly one dryRun submit_dryrun call via the recorder', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const recorder = vi.fn();

    const result = await adapter.dryRunSubmit(sampleSpec, answers, files, {
      recorder,
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
    expect(result.payload.first_name).toBe('Jane');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('GreenhouseAdapter.submit guardrail', () => {
  const adapter = new GreenhouseAdapter();
  const answers: ResolvedAnswer[] = [
    { questionId: 'first_name', source: 'profile', value: 'Jane' },
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
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
