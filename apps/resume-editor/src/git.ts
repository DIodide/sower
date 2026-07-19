import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exec } from './exec.js';

/**
 * Git plumbing for the portfolio checkout.
 *
 * TOKEN MECHANICS: the GitHub token is never placed in a remote URL or on a
 * command line that names a repo. Instead an isolated HOME (`gitHome`, a
 * scratch dir) gets a .gitconfig with
 *   url."https://x-access-token:<token>@github.com/".insteadOf
 * rewrites for both https and ssh GitHub forms. Every git command (ours AND
 * the agent's — its subprocess HOME is the same gitHome) then authenticates
 * transparently: clone, submodule update, and push all work against the
 * PLAIN https://github.com/... URLs, `git remote -v` shows no token, and the
 * developer's real ~/.gitconfig is never touched when running locally. The
 * token remains readable via `git config --get` inside that HOME — accepted
 * for the trusted agent posture (see agent-session.ts). Failures are scrubbed
 * by exec.ts before they can surface anywhere.
 */

export const PORTFOLIO_REPO_URL = 'https://github.com/DIodide/portfolio.git';
export const SUBMODULE_PATH = 'developer/resumes';

/** What every git helper needs: the isolated HOME + the secret to scrub. */
export interface GitAuth {
  gitHome: string;
  /** Kept ONLY so exec can redact it from failures; never logged. */
  token: string;
}

export interface RepoContext extends GitAuth {
  /** Absolute path of the portfolio checkout. */
  root: string;
  /**
   * Absolute path of the developer/resumes checkout — a submodule worktree
   * when isSubmodule, otherwise a plain directory of the parent repo.
   */
  submoduleDir: string;
  /** Checked-out default branch of the parent repo. */
  branch: string;
  /**
   * Branch resume pushes target: the submodule's default branch when
   * developer/resumes is a submodule, otherwise the parent branch.
   */
  submoduleBranch: string;
  /**
   * Whether developer/resumes is tracked as a gitlink (a real submodule) or
   * as a plain directory of the parent repo. Decides the commit/push shape:
   * two repos + pointer bump vs a single parent-repo commit.
   */
  isSubmodule: boolean;
}

function gitEnv(auth: GitAuth): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // The isolated HOME carries the tokenized insteadOf config + identity.
    HOME: auth.gitHome,
    // Never fall back to an interactive credential prompt in a headless job.
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** Run one git command; failures are redacted (token + URL userinfo). */
export async function git(
  auth: GitAuth,
  cwd: string | undefined,
  args: string[],
): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: gitEnv(auth),
    secrets: [auth.token],
  });
  return stdout.trim();
}

/** Default branch of `origin` (parses `ls-remote --symref origin HEAD`). */
export async function defaultBranch(
  auth: GitAuth,
  dir: string,
): Promise<string> {
  const out = await git(auth, dir, ['ls-remote', '--symref', 'origin', 'HEAD']);
  const match = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  if (!match?.[1]) {
    throw new Error('could not determine the default branch of origin');
  }
  return match[1];
}

export async function head(auth: GitAuth, dir: string): Promise<string> {
  return git(auth, dir, ['rev-parse', 'HEAD']);
}

/** SHA of origin's `branch` right now, or null when the branch is missing. */
export async function remoteBranchSha(
  auth: GitAuth,
  dir: string,
  branch: string,
): Promise<string | null> {
  const out = await git(auth, dir, [
    'ls-remote',
    'origin',
    `refs/heads/${branch}`,
  ]);
  const sha = out.split(/\s+/)[0];
  return sha ? sha : null;
}

export async function isDirty(auth: GitAuth, dir: string): Promise<boolean> {
  return (await git(auth, dir, ['status', '--porcelain'])) !== '';
}

/** Stage everything and commit. Callers guard with isDirty first. */
export async function commitAll(
  auth: GitAuth,
  dir: string,
  message: string,
): Promise<void> {
  await git(auth, dir, ['add', '-A']);
  await git(auth, dir, ['commit', '-m', message]);
}

