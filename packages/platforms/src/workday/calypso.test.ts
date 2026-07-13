import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CalypsoClient,
  WorkdayFinalizeGateError,
  type WorkdaySession,
  WorkdaySessionExpiredError,
} from './calypso.js';
import {
  buildEmailSection,
  buildNameSection,
  buildPhoneSection,
  WORKDAY_REF,
} from './calypso-sections.js';

// The real CACI `GET .../questionnaire/{id}` response (questions + options).
const questionnaireFixture = readFileSync(
  new URL('./fixture-questionnaire-caci.json', import.meta.url),
  'utf8',
);

const session: WorkdaySession = {
  host: 'datasite.wd1.myworkdayjobs.com',
  tenant: 'datasite',
  cookie: 'PLAY_SESSION=abc; CALYPSO_SESSION=def; CALYPSO_CSRF_TOKEN=tok',
  csrfToken: 'tok',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CalypsoClient — transport', () => {
  it('startApplication POSTs the plural jobapplications endpoint with auth', async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) =>
      jsonResponse({ id: 'JAID-1' }),
    );
    const client = new CalypsoClient(session, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await client.startApplication('IT-Asset_R1');

    expect(result).toEqual({ jobApplicationId: 'JAID-1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://datasite.wd1.myworkdayjobs.com/wday/cxs/datasite/jobpostings/IT-Asset_R1/jobapplications',
    );
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.cookie).toContain('PLAY_SESSION');
    expect(headers['x-calypso-csrf-token']).toBe('tok');
  });

  it('getQuestionnaire GETs the questionnaire and parses fields WITH options', async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) =>
      jsonResponse(questionnaireFixture),
    );
    const client = new CalypsoClient(session, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const fields = await client.getQuestionnaire('Q1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // GET (not the /definition POST), and options come back attached.
    expect(url).toBe(
      'https://datasite.wd1.myworkdayjobs.com/wday/calypso/cxs/common/datasite/questionnaire/Q1',
    );
    expect(init.method).toBe('GET');
    expect(fields.length).toBeGreaterThanOrEqual(9);
    expect(fields.some((f) => f.control === 'select' && f.options)).toBe(true);
  });

  it('fillSection POSTs the section body and never targets finalize', async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) =>
      jsonResponse({ ok: true }),
    );
    const client = new CalypsoClient(session, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.fillSection('JAID-1', 'name', buildNameSection('Ada', 'L'));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://datasite.wd1.myworkdayjobs.com/wday/calypso/cxs/jobapplication/datasite/jobapplication/JAID-1/name',
    );
    expect(url).not.toContain('finalize');
    expect(JSON.parse(init.body as string)).toMatchObject({
      legalName: { firstName: 'Ada', lastName: 'L' },
    });
  });

  it('validate PUTs the package validate endpoint', async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) =>
      jsonResponse({}),
    );
    const client = new CalypsoClient(session, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await client.validate('JAID-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(url).toContain('/package/JAID-1/validate');
  });

  it('maps 401/403 to WorkdaySessionExpiredError', async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) =>
      jsonResponse({}, 403),
    );
    const client = new CalypsoClient(session, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(client.startApplication('x')).rejects.toBeInstanceOf(
      WorkdaySessionExpiredError,
    );
  });
});

