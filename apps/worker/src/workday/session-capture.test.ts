import { describe, expect, it } from 'vitest';
import {
  type BrowserCookie,
  captureWorkdaySession,
  isSessionFresh,
  NotAuthenticatedSessionError,
} from './session-capture.js';

const authedCookies: BrowserCookie[] = [
  { name: 'PLAY_SESSION', value: 'play-abc' },
  { name: 'CALYPSO_SESSION', value: 'cal-def' },
  { name: 'CALYPSO_CSRF_TOKEN', value: 'csrf-uuid' },
  { name: '__cf_bm', value: 'cf-bot-cookie' },
  { name: 'wd-browser-id', value: 'wdb' },
];

describe('captureWorkdaySession', () => {
  it('builds a session with the cookie header + CSRF derived from the cookie', () => {
    const s = captureWorkdaySession(
      'datasite.wd1.myworkdayjobs.com',
      'datasite',
      authedCookies,
      '2026-07-13T00:00:00.000Z',
    );
    expect(s.host).toBe('datasite.wd1.myworkdayjobs.com');
    expect(s.tenant).toBe('datasite');
    expect(s.csrfToken).toBe('csrf-uuid');
    expect(s.capturedAt).toBe('2026-07-13T00:00:00.000Z');
    // Carries Cloudflare + all cookies (dropping __cf_bm can trip bot mgmt).
    expect(s.cookie).toContain('PLAY_SESSION=play-abc');
    expect(s.cookie).toContain('__cf_bm=cf-bot-cookie');
    expect(s.cookie).toContain('CALYPSO_CSRF_TOKEN=csrf-uuid');
  });

  it('throws when the CSRF cookie is absent (login not complete)', () => {
    const cookies = authedCookies.filter(
      (c) => c.name !== 'CALYPSO_CSRF_TOKEN',
    );
    expect(() =>
      captureWorkdaySession('h', 't', cookies, '2026-07-13T00:00:00Z'),
    ).toThrow(NotAuthenticatedSessionError);
  });

  it('throws when no auth-session cookie is present (only pre-login cookies)', () => {
    const cookies: BrowserCookie[] = [
      { name: 'CALYPSO_CSRF_TOKEN', value: 'csrf' },
      { name: '__cf_bm', value: 'cf' },
    ];
    expect(() =>
      captureWorkdaySession('h', 't', cookies, '2026-07-13T00:00:00Z'),
    ).toThrow(/PLAY_SESSION or CALYPSO_SESSION/);
  });
});

describe('isSessionFresh', () => {
  const now = Date.parse('2026-07-13T00:30:00.000Z');

  it('is fresh within the max age', () => {
    expect(
      isSessionFresh({ capturedAt: '2026-07-13T00:20:00.000Z' }, now),
    ).toBe(true);
  });

  it('is stale beyond the max age (default 20 min)', () => {
    expect(
      isSessionFresh({ capturedAt: '2026-07-13T00:05:00.000Z' }, now),
    ).toBe(false);
  });

  it('treats a missing/invalid capturedAt as stale', () => {
    expect(isSessionFresh({ capturedAt: undefined }, now)).toBe(false);
    expect(isSessionFresh({ capturedAt: 'not-a-date' }, now)).toBe(false);
  });
});
