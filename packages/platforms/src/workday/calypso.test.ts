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

const questionnaireFixture = readFileSync(
  new URL('./fixture-questionnaire-definition.json', import.meta.url),
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

  it('getQuestionnaire fetches the definition and parses it to fields', async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) =>
      jsonResponse(questionnaireFixture),
    );
    const client = new CalypsoClient(session, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const fields = await client.getQuestionnaire('Q1');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      'https://datasite.wd1.myworkdayjobs.com/wday/calypso/cxs/common/datasite/questionnaire/Q1/definition',
    );
    expect(fields).toHaveLength(6);
    expect(fields.map((f) => f.control)).toContain('select');
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
    expect(url).toContain('/candidatehome/datasite/datasite/applications');
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
