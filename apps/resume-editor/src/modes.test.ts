import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ResumeRun } from '@sower/db';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git.js')>();
  return {
    ...actual,
    head: vi.fn(),
    isDirty: vi.fn(),
    commitAll: vi.fn(),
    push: vi.fn(),
    remoteBranchSha: vi.fn(),
    changedFiles: vi.fn(),
    bumpSubmodulePointer: vi.fn(),
    setupPortfolioRepo: vi.fn(),
  };
});

vi.mock('./tectonic.js', () => ({
  TECTONIC_TIMEOUT_MS: 120_000,
  compileTex: vi.fn(),
}));

vi.mock('./publish.js', () => ({
  vaultPathFor: (name: string) => `resumes/${name}/${name}.pdf`,
  versionPdfPathFor: (name: string, sha: string) =>
    `resumes/${name}/versions/${sha}.pdf`,
  publishResume: vi.fn(async () => ({ storagePath: 'x' })),
}));

vi.mock('./agent-session.js', () => ({
  runResumeAgent: vi.fn(async () => ({
    transcript: [{ seq: 0, kind: 'assistant_text', text: 'editing', ts: 1 }],
  })),
}));

vi.mock('./github.js', () => ({
  getRepoFile: vi.fn(),
  putRepoFile: vi.fn(),
}));

import { runResumeAgent } from './agent-session.js';
import {
  bumpSubmodulePointer,
  changedFiles,
  commitAll,
  head,
  isDirty,
  push,
  type RepoContext,
  remoteBranchSha,
  setupPortfolioRepo,
} from './git.js';
import { getRepoFile, putRepoFile } from './github.js';
import {
  type FastModeDeps,
  isMissingFileCompileError,
  type ModeDeps,
  parseForkPayload,
  parseWritePayload,
  runAgent,
  runFork,
  runSync,
  runWrite,
  writeViaClone,
} from './modes.js';
import { publishResume } from './publish.js';
import { compileTex } from './tectonic.js';

const workdir = await mkdtemp(path.join(tmpdir(), 'sower-modes-test-'));
const submoduleDir = path.join(workdir, 'portfolio', 'developer', 'resumes');

const repo: RepoContext = {
  gitHome: path.join(workdir, 'git-home'),
  token: 'ghp_test',
  root: path.join(workdir, 'portfolio'),
  submoduleDir,
  branch: 'main',
  submoduleBranch: 'main',
  isSubmodule: true,
};

/** The REAL repo layout: developer/resumes is a plain directory. */
const plainRepo: RepoContext = { ...repo, isSubmodule: false };

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

interface Chain {
  from: () => Chain;
  where: () => Chain;
  limit: () => Chain;
  then: (onFulfilled: (value: unknown) => unknown) => Promise<unknown>;
}

function selectDb(rows: unknown[]): ModeDeps['db'] {
  const chain: Chain = {
    from: () => chain,
    where: () => chain,
    limit: () => chain,
    // biome-ignore lint/suspicious/noThenProperty: intentionally thenable to mimic drizzle's awaitable query builder
    then: (onFulfilled) => Promise.resolve(rows).then(onFulfilled),
  };
  return { select: () => chain } as unknown as ModeDeps['db'];
}

/** One result set per select() call, in order; empty after that. */
function selectDbSeq(results: unknown[][]): ModeDeps['db'] {
  const queue = results.map((rows) => [...rows]);
  return {
    select: () => {
      const rows = queue.shift() ?? [];
      const chain: Chain = {
        from: () => chain,
        where: () => chain,
        limit: () => chain,
        // biome-ignore lint/suspicious/noThenProperty: intentionally thenable to mimic drizzle's awaitable query builder
        then: (onFulfilled) => Promise.resolve(rows).then(onFulfilled),
      };
      return chain;
    },
  } as unknown as ModeDeps['db'];
}

const storage = {
  put: async () => {},
  get: async () => Buffer.alloc(0),
  exists: async () => false,
};

function deps(
  db: ModeDeps['db'] = selectDb([]),
  repoCtx: RepoContext = repo,
): ModeDeps {
  return { db, storage, repo: repoCtx };
}

