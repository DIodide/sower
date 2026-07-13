import type { WorkdaySession } from '@sower/platforms';
import type { Storage } from '@sower/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  type BrowserLogin,
  SessionBroker,
  SessionVerificationFailedError,
} from './session-broker.js';
import { NotAuthenticatedSessionError } from './session-capture.js';
import {
  loadWorkdaySession,
  saveWorkdaySession,
  sessionStoragePath,
} from './session-store.js';

const authedCookies = [
  { name: 'PLAY_SESSION', value: 'p' },
  { name: 'CALYPSO_SESSION', value: 'c' },
  { name: 'CALYPSO_CSRF_TOKEN', value: 'csrf-1' },
];

const input = {
  host: 'datasite.wd1.myworkdayjobs.com',
  tenant: 'datasite',
  loginUrl: 'https://datasite.wd1.myworkdayjobs.com/en-US/datasite/login',
  credential: { email: 'ibraheem.amin2@gmail.com', password: 'pw' },
};

function loginReturning(cookies: typeof authedCookies): BrowserLogin {
  return vi.fn(async () => ({ cookies }));
}

describe('SessionBroker.capture — verify before store', () => {
  it('captures, verifies, and stores an authenticated session', async () => {
    const storeSession = vi.fn(async () => {});
    const broker = new SessionBroker({
      login: loginReturning(authedCookies),
      storeSession,
      verify: async () => true,
      now: () => '2026-07-13T00:00:00.000Z',
    });

    const session = await broker.capture(input);

    expect(session.tenant).toBe('datasite');
    expect(session.csrfToken).toBe('csrf-1');
    expect(session.capturedAt).toBe('2026-07-13T00:00:00.000Z');
    expect(storeSession).toHaveBeenCalledWith(session);
  });

  it('does NOT store a session that fails live verification', async () => {
    const storeSession = vi.fn(async () => {});
    const broker = new SessionBroker({
      login: loginReturning(authedCookies),
      storeSession,
      verify: async () => false,
    });

    await expect(broker.capture(input)).rejects.toBeInstanceOf(
      SessionVerificationFailedError,
    );
    expect(storeSession).not.toHaveBeenCalled();
  });

  it('does NOT store when the login did not authenticate (no CSRF cookie)', async () => {
    const storeSession = vi.fn(async () => {});
    const verify = vi.fn(async () => true);
    const broker = new SessionBroker({
      login: loginReturning([{ name: '__cf_bm', value: 'x' }]),
      storeSession,
      verify,
    });

    await expect(broker.capture(input)).rejects.toBeInstanceOf(
      NotAuthenticatedSessionError,
    );
    // Verification is never even attempted on a non-authenticated capture.
    expect(verify).not.toHaveBeenCalled();
    expect(storeSession).not.toHaveBeenCalled();
  });
});

function fakeStorage(): Storage & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async put(path, data) {
      objects.set(path, Buffer.from(data));
    },
    async get(path) {
      const v = objects.get(path);
      if (!v) throw new Error(`no object at ${path}`);
      return v;
    },
    async exists(path) {
      return objects.has(path);
    },
  };
}

describe('session store', () => {
  const session: WorkdaySession = {
    host: 'datasite.wd1.myworkdayjobs.com',
    tenant: 'datasite',
    cookie: 'PLAY_SESSION=p; CALYPSO_CSRF_TOKEN=csrf-1',
    csrfToken: 'csrf-1',
    capturedAt: '2026-07-13T00:00:00.000Z',
  };

  it('round-trips a session through the vault', async () => {
    const storage = fakeStorage();
    await saveWorkdaySession(storage, session);
    expect(storage.objects.has('accounts/workday/datasite/session.json')).toBe(
      true,
    );
    const loaded = await loadWorkdaySession(storage, 'datasite');
    expect(loaded).toEqual(session);
  });

  it('returns null when no session is stored', async () => {
    expect(await loadWorkdaySession(fakeStorage(), 'nope')).toBeNull();
  });

  it('rejects an unsafe tenant in the path', () => {
    expect(() => sessionStoragePath('../etc')).toThrow(/invalid tenant/);
  });
});
