import { redactSecrets } from './redact.js';

/**
 * Minimal GitHub Contents API client for the FAST (clone-free) flows: manual
 * writes and forks touch exactly one file, so a full clone (tens of seconds
 * on a large portfolio repo) buys nothing. A GET fetches the current blob
 * (sha + content) and a PUT commits new content against that sha — GitHub
 * rejects the PUT (409) if the file moved underneath us, which is exactly
 * the lost-update protection the clone flow got from push.
 *
 * TOKEN MECHANICS: the token travels ONLY in the Authorization header —
 * never in a URL — and every error detail is scrubbed through redactSecrets
 * anyway (belt and braces, mirroring exec.ts) so no failure path can leak it
 * into the resume_runs error column or Cloud Run logs.
 */

export const PORTFOLIO_OWNER_REPO = 'DIodide/portfolio';
export const PORTFOLIO_BRANCH = 'main';
export const GITHUB_API_BASE = 'https://api.github.com';

const REQUEST_TIMEOUT_MS = 30_000;
/** Keep recorded errors readable; GitHub error bodies can carry HTML. */
const ERROR_DETAIL_CHARS = 600;

export interface RepoFile {
  /** Blob sha — the optimistic-concurrency token a Contents PUT requires. */
  sha: string;
  /** Decoded UTF-8 file text. */
  text: string;
}

function contentsUrl(repoPath: string): string {
  const encoded = repoPath.split('/').map(encodeURIComponent).join('/');
  return `${GITHUB_API_BASE}/repos/${PORTFOLIO_OWNER_REPO}/contents/${encoded}`;
}

function baseHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'sower-resume-editor',
  };
}

/** Redacted, truncated response-body detail for thrown errors. */
async function errorDetail(response: Response, token: string): Promise<string> {
  const text = await response.text().catch(() => '');
  return redactSecrets(text.slice(0, ERROR_DETAIL_CHARS), [token]);
}

/**
 * Read one repo file at the tip of the portfolio branch. Returns null when
 * the path does not exist there (the fork flow's collision probe relies on
 * that); throws on any other failure.
 */
export async function getRepoFile(
  token: string,
  repoPath: string,
): Promise<RepoFile | null> {
  const response = await fetch(
    `${contentsUrl(repoPath)}?ref=${PORTFOLIO_BRANCH}`,
    {
      headers: baseHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `GitHub contents GET ${repoPath} failed (${response.status}): ${await errorDetail(response, token)}`,
    );
  }
  const body = (await response.json()) as {
    type?: unknown;
    sha?: unknown;
    content?: unknown;
    encoding?: unknown;
  };
  if (body.type !== 'file' || typeof body.sha !== 'string') {
    throw new Error(`GitHub contents GET ${repoPath}: not a file`);
  }
  // Files over ~1 MB come back with encoding 'none' and empty content — no
  // real resume source is anywhere near that, so treat it as unusable
  // rather than silently comparing against ''.
  if (typeof body.content !== 'string' || body.encoding !== 'base64') {
    throw new Error(
      `GitHub contents GET ${repoPath}: unexpected encoding ${JSON.stringify(body.encoding)}`,
    );
  }
  return {
    sha: body.sha,
    text: Buffer.from(body.content, 'base64').toString('utf8'),
  };
}

/**
 * Commit one file via the Contents API and return the NEW COMMIT sha.
 * Pass the current blob `sha` to update (GitHub 409s when it is stale — a
 * concurrent edit wins, we fail loudly instead of clobbering it); omit it
 * to create (GitHub 422s when the path already exists).
 */
export async function putRepoFile(
  token: string,
  repoPath: string,
  content: string,
  message: string,
  sha?: string,
): Promise<string> {
  const response = await fetch(contentsUrl(repoPath), {
    method: 'PUT',
    headers: { ...baseHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: PORTFOLIO_BRANCH,
      ...(sha !== undefined ? { sha } : {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub contents PUT ${repoPath} failed (${response.status}): ${await errorDetail(response, token)}`,
    );
  }
  const body = (await response.json()) as { commit?: { sha?: unknown } };
  const commitSha = body.commit?.sha;
  if (typeof commitSha !== 'string') {
    throw new Error(
      `GitHub contents PUT ${repoPath}: response carried no commit sha`,
    );
  }
  return commitSha;
}
