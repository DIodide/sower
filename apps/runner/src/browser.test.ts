import type { Browser, Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { findSessionPage, normalizeUrlForMatch } from './browser.js';
import type { OpenTabSession } from './opentab-client.js';

/**
 * findSessionPage against fake pages: the targetId probe always detaches
 * its CDP session (a finally, even when the probe throws), and the URL
 * fallback compares origin+pathname so greenhouse's gh_* redirect params
 * and trailing slashes never defeat the match.
 */

const session: OpenTabSession = {
  id: 's_ab12cd',
  isolation: 'context',
  profile: 'default',
  headless: true,
  instanceId: 'i_default_headless',
  targetId: 'TARGET-1',
  browserContextId: 'CTX42',
  url: 'https://job-boards.greenhouse.io/acme/jobs/123',
  createdAt: '2026-08-28T00:00:00.000Z',
  expiresAt: null,
  urls: {
    cdp_ws: 'ws://127.0.0.1:9333/t/tok/s/s_ab12cd',
    browser_http: 'http://127.0.0.1:9333/t/tok/i/i_default_headless',
    browser_ws:
      'ws://127.0.0.1:9333/t/tok/i/i_default_headless/devtools/browser/uuid',
    devtools:
      'http://127.0.0.1:9333/t/tok/devtools-frontend/@abc/inspector.html?ws=127.0.0.1:9333/t/tok/s/s_ab12cd',
    live_view: 'http://127.0.0.1:9333/t/tok/view/s/s_ab12cd',
  },
};

interface FakeCdp {
  send: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
}

/** null targetId = the probe throws (page closing mid-scan). */
function fakeCdp(targetId: string | null): FakeCdp {
  return {
    send: vi.fn(async () => {
      if (targetId === null) {
        throw new Error('target crashed');
      }
      return { targetInfo: { targetId } };
    }),
    detach: vi.fn(async () => {}),
  };
}

function fakePage(url: string, cdp: FakeCdp): Page {
  return {
    url: () => url,
    context: () => ({ newCDPSession: async () => cdp }),
  } as unknown as Page;
}

function fakeBrowser(pages: Page[]): Browser {
  return { contexts: () => [{ pages: () => pages }] } as unknown as Browser;
}

describe('normalizeUrlForMatch', () => {
  it('drops query strings and trailing slashes', () => {
    expect(
      normalizeUrlForMatch(
        'https://job-boards.greenhouse.io/acme/jobs/123/?gh_src=abc123&gh_jid=123',
      ),
    ).toBe('https://job-boards.greenhouse.io/acme/jobs/123');
  });

  it('keeps distinct paths distinct', () => {
    expect(normalizeUrlForMatch('https://a.example/x')).not.toBe(
      normalizeUrlForMatch('https://a.example/y'),
    );
  });

  it('is null for a non-URL', () => {
    expect(normalizeUrlForMatch('not a url')).toBeNull();
  });
});

describe('findSessionPage', () => {
  it('matches by targetId and detaches the probe session', async () => {
    const cdp = fakeCdp('TARGET-1');
    const page = fakePage('https://elsewhere.example/x', cdp);
    const found = await findSessionPage(fakeBrowser([page]), session);
    expect(found).toBe(page);
    expect(cdp.detach).toHaveBeenCalledTimes(1);
  });

  it('detaches even when the probe throws, then matches the normalized URL', async () => {
    const cdp = fakeCdp(null);
    const page = fakePage(
      'https://job-boards.greenhouse.io/acme/jobs/123/?gh_src=abc123',
      cdp,
    );
    const found = await findSessionPage(fakeBrowser([page]), session);
    expect(found).toBe(page);
    expect(cdp.detach).toHaveBeenCalledTimes(1);
  });
});
