import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Question } from '@sower/core';
import type { Database } from '@sower/db';
import { describe, expect, it, vi } from 'vitest';
import {
  emptyProfile,
  getProfile,
  isEmptyProfile,
  loadProfile,
  type Profile,
} from './profile.js';
import { resolveAnswers } from './resolve.js';

const samplePath = fileURLToPath(
  new URL('../../../config/profile.sample.yaml', import.meta.url),
);

/** A minimal VALID profile, distinguishable from the committed sample. */
function dbProfile(): Profile {
  return {
    name: { first: 'Ada', last: 'Lovelace' },
    email: 'ada@example.com',
    phone: '+1 555 0199',
    location: { city: 'London', state: 'LDN', country: 'UK' },
    links: {},
    education: [],
    work: [],
    authorization: { usWorkAuthorized: true, requiresSponsorship: false },
    custom: {},
  };
}

/** Fake drizzle db whose profiles select resolves `rows` (or rejects). */
function fakeDb(
  rows: Array<{ data: unknown; updatedAt: Date }>,
  opts?: { failWith?: Error },
): Database {
  const chain = {
    from: () => chain,
    // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
    then: (
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) =>
      (opts?.failWith
        ? Promise.reject(opts.failWith)
        : Promise.resolve(rows)
      ).then(onFulfilled, onRejected),
  };
  return { select: () => chain } as unknown as Database;
}

describe('loadProfile', () => {
  it('loads and validates the committed sample profile', () => {
    const profile = loadProfile(samplePath);
    expect(profile.name).toEqual({ first: 'Jane', last: 'Doe' });
    expect(profile.email).toBe('jane.doe@example.com');
    expect(profile.phone).toBe('+1 555 0100');
    expect(profile.location).toEqual({
      city: 'Princeton',
      state: 'NJ',
      country: 'USA',
    });
    expect(profile.links.github).toBe('https://github.com/janedoe');
    expect(profile.education).toHaveLength(1);
    expect(profile.education[0]?.school).toBe('Example University');
    expect(profile.education[0]?.gpa).toBe(3.9);
    expect(profile.work).toHaveLength(1);
    expect(profile.work[0]?.company).toBe('Example Corp');
    expect(profile.authorization).toEqual({
      usWorkAuthorized: true,
      requiresSponsorship: false,
      usCitizen: true,
      usPerson: true,
      hasActiveSecurityClearance: false,
      everEmployedByUSGovernment: false,
    });
    expect(profile.custom).toEqual({});
  });

  it('throws a clear error when the file does not exist', () => {
    expect(() => loadProfile('/nonexistent/profile.yaml')).toThrowError(
      /Failed to read profile file/,
    );
  });

  it('throws a clear error when the file fails schema validation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sower-answers-test-'));
    const badPath = join(dir, 'bad-profile.yaml');
    writeFileSync(badPath, 'name:\n  first: Jane\n', 'utf8');
    expect(() => loadProfile(badPath)).toThrowError(/is invalid/);
    expect(() => loadProfile(badPath)).toThrowError(/email/);
  });
});

describe('emptyProfile / isEmptyProfile', () => {
  it('returns a well-typed empty profile that reads as empty', () => {
    const profile = emptyProfile();
    expect(profile.name).toEqual({ first: '', last: '' });
    expect(profile.email).toBe('');
    expect(profile.education).toEqual([]);
    expect(profile.work).toEqual([]);
    expect(profile.custom).toEqual({});
    expect(isEmptyProfile(profile)).toBe(true);
  });

  it('never mistakes a real (validated) profile for empty', () => {
    expect(isEmptyProfile(loadProfile(samplePath))).toBe(false);
    expect(isEmptyProfile(dbProfile())).toBe(false);
  });
});

describe('getProfile', () => {
  it('prefers the DB row over the fallback file', async () => {
    const db = fakeDb([{ data: dbProfile(), updatedAt: new Date() }]);
    const profile = await getProfile(db, samplePath);
    // The DB profile (Ada) wins — never the file's Jane Doe.
    expect(profile.name.first).toBe('Ada');
    expect(profile.email).toBe('ada@example.com');
  });

  it('uses the newest row by updatedAt when several exist', async () => {
    const older = {
      ...dbProfile(),
      name: { first: 'Old', last: 'Row' },
    };
    const db = fakeDb([
      { data: older, updatedAt: new Date('2026-01-01T00:00:00Z') },
      { data: dbProfile(), updatedAt: new Date('2026-07-01T00:00:00Z') },
    ]);
    const profile = await getProfile(db, samplePath);
    expect(profile.name.first).toBe('Ada');
  });

  it('returns the empty profile (no throw, no file fall-through) for an invalid DB row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = fakeDb([
        { data: { name: { first: 'Ada' } }, updatedAt: new Date() },
      ]);
      // A fallbackPath is provided, but an INVALID row must not silently
      // fall through to a stale file — the row is the source of truth.
      const profile = await getProfile(db, samplePath);
      expect(isEmptyProfile(profile)).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('stored profile row is invalid'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to the file when no row exists', async () => {
    const profile = await getProfile(fakeDb([]), samplePath);
    expect(profile.name.first).toBe('Jane');
  });

  it('returns the empty profile (no throw) when no row exists and the file is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const profile = await getProfile(fakeDb([]), '/nonexistent/profile.yaml');
      expect(isEmptyProfile(profile)).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('profile file fallback failed'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('returns the empty profile when no row exists and no fallbackPath is given', async () => {
    const profile = await getProfile(fakeDb([]));
    expect(isEmptyProfile(profile)).toBe(true);
  });

  it('degrades to the file fallback (no throw) when the DB read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = fakeDb([], { failWith: new Error('connection refused') });
      const profile = await getProfile(db, samplePath);
      expect(profile.name.first).toBe('Jane');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('profile DB read failed'),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('resolution with the empty profile', () => {
  const questions: Question[] = [
    { id: 'first_name', label: 'First Name', type: 'text', required: true },
    {
      id: 'q-auth',
      label: 'Are you authorized to work in the United States?',
      type: 'select',
      required: true,
      options: [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
    },
    { id: 'q-essay', label: 'Why us?', type: 'textarea', required: false },
  ];

  it('never throws and resolves NOTHING from the empty profile', () => {
    const result = resolveAnswers(questions, emptyProfile());
    // The default-false authorization booleans must not fabricate a 'No',
    // and '' identity fields must not fabricate blank answers.
    expect(result.resolved).toEqual([]);
    expect(result.missing.map((q) => q.id)).toEqual([
      'first_name',
      'q-auth',
      'q-essay',
    ]);
  });

  it('still resolves saved bank answers with the empty profile', () => {
    const result = resolveAnswers(questions, emptyProfile(), {
      bank: [{ normalizedLabel: 'why us', value: 'Because rockets.' }],
    });
    expect(result.resolved).toEqual([
      { questionId: 'q-essay', source: 'bank', value: 'Because rockets.' },
    ]);
    expect(result.missing.map((q) => q.id)).toEqual(['first_name', 'q-auth']);
  });
});
