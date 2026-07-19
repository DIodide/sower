import { beforeEach, describe, expect, it, vi } from 'vitest';

const execState = vi.hoisted(() => ({
  calls: [] as {
    cmd: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    secrets?: readonly (string | undefined)[];
  }[],
  /** stdout per call, matched by a predicate over the args. */
  respond: (_args: string[]): string => '',
}));

vi.mock('./exec.js', () => ({
  exec: vi.fn(
    async (
      cmd: string,
      args: string[],
      options?: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        secrets?: readonly (string | undefined)[];
      },
    ) => {
      execState.calls.push({
        cmd,
        args,
        cwd: options?.cwd,
        env: options?.env,
        secrets: options?.secrets,
      });
      return { stdout: execState.respond(args), stderr: '' };
    },
  ),
}));

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import {
  bumpSubmodulePointer,
  defaultBranch,
  detectResumesLayout,
  type RepoContext,
  remoteBranchSha,
  setupPortfolioRepo,
} from './git.js';

const TOKEN = 'ghp_test_token_123';

// setupPortfolioRepo mkdirs its git-home for real; give it a real temp dir.
const workdir = await mkdtemp(path.join(tmpdir(), 'sower-git-test-'));
afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

beforeEach(() => {
  execState.calls = [];
  execState.respond = () => '';
});

function argsOfCall(i: number): string[] {
  return execState.calls[i]?.args ?? [];
}

/** ls-files -s output for a gitlink at developer/resumes (a real submodule). */
const GITLINK_LS_FILES =
  '160000 5c8f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b 0\tdeveloper/resumes';

/** ls-files -s output for the REAL repo layout: a plain tracked directory. */
const PLAIN_DIR_LS_FILES = [
  '100644 aaaa1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b 0\tdeveloper/resumes/Ibraheem_Amin_Resume.pdf',
  '100644 bbbb1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b 0\tdeveloper/resumes/Ibraheem_Amin_Resume.tex',
  '100644 cccc1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b 0\tdeveloper/resumes/README.md',
].join('\n');

describe('setupPortfolioRepo', () => {
  beforeEach(() => {
    execState.respond = (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main';
      if (args[0] === 'ls-files') return GITLINK_LS_FILES;
      if (args[0] === 'ls-remote' && args[1] === '--symref') {
        return 'ref: refs/heads/master\tHEAD\nabc123\tHEAD';
      }
      return '';
    };
  });

  it('writes the tokenized insteadOf config into an ISOLATED HOME, then clones the PLAIN url', async () => {
    const ctx = await setupPortfolioRepo(workdir, TOKEN);

    // First call: the https insteadOf rewrite carrying the token.
    expect(argsOfCall(0)).toEqual([
      'config',
      '--global',
      `url.https://x-access-token:${TOKEN}@github.com/.insteadOf`,
      'https://github.com/',
    ]);
    // Second: the ssh form (whatever .gitmodules uses still authenticates).
    expect(argsOfCall(1)).toEqual([
      'config',
      '--global',
      '--add',
      `url.https://x-access-token:${TOKEN}@github.com/.insteadOf`,
      'git@github.com:',
    ]);
    // Every git call runs with HOME pointed at the scratch git-home — the
    // developer's real ~/.gitconfig is never touched.
    for (const call of execState.calls) {
      expect(call.env?.HOME).toBe(path.join(workdir, 'git-home'));
      expect(call.env?.GIT_TERMINAL_PROMPT).toBe('0');
      // The token is registered for redaction on every call.
      expect(call.secrets).toContain(TOKEN);
    }
    // The clone uses the PLAIN url — no token in the remote or on show in
    // `git remote -v`.
    const clone = execState.calls.find((c) => c.args[0] === 'clone');
    expect(clone?.args).toEqual([
      'clone',
      '--single-branch',
      'https://github.com/DIodide/portfolio.git',
      path.join(workdir, 'portfolio'),
    ]);

    // Layout detection runs against the parent checkout.
    const lsFiles = execState.calls.find((c) => c.args[0] === 'ls-files');
    expect(lsFiles?.args).toEqual([
      'ls-files',
      '-s',
      '--',
      'developer/resumes',
    ]);
    expect(lsFiles?.cwd).toBe(path.join(workdir, 'portfolio'));

    // The private submodule is initialized (insteadOf authenticates it too).
    const submodule = execState.calls.find((c) => c.args[0] === 'submodule');
    expect(submodule?.args).toEqual([
      'submodule',
      'update',
      '--init',
      '--',
      'developer/resumes',
    ]);

    expect(ctx.root).toBe(path.join(workdir, 'portfolio'));
    expect(ctx.submoduleDir).toBe(
      path.join(workdir, 'portfolio', 'developer', 'resumes'),
    );
    expect(ctx.branch).toBe('main');
    expect(ctx.isSubmodule).toBe(true);
    // Parsed from ls-remote --symref, then checked out at origin's tip.
    expect(ctx.submoduleBranch).toBe('master');
    const checkout = execState.calls.find((c) => c.args[0] === 'checkout');
    expect(checkout?.args).toEqual([
      'checkout',
      '-B',
      'master',
      'origin/master',
    ]);
  });

  it('plain tracked directory (the real repo layout): SKIPS submodule init entirely', async () => {
    execState.respond = (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main';
      if (args[0] === 'ls-files') return PLAIN_DIR_LS_FILES;
      return '';
    };

    const ctx = await setupPortfolioRepo(workdir, TOKEN);

    expect(ctx.isSubmodule).toBe(false);
    // The clone already materialized the directory; the path is unchanged.
    expect(ctx.submoduleDir).toBe(
      path.join(workdir, 'portfolio', 'developer', 'resumes'),
    );
    // Resume pushes target the PARENT branch — there is no submodule branch.
    expect(ctx.branch).toBe('main');
    expect(ctx.submoduleBranch).toBe('main');
    // No submodule init, no submodule checkout, no submodule branch probing.
    expect(execState.calls.some((c) => c.args[0] === 'submodule')).toBe(false);
    expect(execState.calls.some((c) => c.args[0] === 'checkout')).toBe(false);
    expect(execState.calls.some((c) => c.args[0] === 'ls-remote')).toBe(false);
    expect(execState.calls.some((c) => c.args[0] === 'fetch')).toBe(false);
  });
});