function fastDeps(db: ModeDeps['db'] = selectDb([])): FastModeDeps {
  return { db, storage, token: 'ghp_test' };
}

/** Per-dir queues for the mocked head(); the last value repeats. */
function queueHeads(byDir: Record<string, string[]>): void {
  const queues = new Map(
    Object.entries(byDir).map(([dir, shas]) => [dir, [...shas]]),
  );
  vi.mocked(head).mockImplementation(async (_auth, dir) => {
    const queue = queues.get(dir) ?? ['unknown'];
    return queue.length > 1 ? (queue.shift() as string) : (queue[0] as string);
  });
}

const syncRun = { id: 'run-sync', kind: 'sync' } as ResumeRun;

beforeEach(async () => {
  vi.clearAllMocks();
  // clearAllMocks does NOT undo mockImplementation — reset the defaults so a
  // per-test override can never leak into a later test.
  vi.mocked(compileTex).mockImplementation(
    async (cwd: string, texFile: string) => {
      const name = texFile.slice(0, -'.tex'.length);
      await writeFile(path.join(cwd, `${name}.pdf`), `%PDF ${name}`);
    },
  );
  vi.mocked(getRepoFile).mockResolvedValue(null);
  vi.mocked(putRepoFile).mockResolvedValue('put-sha');
  vi.mocked(setupPortfolioRepo).mockResolvedValue(plainRepo);
  await rm(submoduleDir, { recursive: true, force: true });
  const { mkdir } = await import('node:fs/promises');
  await mkdir(submoduleDir, { recursive: true });
});

describe('parseWritePayload', () => {
  it('accepts a valid payload', () => {
    expect(
      parseWritePayload(
        JSON.stringify({
          texPath: 'developer/resumes/swe-2027.tex',
          content: 'x',
        }),
      ),
    ).toEqual({ texPath: 'developer/resumes/swe-2027.tex', content: 'x' });
  });

  it.each([
    'not json',
    JSON.stringify({ texPath: 'developer/resumes/a.tex' }),
    JSON.stringify({ texPath: 'other/dir/a.tex', content: 'x' }),
    JSON.stringify({
      texPath: 'developer/resumes/../../evil.tex',
      content: 'x',
    }),
    JSON.stringify({ texPath: 'developer/resumes/sub/a.tex', content: 'x' }),
    JSON.stringify({ texPath: 'developer/resumes/.tex', content: 'x' }),
    JSON.stringify({ texPath: 'developer/resumes/a.pdf', content: 'x' }),
  ])('rejects %s', (prompt) => {
    expect(() => parseWritePayload(prompt)).toThrow();
  });
});

describe('isMissingFileCompileError', () => {
  it.each([
    "compiling a.tex failed: ! LaTeX Error: File `resume.cls' not found.",
    'compiling a.tex failed: couldn\'t find "glyphs.tex" in bundle',
    'compiling a.tex failed: Unable to load picture or PDF file',
  ])('recognizes a missing file: %s', (message) => {
    expect(isMissingFileCompileError(message)).toBe(true);
  });

  it.each([
    'compiling a.tex failed: ! Undefined control sequence.',
    'compiling a.tex failed: ! Missing } inserted.',
  ])('does NOT match broken LaTeX: %s', (message) => {
    expect(isMissingFileCompileError(message)).toBe(false);
  });
});

