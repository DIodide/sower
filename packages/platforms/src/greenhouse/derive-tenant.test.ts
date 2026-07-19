import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveGreenhouseTenant,
  greenhouseTenantCandidates,
} from './derive-tenant.js';

describe('greenhouseTenantCandidates', () => {
  it.each([
    // [pageUrl, expected candidates — most specific first]
    [
      'https://akunacapital.com/careers/job/8018853/swe?gh_jid=8018853',
      ['akunacapital', 'akuna'],
    ],
    ['https://www.stripe.com/jobs/search?gh_jid=7031337', ['stripe']],
    ['https://careers.example.com/openings?gh_jid=1', ['example']],
    ['https://jobs.acme-inc.com/role?gh_jid=2', ['acme-inc', 'acme']],
    ['https://apply.acmehq.com/role?gh_jid=3', ['acmehq', 'acme']],
    ['https://acmelabs.co.uk/careers?gh_jid=4', ['acmelabs', 'acme']],
    ['https://acme-labs.com/careers?gh_jid=5', ['acme-labs', 'acme']],
    ['https://www.careers.globex.com/?gh_jid=6', ['globex']],
    ['https://acmetechnologies.io/jobs?gh_jid=7', ['acmetechnologies', 'acme']],
  ])('%s -> %j', (pageUrl, expected) => {
    expect(greenhouseTenantCandidates(pageUrl)).toEqual(expected);
  });

  it('dedupes candidates and caps them at 5', () => {
    const candidates = greenhouseTenantCandidates('https://acme.com/x');
    expect(candidates).toEqual(['acme']);
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates.length).toBeLessThanOrEqual(5);
  });

  it('returns [] for an unparseable URL', () => {
    expect(greenhouseTenantCandidates('not a url')).toEqual([]);
  });
});

describe('deriveGreenhouseTenant', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(status: number, body: unknown) {
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    };
  }

  it('returns the first candidate the fixed boards API verifies by id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 8018853 }));

    const tenant = await deriveGreenhouseTenant(
      'https://akunacapital.com/careers/job/8018853/swe?gh_jid=8018853',
      '8018853',
    );

    expect(tenant).toBe('akunacapital');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The probe target is the HARDCODED greenhouse API origin (no SSRF
    // surface); only the candidate + job id vary in the path.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://boards-api.greenhouse.io/v1/boards/akunacapital/jobs/8018853',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('rejects a 200 whose id does not match the job id (never a blind 200-hit)', async () => {
    // A board that exists but does not own this job could answer 200 for a
    // DIFFERENT posting id — that must not verify the tenant.
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 999 }));

    const tenant = await deriveGreenhouseTenant(
      'https://akunacapital.com/careers?gh_jid=8018853',
      '8018853',
    );

    expect(tenant).toBeNull();
    // Every candidate was still tried before giving up.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls through a 404 to the next candidate', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 8018853 }));

    const tenant = await deriveGreenhouseTenant(
      'https://akunacapital.com/careers?gh_jid=8018853',
      '8018853',
    );

    expect(tenant).toBe('akuna');
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://boards-api.greenhouse.io/v1/boards/akunacapital/jobs/8018853',
      'https://boards-api.greenhouse.io/v1/boards/akuna/jobs/8018853',
    ]);
  });

  it('returns null when every candidate misses', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, {}));

    const tenant = await deriveGreenhouseTenant(
      'https://akunacapital.com/careers?gh_jid=8018853',
      '8018853',
    );

    expect(tenant).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never throws: network errors and non-JSON bodies are misses', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => {
          throw new Error('not json');
        },
      });

    await expect(
      deriveGreenhouseTenant(
        'https://akunacapital.com/careers?gh_jid=8018853',
        '8018853',
      ),
    ).resolves.toBeNull();
  });

  it('returns null without fetching for an unparseable page URL', async () => {
    await expect(
      deriveGreenhouseTenant('not a url', '8018853'),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
