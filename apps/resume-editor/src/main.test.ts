import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  runRows: [] as unknown[],
  selectError: null as Error | null,
  updates: [] as { table: unknown; set: unknown }[],
  setupCalls: [] as { workdir: string; token: string }[],
  setupError: null as Error | null,
  syncCalls: 0,
  writeCalls: [] as unknown[],
  agentCalls: [] as unknown[],
  modeError: null as Error | null,
  outcome: {
    commitSha: 'sha-1',
    transcript: null as unknown,
  },
  storageCreated: 0,
}));

const repoCtx = {
  gitHome: '/w/git-home',
  token: 'ghp_token',
  root: '/w/portfolio',
  submoduleDir: '/w/portfolio/developer/resumes',
  branch: 'main',
  submoduleBranch: 'main',
  // The real repo layout: developer/resumes is a plain tracked directory.
  isSubmodule: false,
};

vi.mock('@sower/db', () => {
  const resumeRuns = { name: 'resume_runs', id: 'resume_runs.id' };
  return {
    resumeRuns,
    createDb: () => ({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              if (state.selectError) throw state.selectError;
              return state.runRows;
            },
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (set: unknown) => ({
          where: async () => {
            state.updates.push({ table, set });
            return [];
          },
        }),
      }),
    }),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@sower/storage', () => ({
  createStorage: () => {
    state.storageCreated += 1;
    return { put: async () => {}, get: async () => Buffer.alloc(0) };
  },
}));

vi.mock('./git.js', () => ({
  setupPortfolioRepo: async (workdir: string, token: string) => {
    state.setupCalls.push({ workdir, token });
    if (state.setupError) throw state.setupError;
    return repoCtx;
  },
}));

vi.mock('./modes.js', () => ({
  runSync: async () => {
    state.syncCalls += 1;
    if (state.modeError) throw state.modeError;
    return state.outcome;
  },
  runWrite: async (_deps: unknown, run: unknown) => {
    state.writeCalls.push(run);
    if (state.modeError) throw state.modeError;
    return state.outcome;
  },
  runAgent: async (_deps: unknown, run: unknown) => {
    state.agentCalls.push(run);
    if (state.modeError) throw state.modeError;
    return state.outcome;
  },
}));

import { resumeRuns } from '@sower/db';
import { run } from './main.js';

const RUN_ID = '9e8d7c6b-5a49-4838-a716-05f4e3d2c1b0';

function lastUpdate(): { table: unknown; set: Record<string, unknown> } {
  const update = state.updates.at(-1);
  if (!update) throw new Error('no update recorded');
  return update as { table: unknown; set: Record<string, unknown> };
}

beforeEach(() => {
  state.runRows = [{ id: RUN_ID, kind: 'sync', status: 'running' }];
  state.selectError = null;
  state.updates = [];
  state.setupCalls = [];
  state.setupError = null;
  state.syncCalls = 0;
  state.writeCalls = [];
  state.agentCalls = [];
  state.modeError = null;
  state.outcome = { commitSha: 'sha-1', transcript: null };
  state.storageCreated = 0;
  process.env.RESUME_RUN_ID = RUN_ID;
  process.env.DATABASE_URL = 'postgres://test';
  process.env.GITHUB_PORTFOLIO_TOKEN = 'ghp_token';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'claude-token';
});