describe('runSync', () => {
  it('compiles + publishes every tex file at the submodule HEAD, with NO commits', async () => {
    await writeFile(path.join(submoduleDir, 'swe-2027.tex'), '\\swe');
    await writeFile(path.join(submoduleDir, 'quant-2027.tex'), '\\quant');
    await writeFile(path.join(submoduleDir, 'notes.md'), 'not a resume');
    queueHeads({ [submoduleDir]: ['subsha'] });

    const outcome = await runSync(deps(), syncRun);

    expect(outcome).toEqual({ commitSha: 'subsha', transcript: null });
    expect(vi.mocked(compileTex).mock.calls.map((c) => c[1])).toEqual([
      'quant-2027.tex',
      'swe-2027.tex',
    ]);
    const published = vi.mocked(publishResume).mock.calls.map((c) => c[2]);
    expect(published).toHaveLength(2);
    expect(published[1]).toMatchObject({
      name: 'swe-2027',
      texPath: 'developer/resumes/swe-2027.tex',
      texSource: '\\swe',
      commitSha: 'subsha',
      // Sync-drift/backfill version capture (publishResume decides whether
      // an actual row is recorded).
      version: { kind: 'sync', runId: 'run-sync' },
    });
    expect(published[1]?.pdf.toString()).toBe('%PDF swe-2027');
    // Read-only mode: no commits, no pushes.
    expect(commitAll).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('keeps syncing past a broken resume but fails the run naming it', async () => {
    await writeFile(path.join(submoduleDir, 'bad.tex'), '\\broken');
    await writeFile(path.join(submoduleDir, 'good.tex'), '\\good');
    queueHeads({ [submoduleDir]: ['subsha'] });
    vi.mocked(compileTex).mockImplementation(
      async (cwd: string, texFile: string) => {
        if (texFile === 'bad.tex') throw new Error('LaTeX error on line 3');
        const name = texFile.slice(0, -'.tex'.length);
        await writeFile(path.join(cwd, `${name}.pdf`), `%PDF ${name}`);
      },
    );

    await expect(runSync(deps(), syncRun)).rejects.toThrow(
      /sync failed for 1\/2 resume\(s\): bad\.tex: LaTeX error on line 3/,
    );
    // The good resume still published.
    expect(vi.mocked(publishResume).mock.calls.map((c) => c[2]?.name)).toEqual([
      'good',
    ]);
  });

  it('plain directory + the real filename: Ibraheem_Amin_Resume.tex syncs at the PARENT head with underscores/case intact', async () => {
    await writeFile(
      path.join(submoduleDir, 'Ibraheem_Amin_Resume.tex'),
      '\\resume',
    );
    // Plain mode reads the sha from the parent repo, not the resumes dir.
    queueHeads({ [repo.root]: ['parentsha'] });

    const outcome = await runSync(deps(selectDb([]), plainRepo), syncRun);

    expect(outcome).toEqual({ commitSha: 'parentsha', transcript: null });
    expect(vi.mocked(compileTex).mock.calls).toEqual([
      [submoduleDir, 'Ibraheem_Amin_Resume.tex'],
    ]);
    expect(vi.mocked(publishResume).mock.calls[0]?.[2]).toMatchObject({
      name: 'Ibraheem_Amin_Resume',
      texPath: 'developer/resumes/Ibraheem_Amin_Resume.tex',
      texSource: '\\resume',
      commitSha: 'parentsha',
    });
    expect(vi.mocked(publishResume).mock.calls[0]?.[2]?.pdf.toString()).toBe(
      '%PDF Ibraheem_Amin_Resume',
    );
    expect(commitAll).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});

const writeRun = {
  id: 'run-1',
  kind: 'write',
  prompt: JSON.stringify({
    texPath: 'developer/resumes/swe-2027.tex',
    content: '\\newcontent',
  }),
} as ResumeRun;

describe('writeViaClone (the fallback flow)', () => {
  it('writes the file, commits + pushes the submodule, bumps the parent pointer, then compiles + publishes', async () => {
    vi.mocked(isDirty).mockResolvedValue(true);
    queueHeads({ [submoduleDir]: ['newsha'] });

    const outcome = await writeViaClone(deps(), writeRun);

    expect(
      await readFile(path.join(submoduleDir, 'swe-2027.tex'), 'utf8'),
    ).toBe('\\newcontent');
    expect(commitAll).toHaveBeenCalledWith(
      repo,
      submoduleDir,
      'resume: manual edit via sower',
    );
    expect(push).toHaveBeenCalledWith(repo, submoduleDir, 'main');
    expect(bumpSubmodulePointer).toHaveBeenCalledWith(
      repo,
      'resume: manual edit via sower',
    );
    expect(vi.mocked(publishResume).mock.calls[0]?.[2]).toMatchObject({
      name: 'swe-2027',
      texSource: '\\newcontent',
      commitSha: 'newsha',
      version: { kind: 'write', runId: 'run-1' },
    });
    expect(outcome).toEqual({ commitSha: 'newsha', transcript: null });
  });

  it('skips commit/push on a no-change save but still recompiles', async () => {
    await writeFile(path.join(submoduleDir, 'swe-2027.tex'), '\\newcontent');
    vi.mocked(isDirty).mockResolvedValue(false);
    queueHeads({ [submoduleDir]: ['samesha'] });

    const outcome = await writeViaClone(deps(), writeRun);

    expect(commitAll).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(bumpSubmodulePointer).not.toHaveBeenCalled();
    expect(publishResume).toHaveBeenCalledTimes(1);
    expect(outcome.commitSha).toBe('samesha');
  });

  it('plain directory: ONE commit + ONE push in the parent repo, and NO gitlink bump', async () => {
    vi.mocked(isDirty).mockResolvedValue(true);
    queueHeads({ [repo.root]: ['parentsha'] });

    const outcome = await writeViaClone(
      deps(selectDb([]), plainRepo),
      writeRun,
    );

    // Dirtiness is judged on the parent repo (the only repo there is).
    expect(isDirty).toHaveBeenCalledWith(plainRepo, plainRepo.root);
    // Single commit in the parent, single push to the parent branch.
    expect(commitAll).toHaveBeenCalledTimes(1);
    expect(commitAll).toHaveBeenCalledWith(
      plainRepo,
      plainRepo.root,
      'resume: manual edit via sower',
    );
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(plainRepo, plainRepo.root, 'main');
    // No second repo to touch: the gitlink bump is never attempted.
    expect(bumpSubmodulePointer).not.toHaveBeenCalled();
    expect(vi.mocked(publishResume).mock.calls[0]?.[2]).toMatchObject({
      name: 'swe-2027',
      commitSha: 'parentsha',
    });
    expect(outcome).toEqual({ commitSha: 'parentsha', transcript: null });
  });
});

describe('runWrite (FAST, Contents API)', () => {
  it('fetches, compiles standalone, PUTs against the blob sha, publishes with a version — NO clone', async () => {
    vi.mocked(getRepoFile).mockResolvedValue({
      sha: 'blob-1',
      text: '\\oldcontent',
    });
    vi.mocked(putRepoFile).mockResolvedValue('commit-9');

    const outcome = await runWrite(fastDeps(), writeRun);

    // Compile happened in an isolated temp dir, never the (absent) repo.
    const compileCwd = vi.mocked(compileTex).mock.calls[0]?.[0];
    expect(compileCwd).toBeDefined();
    expect(compileCwd).not.toBe(submoduleDir);
    expect(vi.mocked(compileTex).mock.calls[0]?.[1]).toBe('swe-2027.tex');
    // Commit via the Contents API against the fetched blob sha.
    expect(putRepoFile).toHaveBeenCalledWith(
      'ghp_test',
      'developer/resumes/swe-2027.tex',
      '\\newcontent',
      'resume: manual edit via sower',
      'blob-1',
    );
    expect(vi.mocked(publishResume).mock.calls[0]?.[2]).toMatchObject({
      name: 'swe-2027',
      texPath: 'developer/resumes/swe-2027.tex',
      texSource: '\\newcontent',
      commitSha: 'commit-9',
      version: { kind: 'write', runId: 'run-1' },
    });
    expect(outcome.commitSha).toBe('commit-9');
    // No git at all.
    expect(setupPortfolioRepo).not.toHaveBeenCalled();
    expect(commitAll).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('no-op save (identical content): succeeds with a note, commits and compiles NOTHING', async () => {
    vi.mocked(getRepoFile).mockResolvedValue({
      sha: 'blob-1',
      text: '\\newcontent',
    });

    const outcome = await runWrite(fastDeps(), writeRun);

    expect(outcome.commitSha).toBeNull();
    expect(outcome.transcript?.[0]?.text).toMatch(/nothing to commit/);
    expect(compileTex).not.toHaveBeenCalled();
    expect(putRepoFile).not.toHaveBeenCalled();
    expect(publishResume).not.toHaveBeenCalled();
  });

  it('missing repo file: fails without committing (resume renamed underneath us)', async () => {
    vi.mocked(getRepoFile).mockResolvedValue(null);
    await expect(runWrite(fastDeps(), writeRun)).rejects.toThrow(
      /does not exist in the portfolio repo/,
    );
    expect(putRepoFile).not.toHaveBeenCalled();
  });

  it('broken LaTeX: the run FAILS with tectonic output and NOTHING is committed', async () => {
    vi.mocked(getRepoFile).mockResolvedValue({ sha: 'blob-1', text: '\\old' });
    vi.mocked(compileTex).mockImplementation(async () => {
      throw new Error(
        'compiling swe-2027.tex failed: ! Undefined control sequence.',
      );
    });

    await expect(runWrite(fastDeps(), writeRun)).rejects.toThrow(
      /Undefined control sequence/,
    );
    // Validate-before-commit: the repo was never touched.
    expect(putRepoFile).not.toHaveBeenCalled();
    expect(publishResume).not.toHaveBeenCalled();
    expect(setupPortfolioRepo).not.toHaveBeenCalled();
  });

  it('missing-include compile failure: falls back to the CLONE flow and notes it in the transcript', async () => {
    vi.mocked(getRepoFile).mockResolvedValue({ sha: 'blob-1', text: '\\old' });
    // Standalone compile (temp dir) can't see the repo's class file; inside
    // the checkout it compiles fine.
    vi.mocked(compileTex).mockImplementation(
      async (cwd: string, texFile: string) => {
        if (cwd !== submoduleDir) {
          throw new Error(
            "compiling swe-2027.tex failed: ! LaTeX Error: File `sower-resume.cls' not found.",
          );
        }
        const name = texFile.slice(0, -'.tex'.length);
        await writeFile(path.join(cwd, `${name}.pdf`), `%PDF ${name}`);
      },
    );
    vi.mocked(isDirty).mockResolvedValue(true);
    queueHeads({ [plainRepo.root]: ['clone-sha'] });

    const outcome = await runWrite(fastDeps(), writeRun);

    // The fallback cloned and committed through git, not the Contents API.
    expect(setupPortfolioRepo).toHaveBeenCalledTimes(1);
    expect(commitAll).toHaveBeenCalledWith(
      plainRepo,
      plainRepo.root,
      'resume: manual edit via sower',
    );
    expect(putRepoFile).not.toHaveBeenCalled();
    expect(outcome.commitSha).toBe('clone-sha');
    expect(outcome.transcript?.[0]?.text).toMatch(/fell back to the clone/);
    expect(vi.mocked(publishResume).mock.calls[0]?.[2]).toMatchObject({
      commitSha: 'clone-sha',
      version: { kind: 'write', runId: 'run-1' },
    });
  });
});

describe('parseForkPayload', () => {
  it('accepts a valid payload', () => {
    expect(
      parseForkPayload(
        JSON.stringify({ sourceResumeId: 'abc', newName: 'stripe-2027' }),
      ),
    ).toEqual({ sourceResumeId: 'abc', newName: 'stripe-2027' });
  });

  it.each([
    'not json',
    JSON.stringify({ sourceResumeId: 'abc' }),
    JSON.stringify({ newName: 'x-2027' }),
    JSON.stringify({ sourceResumeId: 'abc', newName: 'a' }),
    JSON.stringify({ sourceResumeId: 'abc', newName: 'a/b' }),
    JSON.stringify({ sourceResumeId: 'abc', newName: 'a.tex' }),
    JSON.stringify({ sourceResumeId: 'abc', newName: '..' }),
    JSON.stringify({ sourceResumeId: 'abc', newName: 'x'.repeat(61) }),
  ])('rejects %s', (prompt) => {
    expect(() => parseForkPayload(prompt)).toThrow();
  });
});

describe('runFork (FAST, Contents API)', () => {
  const SOURCE_ID = '3f0a1b2c-4d5e-4f60-8172-93a4b5c6d7e8';
  const forkRun = {
    id: 'run-f',
    kind: 'fork',
    resumeId: SOURCE_ID,
    prompt: JSON.stringify({
      sourceResumeId: SOURCE_ID,
      newName: 'stripe-2027',
    }),
  } as ResumeRun;
  const sourceRow = {
    id: SOURCE_ID,
    name: 'swe-2027',
    texPath: 'developer/resumes/swe-2027.tex',
    texSource: '\\dbsnapshot',
  };

  it('reads the source FRESH from the repo, compiles, creates the file, publishes the first version', async () => {
    // Source select, then the name-collision select (free).
    const db = selectDbSeq([[sourceRow], []]);
    vi.mocked(getRepoFile).mockImplementation(async (_token, repoPath) =>
      repoPath === 'developer/resumes/swe-2027.tex'
        ? { sha: 'src-blob', text: '\\fresh' }
        : null,
    );
    vi.mocked(putRepoFile).mockResolvedValue('fork-sha');

    const outcome = await runFork(fastDeps(db), forkRun);

    // Repo content wins over the DB snapshot.
    expect(putRepoFile).toHaveBeenCalledWith(
      'ghp_test',
      'developer/resumes/stripe-2027.tex',
      '\\fresh',
      'resume: fork swe-2027 -> stripe-2027 via sower',
    );
    expect(vi.mocked(compileTex).mock.calls[0]?.[1]).toBe('stripe-2027.tex');
    expect(vi.mocked(publishResume).mock.calls[0]?.[2]).toMatchObject({
      name: 'stripe-2027',
      texPath: 'developer/resumes/stripe-2027.tex',
      texSource: '\\fresh',
      commitSha: 'fork-sha',
      version: { kind: 'fork', runId: 'run-f' },
    });
    expect(outcome.commitSha).toBe('fork-sha');
    expect(outcome.transcript?.[0]?.text).toMatch(/forked 'swe-2027'/);
    expect(setupPortfolioRepo).not.toHaveBeenCalled();
  });

  it('falls back to the DB tex snapshot when the repo file is missing', async () => {
    const db = selectDbSeq([[sourceRow], []]);
    vi.mocked(getRepoFile).mockResolvedValue(null);
    vi.mocked(putRepoFile).mockResolvedValue('fork-sha');

    await runFork(fastDeps(db), forkRun);

    expect(putRepoFile).toHaveBeenCalledWith(
      'ghp_test',
      'developer/resumes/stripe-2027.tex',
      '\\dbsnapshot',
      expect.stringContaining('fork'),
    );
  });

  it('refuses when the target .tex already exists in the repo', async () => {
    const db = selectDbSeq([[sourceRow], []]);
    // Both the source AND the target resolve — target occupied.
    vi.mocked(getRepoFile).mockResolvedValue({ sha: 'x', text: '\\any' });

    await expect(runFork(fastDeps(db), forkRun)).rejects.toThrow(
      /already exists in the portfolio repo/,
    );
    expect(putRepoFile).not.toHaveBeenCalled();
    expect(publishResume).not.toHaveBeenCalled();
  });

  it('refuses when a resumes row already uses the name', async () => {
    const db = selectDbSeq([[sourceRow], [{ id: 'other' }]]);
    await expect(runFork(fastDeps(db), forkRun)).rejects.toThrow(
      /already exists/,
    );
    expect(putRepoFile).not.toHaveBeenCalled();
  });

  it('refuses an unknown source resume', async () => {
    const db = selectDbSeq([[]]);
    await expect(runFork(fastDeps(db), forkRun)).rejects.toThrow(/not found/);
  });

  it('compile failure: the run fails and NOTHING is created', async () => {
    const db = selectDbSeq([[sourceRow], []]);
    vi.mocked(getRepoFile).mockImplementation(async (_token, repoPath) =>
      repoPath === 'developer/resumes/swe-2027.tex'
        ? { sha: 'src-blob', text: '\\fresh' }
        : null,
    );
    vi.mocked(compileTex).mockImplementation(async () => {
      throw new Error('compiling stripe-2027.tex failed: ! Emergency stop.');
    });

    await expect(runFork(fastDeps(db), forkRun)).rejects.toThrow(
      /Emergency stop/,
    );
    expect(putRepoFile).not.toHaveBeenCalled();
    expect(publishResume).not.toHaveBeenCalled();
  });
});

describe('runAgent', () => {
  const RESUME_ID = '3f0a1b2c-4d5e-4f60-8172-93a4b5c6d7e8';
  const run = {
    id: 'run-2',
    kind: 'agent',
    resumeId: RESUME_ID,
    prompt: 'Add my Acme internship.',
  } as ResumeRun;
  const resumeRow = {
    id: RESUME_ID,
    name: 'swe-2027',
    texPath: 'developer/resumes/swe-2027.tex',
  };

  it('agent committed and pushed everything: verifies via SHA compare, republishes changed tex', async () => {
    queueHeads({
      [submoduleDir]: ['sub-before', 'sub-after'],
      [repo.root]: ['par-before', 'par-after'],
    });
    vi.mocked(isDirty).mockResolvedValue(false);
    // Remote already matches local everywhere — the agent pushed.
    vi.mocked(remoteBranchSha).mockImplementation(async (_a, dir) =>
      dir === submoduleDir ? 'sub-after' : 'par-after',
    );
    vi.mocked(changedFiles).mockResolvedValue(['swe-2027.tex', 'assets/x.cls']);
    await writeFile(path.join(submoduleDir, 'swe-2027.tex'), '\\edited');

    const outcome = await runAgent(deps(selectDb([resumeRow])), run);

    expect(runResumeAgent).toHaveBeenCalledWith({
      cwd: repo.root,
      gitHome: repo.gitHome,
      texPath: 'developer/resumes/swe-2027.tex',
      prompt: 'Add my Acme internship.',
      isSubmodule: true,
    });
    // Nothing left to reconcile: no commits, no pushes from the driver.
    expect(commitAll).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    // The gitlink bump is still verified/settled (no-ops when done).
    expect(bumpSubmodulePointer).toHaveBeenCalled();
    // Only top-level .tex files republish (assets/x.cls is skipped).
    expect(vi.mocked(publishResume).mock.calls.map((c) => c[2]?.name)).toEqual([
      'swe-2027',
    ]);
    expect(vi.mocked(publishResume).mock.calls[0]?.[2]).toMatchObject({
      commitSha: 'sub-after',
      texSource: '\\edited',
      // One version per changed resume, attributed to this agent run.
      version: { kind: 'agent', runId: 'run-2' },
    });
    expect(outcome.commitSha).toBe('sub-after');
    expect(outcome.transcript).toEqual([
      { seq: 0, kind: 'assistant_text', text: 'editing', ts: 1 },
    ]);
  });

  it('agent stopped short: driver commits leftovers, pushes the submodule, bumps the parent', async () => {
    queueHeads({
      [submoduleDir]: ['sub-before', 'sub-after'],
      [repo.root]: ['par-before', 'par-before'],
    });
    // Submodule dirty (uncommitted agent edits); parent clean.
    vi.mocked(isDirty).mockImplementation(
      async (_a, dir) => dir === submoduleDir,
    );
    // Remote still at the old sha — the push did NOT happen.
    vi.mocked(remoteBranchSha).mockResolvedValue('sub-before');
    vi.mocked(changedFiles).mockResolvedValue([]);

    const outcome = await runAgent(deps(selectDb([resumeRow])), run);

    expect(commitAll).toHaveBeenCalledWith(
      repo,
      submoduleDir,
      'resume: edits via sower agent',
    );
    expect(push).toHaveBeenCalledWith(repo, submoduleDir, 'main');
    expect(bumpSubmodulePointer).toHaveBeenCalledWith(
      repo,
      'resume: bump resumes submodule (sower agent)',
    );
    expect(outcome.commitSha).toBe('sub-after');
  });

  it('no changes at all: succeeds with a null commitSha and no publishes', async () => {
    queueHeads({
      [submoduleDir]: ['sub-same'],
      [repo.root]: ['par-same'],
    });
    vi.mocked(isDirty).mockResolvedValue(false);

    const outcome = await runAgent(deps(selectDb([resumeRow])), run);

    expect(outcome.commitSha).toBeNull();
    expect(publishResume).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  describe('plain directory (the real repo layout)', () => {
    const resumeRowPlain = {
      id: RESUME_ID,
      name: 'Ibraheem_Amin_Resume',
      texPath: 'developer/resumes/Ibraheem_Amin_Resume.tex',
    };

    it('agent committed and pushed: verifies via SHA compare on the PARENT only, republishes the real tex file', async () => {
      queueHeads({ [repo.root]: ['par-before', 'par-after'] });
      vi.mocked(isDirty).mockResolvedValue(false);
      // Remote already matches local — the agent pushed the parent repo.
      vi.mocked(remoteBranchSha).mockResolvedValue('par-after');
      // Parent-repo diff paths are repo-relative; only the top-level
      // developer/resumes/*.tex entries republish.
      vi.mocked(changedFiles).mockResolvedValue([
        'developer/resumes/Ibraheem_Amin_Resume.tex',
        'developer/resumes/assets/x.cls',
        'src/pages/index.tsx',
      ]);
      await writeFile(
        path.join(submoduleDir, 'Ibraheem_Amin_Resume.tex'),
        '\\edited',
      );

      const outcome = await runAgent(
        deps(selectDb([resumeRowPlain]), plainRepo),
        run,
      );

      // The session is told the single-repo truth.
      expect(runResumeAgent).toHaveBeenCalledWith({
        cwd: plainRepo.root,
        gitHome: plainRepo.gitHome,
        texPath: 'developer/resumes/Ibraheem_Amin_Resume.tex',
        prompt: 'Add my Acme internship.',
        isSubmodule: false,
      });
      // Nothing left to reconcile: no commits, no pushes, and NO gitlink
      // bump is ever attempted in the plain layout.
      expect(commitAll).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      expect(bumpSubmodulePointer).not.toHaveBeenCalled();
      // The diff runs in the parent repo between the parent shas.
      expect(changedFiles).toHaveBeenCalledWith(
        plainRepo,
        plainRepo.root,
        'par-before',
        'par-after',
      );
      expect(
        vi.mocked(publishResume).mock.calls.map((c) => c[2]?.name),
      ).toEqual(['Ibraheem_Amin_Resume']);
      expect(vi.mocked(publishResume).mock.calls[0]?.[2]).toMatchObject({
        texPath: 'developer/resumes/Ibraheem_Amin_Resume.tex',
        texSource: '\\edited',
        commitSha: 'par-after',
      });
      expect(outcome.commitSha).toBe('par-after');
    });

    it('agent stopped short: driver commits + pushes the PARENT once, no gitlink bump', async () => {
      queueHeads({ [repo.root]: ['par-before', 'par-after'] });
      // Parent dirty (uncommitted agent edits).
      vi.mocked(isDirty).mockResolvedValue(true);
      // Remote still at the old sha — the push did NOT happen.
      vi.mocked(remoteBranchSha).mockResolvedValue('par-before');
      vi.mocked(changedFiles).mockResolvedValue([]);

      const outcome = await runAgent(
        deps(selectDb([resumeRowPlain]), plainRepo),
        run,
      );

      expect(commitAll).toHaveBeenCalledTimes(1);
      expect(commitAll).toHaveBeenCalledWith(
        plainRepo,
        plainRepo.root,
        'resume: edits via sower agent',
      );
      expect(push).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith(plainRepo, plainRepo.root, 'main');
      expect(bumpSubmodulePointer).not.toHaveBeenCalled();
      expect(outcome.commitSha).toBe('par-after');
    });

    it('no changes: null commitSha, no publishes, no pushes', async () => {
      queueHeads({ [repo.root]: ['par-same'] });
      vi.mocked(isDirty).mockResolvedValue(false);

      const outcome = await runAgent(
        deps(selectDb([resumeRowPlain]), plainRepo),
        run,
      );

      expect(outcome.commitSha).toBeNull();
      expect(publishResume).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      expect(bumpSubmodulePointer).not.toHaveBeenCalled();
    });
  });

  it('rejects runs without a resume row / prompt', async () => {
    await expect(runAgent(deps(selectDb([])), run)).rejects.toThrow(
      /not found/,
    );
    await expect(
      runAgent(deps(selectDb([resumeRow])), {
        ...run,
        prompt: null,
      } as ResumeRun),
    ).rejects.toThrow(/no prompt/);
    await expect(
      runAgent(deps(selectDb([resumeRow])), {
        ...run,
        resumeId: null,
      } as ResumeRun),
    ).rejects.toThrow(/no resumeId/);
  });
});