describe('CalypsoClient.uploadResume — two-step attachment flow', () => {
  it('multipart-uploads the bytes then JSON-attaches with the returned file ref', async () => {
    const fetchMock = vi.fn(async (u: string, _i?: RequestInit) => {
      if (u.endsWith('/common/datasite/attachments')) {
        return jsonResponse({
          file: 'oms-attachments/ref-1',
          fileName: 'r.pdf',
          fileLength: 3,
          contentType: { id: 'Content_Type_ID=application/pdf' },
        });
      }
      return jsonResponse('', 200); // resumeattachments echoes empty
    });
    const client = new CalypsoClient(session, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.uploadResume('JAID-9', {
      fileName: 'r.pdf',
      contentType: 'application/pdf',
      bytes: new Uint8Array([1, 2, 3]),
    });

    // Step 1: multipart POST to common/{tenant}/attachments — NO json
    // content-type (fetch derives the boundary), FormData body, session auth.
    const [u1, i1] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(u1).toBe(
      'https://datasite.wd1.myworkdayjobs.com/wday/calypso/cxs/common/datasite/attachments',
    );
    expect(i1.method).toBe('POST');
    const h1 = i1.headers as Record<string, string>;
    expect(h1['content-type']).toBeUndefined();
    expect(h1['x-calypso-csrf-token']).toBe('tok');
    expect(i1.body).toBeInstanceOf(FormData);

    // Step 2: JSON attach to the application's resumeattachments, referencing
    // the oms file ref returned by step 1 (verbatim body shape from the HAR).
    const [u2, i2] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(u2).toBe(
      'https://datasite.wd1.myworkdayjobs.com/wday/calypso/cxs/jobapplication/datasite/jobapplication/JAID-9/resumeattachments',
    );
    expect(JSON.parse(i2.body as string)).toEqual({
      attachments: [
        {
          fileName: 'r.pdf',
          fileLength: 3,
          contentType: { id: 'Content_Type_ID=application/pdf' },
          file: 'oms-attachments/ref-1',
        },
      ],
    });
  });

  it('throws when the upload response carries no file reference', async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) =>
      jsonResponse({ nope: true }),
    );
    const client = new CalypsoClient(session, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(
      client.uploadResume('JAID-9', {
        fileName: 'r.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow(/no attachment file reference/);
  });

  it('throws WorkdaySessionExpiredError on a 401 upload', async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) =>
      jsonResponse('', 401),
    );
    const client = new CalypsoClient(session, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(
      client.uploadResume('JAID-9', {
        fileName: 'r.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toBeInstanceOf(WorkdaySessionExpiredError);
  });
});

describe('CalypsoClient.finalize — double gate', () => {
  it('throws (and never calls fetch) when SOWER_SUBMIT_ENABLED is not "true"', async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) =>
      jsonResponse({}),
    );
    const client = new CalypsoClient(session, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      env: {},
    });
    await expect(client.finalize('JAID-1')).rejects.toBeInstanceOf(
      WorkdayFinalizeGateError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs finalize only when the gate is open', async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) =>
      jsonResponse({}),
    );
    const client = new CalypsoClient(session, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      env: { SOWER_SUBMIT_ENABLED: 'true' },
    });
    const result = await client.finalize('JAID-1');
    expect(result).toEqual({ submitted: true });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      'https://datasite.wd1.myworkdayjobs.com/wday/cxs/datasite/jobapplication/JAID-1/finalize',
    );
  });
});

describe('CalypsoClient.checkSession — verify primitive', () => {
  it('returns true on a 200 read', async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) =>
      jsonResponse({ total: 0, data: [] }),
    );
    const client = new CalypsoClient(session, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(await client.checkSession()).toBe(true);
    const [url] = fetchMock.mock.calls[0] as [string];
    // userprofile (NOT applications, which 500s on an empty candidate home).
    expect(url).toContain('/candidatehome/datasite/datasite/userprofile');
  });

  it('returns false on an error (e.g. datasite 500 for an expired session)', async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) =>
      jsonResponse({}, 500),
    );
    const client = new CalypsoClient(session, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(await client.checkSession()).toBe(false);
  });
});

describe('calypso section builders', () => {
  it('buildNameSection uses the US country GUID', () => {
    expect(buildNameSection('Ada', 'Lovelace')).toEqual({
      legalName: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        country: { id: WORKDAY_REF.US_COUNTRY },
      },
      preferredCheck: false,
    });
  });

  it('buildEmailSection wraps the email', () => {
    expect(buildEmailSection('a@b.com')).toEqual({ emailAddress: 'a@b.com' });
  });

  it('buildPhoneSection strips non-digits and sets the US phone code', () => {
    const p = buildPhoneSection('+1 (978) 555-0142');
    expect(p).toMatchObject({
      countryPhoneCode: { id: WORKDAY_REF.US_PHONE_CODE },
      phoneNumber: '19785550142',
    });
  });
});
