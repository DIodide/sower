import { describe, expect, it } from 'vitest';
import { parseSocketUrl } from './index.js';

describe('parseSocketUrl', () => {
  it('parses the Cloud SQL unix-socket form', () => {
    const parsed = parseSocketUrl(
      'postgres://sower-app:s3cret@localhost/sower?host=/cloudsql/sower-production:us-east1:sower-pg',
    );
    expect(parsed).toEqual({
      host: '/cloudsql/sower-production:us-east1:sower-pg',
      database: 'sower',
      username: 'sower-app',
      password: 's3cret',
    });
  });

  it('decodes percent-encoded credentials', () => {
    const parsed = parseSocketUrl('postgres://user%40x:p%23ss@localhost/db?host=/cloudsql/a:b:c');
    expect(parsed).toEqual({
      host: '/cloudsql/a:b:c',
      database: 'db',
      username: 'user@x',
      password: 'p#ss',
    });
  });

  it('returns null for plain TCP URLs', () => {
    expect(parseSocketUrl('postgres://postgres:sower@localhost:5432/sower')).toBeNull();
  });

  it('returns null when host param is not an absolute path', () => {
    expect(parseSocketUrl('postgres://u:p@localhost/db?host=example.com')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseSocketUrl('not a url')).toBeNull();
  });
});
