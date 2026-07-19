import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRepoFile, putRepoFile } from './github.js';

const TOKEN = 'ghp_secret_token';

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(
  responses: { status: number; body: unknown }[],
): RecordedRequest[] {
  const calls: RecordedRequest[] = [];
  const queue = [...responses];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body:
          typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const next = queue.shift() ?? { status: 500, body: 'no response queued' };
      return new Response(
        typeof next.body === 'string' ? next.body : JSON.stringify(next.body),
        { status: next.status },
      );
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getRepoFile', () => {
  it('fetches the branch-pinned contents URL with the token ONLY in the header', async () => {
    const calls = stubFetch([
      {
        status: 200,
        body: {
          type: 'file',
          sha: 'blob-sha',
          encoding: 'base64',
          content: Buffer.from('\\documentclass{article}', 'utf8').toString(
            'base64',
          ),
        },
      },
    ]);

    const file = await getRepoFile(TOKEN, 'developer/resumes/swe-2027.tex');

    expect(file).toEqual({ sha: 'blob-sha', text: '\\documentclass{article}' });
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/DIodide/portfolio/contents/developer/resumes/swe-2027.tex?ref=main',
    );
    // The token rides the Authorization header, never the URL.
    expect(calls[0]?.url).not.toContain(TOKEN);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('returns null on 404 (the fork collision probe relies on it)', async () => {
    stubFetch([{ status: 404, body: { message: 'Not Found' } }]);
    expect(await getRepoFile(TOKEN, 'developer/resumes/missing.tex')).toBe(
      null,
    );
  });

  it('throws a REDACTED error on other failures (a token echoed in the body never surfaces)', async () => {
    stubFetch([{ status: 401, body: `Bad credentials for ${TOKEN}` }]);
    const error: unknown = await getRepoFile(
      TOKEN,
      'developer/resumes/swe-2027.tex',
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/GET .* failed \(401\)/);
    expect(message).not.toContain(TOKEN);
    expect(message).toContain('[redacted]');
  });

  it('rejects a non-file (directory) response', async () => {
    stubFetch([{ status: 200, body: [{ type: 'dir' }] }]);
    await expect(getRepoFile(TOKEN, 'developer/resumes')).rejects.toThrow(
      /not a file/,
    );
  });

  it('rejects an unexpected encoding (the >1MB "none" case)', async () => {
    stubFetch([
      {
        status: 200,
        body: { type: 'file', sha: 's', encoding: 'none', content: '' },
      },
    ]);
    await expect(
      getRepoFile(TOKEN, 'developer/resumes/huge.tex'),
    ).rejects.toThrow(/unexpected encoding/);
  });
});

describe('putRepoFile', () => {
  it('PUTs base64 content + blob sha + branch and returns the NEW COMMIT sha', async () => {
    const calls = stubFetch([
      { status: 200, body: { commit: { sha: 'commit-sha-9' } } },
    ]);

    const sha = await putRepoFile(
      TOKEN,
      'developer/resumes/swe-2027.tex',
      '\\newcontent',
      'resume: manual edit via sower',
      'blob-sha',
    );

    expect(sha).toBe('commit-sha-9');
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.body).toEqual({
      message: 'resume: manual edit via sower',
      content: Buffer.from('\\newcontent', 'utf8').toString('base64'),
      branch: 'main',
      sha: 'blob-sha',
    });
  });

  it('omits sha when creating a new file (the fork flow)', async () => {
    const calls = stubFetch([
      { status: 201, body: { commit: { sha: 'fork-commit' } } },
    ]);
    await putRepoFile(
      TOKEN,
      'developer/resumes/stripe-2027.tex',
      '\\forked',
      'resume: fork via sower',
    );
    expect(calls[0]?.body).not.toHaveProperty('sha');
  });

  it('throws with the status on a stale-sha conflict (409) — the concurrent edit wins', async () => {
    stubFetch([{ status: 409, body: { message: 'is at ... but expected' } }]);
    await expect(
      putRepoFile(TOKEN, 'developer/resumes/a.tex', 'x', 'm', 'stale'),
    ).rejects.toThrow(/failed \(409\)/);
  });

  it('throws when the response carries no commit sha', async () => {
    stubFetch([{ status: 200, body: { commit: {} } }]);
    await expect(
      putRepoFile(TOKEN, 'developer/resumes/a.tex', 'x', 'm', 's'),
    ).rejects.toThrow(/no commit sha/);
  });
});