afterEach(() => {
  for (const key of [
    'RESUME_RUN_ID',
    'DATABASE_URL',
    'GITHUB_PORTFOLIO_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ]) {
    delete process.env[key];
  }
});

describe('resume-editor run()', () => {
  it('exits 1 without RESUME_RUN_ID', async () => {
    delete process.env.RESUME_RUN_ID;
    expect(await run()).toBe(1);
    expect(state.updates).toEqual([]);
  });

  it('exits 1 without DATABASE_URL', async () => {
    delete process.env.DATABASE_URL;
    expect(await run()).toBe(1);
  });

  it('exits 1 when the run row is missing', async () => {
    state.runRows = [];
    expect(await run()).toBe(1);
    expect(state.setupCalls).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it('exits 0 without redoing an already-finished run (Cloud Run retry)', async () => {
    state.runRows = [{ id: RUN_ID, kind: 'sync', status: 'succeeded' }];
    expect(await run()).toBe(0);
    expect(state.setupCalls).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it('marks the run failed (exit 0) when GITHUB_PORTFOLIO_TOKEN is missing', async () => {
    delete process.env.GITHUB_PORTFOLIO_TOKEN;
    expect(await run()).toBe(0);
    expect(state.setupCalls).toEqual([]);
    const { table, set } = lastUpdate();
    expect(table).toBe(resumeRuns);
    expect(set.status).toBe('failed');
    expect(set.error).toContain('GITHUB_PORTFOLIO_TOKEN');
    expect(set.finishedAt).toBeInstanceOf(Date);
  });

  it('marks an AGENT run failed (exit 0) when CLAUDE_CODE_OAUTH_TOKEN is missing', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    state.runRows = [
      { id: RUN_ID, kind: 'agent', status: 'running', prompt: 'p' },
    ];
    expect(await run()).toBe(0);
    expect(state.setupCalls).toEqual([]);
    expect(lastUpdate().set.status).toBe('failed');
    expect(lastUpdate().set.error).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('sync runs do NOT require the Claude token', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    expect(await run()).toBe(0);
    expect(state.syncCalls).toBe(1);
    expect(lastUpdate().set.status).toBe('succeeded');
  });

  it('sync: clones with the token, runs the sync, finalizes the run row', async () => {
    expect(await run()).toBe(0);
    expect(state.setupCalls).toHaveLength(1);
    expect(state.setupCalls[0]?.token).toBe('ghp_token');
    expect(state.syncCalls).toBe(1);
    const { set } = lastUpdate();
    expect(set).toMatchObject({
      status: 'succeeded',
      error: null,
      commitSha: 'sha-1',
      transcript: null,
    });
    expect(set.finishedAt).toBeInstanceOf(Date);
  });

  it('write: dispatches the run row to runWrite', async () => {
    const row = {
      id: RUN_ID,
      kind: 'write',
      status: 'running',
      prompt: '{"texPath":"developer/resumes/a.tex","content":"x"}',
    };
    state.runRows = [row];
    expect(await run()).toBe(0);
    expect(state.writeCalls).toEqual([row]);
    expect(lastUpdate().set.status).toBe('succeeded');
  });

  it('agent: dispatches to runAgent and records the transcript + commit sha', async () => {
    const transcript = [{ seq: 0, kind: 'assistant_text', text: 'hi', ts: 1 }];
    state.outcome = { commitSha: 'agent-sha', transcript };
    state.runRows = [
      { id: RUN_ID, kind: 'agent', status: 'running', prompt: 'p' },
    ];
    expect(await run()).toBe(0);
    expect(state.agentCalls).toHaveLength(1);
    expect(lastUpdate().set).toMatchObject({
      status: 'succeeded',
      commitSha: 'agent-sha',
      transcript,
    });
  });

  it('mode failure: records a REDACTED error on the run row and exits 1', async () => {
    state.modeError = new Error(
      'push failed: https://x-access-token:ghp_token@github.com/DIodide/portfolio.git rejected',
    );
    expect(await run()).toBe(1);
    const { set } = lastUpdate();
    expect(set.status).toBe('failed');
    expect(String(set.error)).not.toContain('ghp_token');
    expect(String(set.error)).toContain('[redacted]');
    expect(set.finishedAt).toBeInstanceOf(Date);
  });

  it('clone failure: still finalizes the run row (finally) and exits 1', async () => {
    state.setupError = new Error('clone failed: repository not found');
    expect(await run()).toBe(1);
    expect(state.syncCalls).toBe(0);
    const { set } = lastUpdate();
    expect(set.status).toBe('failed');
    expect(set.error).toContain('clone failed');
  });

  it('exits 1 when loading the run row throws', async () => {
    state.selectError = new Error('db down');
    expect(await run()).toBe(1);
  });
});
