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
  compileTex: vi.fn(async (cwd: string, texFile: string) => {
    const { writeFile: write } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const name = texFile.slice(0, -'.tex'.length);
    await write(join(cwd, `${name}.pdf`), `%PDF ${name}`);
  }),
}));

vi.mock('./publish.js', () => ({
  vaultPathFor: (name: string) => `resumes/${name}/${name}.pdf`,
  publishResume: vi.fn(async () => ({ storagePath: 'x' })),
}));

vi.mock('./agent-session.js', () => ({
  runResumeAgent: vi.fn(async () => ({
    transcript: [{ seq: 0, kind: 'assistant_text', text: 'editing', ts: 1 }],
  })),
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
} from './git.js';
import {
  type ModeDeps,
  parseWritePayload,
  runAgent,
  runSync,
  runWrite,
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
};

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

const storage = {
  put: async () => {},
  get: async () => Buffer.alloc(0),
  exists: async () => false,
};

function deps(db: ModeDeps['db'] = selectDb([])): ModeDeps {
  return { db, storage, repo };
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

beforeEach(async () => {
  vi.clearAllMocks();
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

describe('runSync', () => {
  it('compiles + publishes every tex file at the submodule HEAD, with NO commits', async () => {
    await writeFile(path.join(submoduleDir, 'swe-2027.tex'), '\\swe');
    await writeFile(path.join(submoduleDir, 'quant-2027.tex'), '\\quant');
    await writeFile(path.join(submoduleDir, 'notes.md'), 'not a resume');
    queueHeads({ [submoduleDir]: ['subsha'] });

    const outcome = await runSync(deps());

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
    // Same behavior as the factory mock, plus a failure for bad.tex. (Set
    // with mockImplementation, which clearAllMocks does NOT undo — so keep
    // the generic branch identical to the factory for later tests.)
    vi.mocked(compileTex).mockImplementation(
      async (cwd: string, texFile: string) => {
        if (texFile === 'bad.tex') throw new Error('LaTeX error on line 3');
        const name = texFile.slice(0, -'.tex'.length);
        await writeFile(path.join(cwd, `${name}.pdf`), `%PDF ${name}`);
      },
    );

    await expect(runSync(deps())).rejects.toThrow(
      /sync failed for 1\/2 resume\(s\): bad\.tex: LaTeX error on line 3/,
    );
    // The good resume still published.
    expect(vi.mocked(publishResume).mock.calls.map((c) => c[2]?.name)).toEqual([
      'good',
    ]);
  });
});

describe('runWrite', () => {
  const run = {
    id: 'run-1',
    kind: 'write',
    prompt: JSON.stringify({
      texPath: 'developer/resumes/swe-2027.tex',
      content: '\\newcontent',
    }),
  } as ResumeRun;

  it('writes the file, commits + pushes the submodule, bumps the parent pointer, then compiles + publishes', async () => {
    vi.mocked(isDirty).mockResolvedValue(true);
    queueHeads({ [submoduleDir]: ['newsha'] });

    const outcome = await runWrite(deps(), run);

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
    });
    expect(outcome).toEqual({ commitSha: 'newsha', transcript: null });
  });

  it('skips commit/push on a no-change save but still recompiles', async () => {
    await writeFile(path.join(submoduleDir, 'swe-2027.tex'), '\\newcontent');
    vi.mocked(isDirty).mockResolvedValue(false);
    queueHeads({ [submoduleDir]: ['samesha'] });

    const outcome = await runWrite(deps(), run);

    expect(commitAll).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(bumpSubmodulePointer).not.toHaveBeenCalled();
    expect(publishResume).toHaveBeenCalledTimes(1);
    expect(outcome.commitSha).toBe('samesha');
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