export async function push(
  auth: GitAuth,
  dir: string,
  branch: string,
): Promise<void> {
  await git(auth, dir, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
}

/** Files changed between two commits of the repo at `dir` (diff --name-only). */
export async function changedFiles(
  auth: GitAuth,
  dir: string,
  fromSha: string,
  toSha: string,
): Promise<string[]> {
  const out = await git(auth, dir, ['diff', '--name-only', fromSha, toSha]);
  return out === '' ? [] : out.split('\n');
}

/**
 * Detect how developer/resumes is tracked in the parent checkout:
 * `git ls-files -s -- developer/resumes` lists a single mode-160000 entry
 * for the path itself when it is a gitlink (a real submodule), or the blob
 * entries of the files inside it when it is a plain tracked directory.
 * Untracked entirely is an error — the job has nothing to operate on.
 */
export async function detectResumesLayout(
  auth: GitAuth,
  root: string,
): Promise<{ isSubmodule: boolean }> {
  const out = await git(auth, root, ['ls-files', '-s', '--', SUBMODULE_PATH]);
  if (out === '') {
    throw new Error(
      `${SUBMODULE_PATH} is not tracked in the portfolio repo (neither a submodule nor a plain directory)`,
    );
  }
  const isSubmodule = out
    .split('\n')
    .some(
      (line) =>
        line.startsWith('160000 ') && line.endsWith(`\t${SUBMODULE_PATH}`),
    );
  return { isSubmodule };
}

/**
 * Record the submodule's current HEAD in the parent repo (the gitlink bump):
 * stage ONLY the submodule path, commit when it actually moved, and push the
 * parent when its local tip isn't on origin yet. Safe to call when the agent
 * already bumped and/or pushed — every step no-ops when there is nothing to
 * do. Returns the parent HEAD after any commit. Only meaningful when
 * ctx.isSubmodule — the plain-directory layout has no gitlink to bump.
 */
export async function bumpSubmodulePointer(
  ctx: RepoContext,
  message: string,
): Promise<string> {
  const pending = await git(ctx, ctx.root, [
    'status',
    '--porcelain',
    '--',
    SUBMODULE_PATH,
  ]);
  if (pending !== '') {
    await git(ctx, ctx.root, ['add', '--', SUBMODULE_PATH]);
    await git(ctx, ctx.root, ['commit', '-m', message]);
  }
  const local = await head(ctx, ctx.root);
  const remote = await remoteBranchSha(ctx, ctx.root, ctx.branch);
  if (remote !== local) {
    await push(ctx, ctx.root, ctx.branch);
  }
  return local;
}

/**
 * Full checkout setup for a run:
 *  1. isolated HOME with the tokenized insteadOf config + a commit identity,
 *  2. clone of the portfolio default branch (full history — pushes need it),
 *  3. detect how developer/resumes is tracked (detectResumesLayout):
 *     - PLAIN DIRECTORY (the current reality of DIodide/portfolio): the
 *       clone already materialized it — no submodule init, and edits will be
 *       committed/pushed in the parent repo directly;
 *     - GITLINK (kept working in case the repo ever moves to a submodule):
 *       `git submodule update --init -- developer/resumes` (the insteadOf
 *       config authenticates a PRIVATE submodule too, whichever URL form
 *       .gitmodules uses), then the submodule is checked out on its default
 *       branch at origin's tip (edits and syncs both want the freshest
 *       resumes, and a branch — not the detached gitlink HEAD — is what
 *       push/pull expect).
 */
export async function setupPortfolioRepo(
  workdir: string,
  token: string,
): Promise<RepoContext> {
  const gitHome = path.join(workdir, 'git-home');
  await fs.mkdir(gitHome, { recursive: true });
  const auth: GitAuth = { gitHome, token };

  const tokenized = `https://x-access-token:${token}@github.com/`;
  await git(auth, undefined, [
    'config',
    '--global',
    `url.${tokenized}.insteadOf`,
    'https://github.com/',
  ]);
  await git(auth, undefined, [
    'config',
    '--global',
    '--add',
    `url.${tokenized}.insteadOf`,
    'git@github.com:',
  ]);
  await git(auth, undefined, [
    'config',
    '--global',
    'user.name',
    'sower-resume-editor',
  ]);
  await git(auth, undefined, [
    'config',
    '--global',
    'user.email',
    'sower-resume-editor@users.noreply.github.com',
  ]);

  const root = path.join(workdir, 'portfolio');
  // Plain URL: the insteadOf rewrite injects the token at network time, so
  // the remote URL (and any log line rendering it) stays token-free.
  await git(auth, undefined, [
    'clone',
    '--single-branch',
    PORTFOLIO_REPO_URL,
    root,
  ]);
  const branch = await git(auth, root, ['rev-parse', '--abbrev-ref', 'HEAD']);

  const { isSubmodule } = await detectResumesLayout(auth, root);
  const submoduleDir = path.join(root, SUBMODULE_PATH);

  if (!isSubmodule) {
    // Plain tracked directory: nothing to initialize, and resume pushes go
    // to the parent branch.
    return {
      gitHome,
      token,
      root,
      submoduleDir,
      branch,
      submoduleBranch: branch,
      isSubmodule,
    };
  }

  await git(auth, root, [
    'submodule',
    'update',
    '--init',
    '--',
    SUBMODULE_PATH,
  ]);

  const submoduleBranch = await defaultBranch(auth, submoduleDir);
  await git(auth, submoduleDir, ['fetch', 'origin', submoduleBranch]);
  await git(auth, submoduleDir, [
    'checkout',
    '-B',
    submoduleBranch,
    `origin/${submoduleBranch}`,
  ]);
  await git(auth, submoduleDir, [
    'branch',
    `--set-upstream-to=origin/${submoduleBranch}`,
    submoduleBranch,
  ]);

  return {
    gitHome,
    token,
    root,
    submoduleDir,
    branch,
    submoduleBranch,
    isSubmodule,
  };
}