describe('detectResumesLayout', () => {
  const auth = { gitHome: '/h', token: TOKEN };

  it('mode 160000 gitlink → submodule', async () => {
    execState.respond = () => GITLINK_LS_FILES;
    await expect(detectResumesLayout(auth, '/repo')).resolves.toEqual({
      isSubmodule: true,
    });
  });

  it('blob entries under the path (plain tracked directory) → not a submodule', async () => {
    execState.respond = () => PLAIN_DIR_LS_FILES;
    await expect(detectResumesLayout(auth, '/repo')).resolves.toEqual({
      isSubmodule: false,
    });
  });

  it('throws when developer/resumes is not tracked at all', async () => {
    execState.respond = () => '';
    await expect(detectResumesLayout(auth, '/repo')).rejects.toThrow(
      /not tracked/,
    );
  });
});

describe('defaultBranch', () => {
  it('throws when origin HEAD is unparsable', async () => {
    execState.respond = () => 'garbage';
    await expect(
      defaultBranch({ gitHome: '/h', token: TOKEN }, '/repo'),
    ).rejects.toThrow(/default branch/);
  });
});

describe('remoteBranchSha', () => {
  it('returns the sha, or null when the branch is missing', async () => {
    execState.respond = () => 'abc123\trefs/heads/main';
    await expect(
      remoteBranchSha({ gitHome: '/h', token: TOKEN }, '/repo', 'main'),
    ).resolves.toBe('abc123');
    execState.respond = () => '';
    await expect(
      remoteBranchSha({ gitHome: '/h', token: TOKEN }, '/repo', 'gone'),
    ).resolves.toBeNull();
  });
});

describe('bumpSubmodulePointer', () => {
  const ctx: RepoContext = {
    gitHome: '/h',
    token: TOKEN,
    root: '/repo',
    submoduleDir: '/repo/developer/resumes',
    branch: 'main',
    submoduleBranch: 'main',
    isSubmodule: true,
  };

  it('stages ONLY the submodule path, commits, and pushes when remote is behind', async () => {
    execState.respond = (args) => {
      if (args[0] === 'status') return ' M developer/resumes';
      if (args[0] === 'rev-parse') return 'localsha';
      if (args[0] === 'ls-remote') return 'oldsha\trefs/heads/main';
      return '';
    };
    const sha = await bumpSubmodulePointer(ctx, 'bump msg');
    expect(sha).toBe('localsha');
    const add = execState.calls.find((c) => c.args[0] === 'add');
    expect(add?.args).toEqual(['add', '--', 'developer/resumes']);
    const commit = execState.calls.find((c) => c.args[0] === 'commit');
    expect(commit?.args).toEqual(['commit', '-m', 'bump msg']);
    const push = execState.calls.find((c) => c.args[0] === 'push');
    expect(push?.args).toEqual(['push', 'origin', 'HEAD:refs/heads/main']);
  });

  it('no-ops entirely when the pointer is current and pushed (agent already did it)', async () => {
    execState.respond = (args) => {
      if (args[0] === 'status') return '';
      if (args[0] === 'rev-parse') return 'samesha';
      if (args[0] === 'ls-remote') return 'samesha\trefs/heads/main';
      return '';
    };
    await bumpSubmodulePointer(ctx, 'bump msg');
    expect(execState.calls.some((c) => c.args[0] === 'commit')).toBe(false);
    expect(execState.calls.some((c) => c.args[0] === 'push')).toBe(false);
  });
});
