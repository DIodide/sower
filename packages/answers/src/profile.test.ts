import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadProfile } from './profile.js';

const samplePath = fileURLToPath(
  new URL('../../../config/profile.sample.yaml', import.meta.url),
);

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
