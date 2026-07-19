import { promises as fs } from 'node:fs';
import path from 'node:path';
import { type Database, type ResumeRun, resumes } from '@sower/db';
import type { Storage } from '@sower/storage';
import { eq } from 'drizzle-orm';
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
  SUBMODULE_PATH,
} from './git.js';
import { publishResume } from './publish.js';
import { compileTex } from './tectonic.js';
import type { TranscriptStep } from './transcript.js';

/**
 * The three resume-editor run kinds, executed against a fresh portfolio
 * checkout (see git.ts setupPortfolioRepo). Each returns what the run row
 * should record; main.ts owns run-row status bookkeeping.
 */

export interface ModeDeps {
  db: Database;
  storage: Storage;
  repo: RepoContext;
}

export interface ModeOutcome {
  commitSha: string | null;
  transcript: TranscriptStep[] | null;
}

/** Compile one tex file in the submodule and publish its PDF + row. */
async function compileAndPublish(
  deps: ModeDeps,
  texFile: string,
  commitSha: string | null,
  texSourceOverride?: string,
): Promise<void> {
  const name = texFile.slice(0, -'.tex'.length);
  await compileTex(deps.repo.submoduleDir, texFile);
  const pdf = await fs.readFile(
    path.join(deps.repo.submoduleDir, `${name}.pdf`),
  );
  const texSource =
    texSourceOverride ??
    (await fs.readFile(path.join(deps.repo.submoduleDir, texFile), 'utf8'));
  await publishResume(deps.db, deps.storage, {
    name,
    texPath: `${SUBMODULE_PATH}/${texFile}`,
    texSource,
    pdf,
    commitSha,
  });
}

/**
 * sync: enumerate developer/resumes/*.tex, compile each, upload each PDF to
 * the vault, and upsert the resumes/documents rows. NO commits — the repo is
 * read-only in this mode. Per-file tolerant: one broken resume doesn't stop
 * the others syncing, but any failure fails the run (with every failure
 * named) so the dashboard never shows a green sync that skipped something.
 */
export async function runSync(deps: ModeDeps): Promise<ModeOutcome> {
  const entries = await fs.readdir(deps.repo.submoduleDir);
  const texFiles = entries.filter((f) => f.endsWith('.tex')).sort();
  const sha = await head(deps.repo, deps.repo.submoduleDir);
  console.log(
    `resume-editor: sync — ${texFiles.length} tex file(s) at ${sha.slice(0, 12)}`,
  );
  const failures: string[] = [];
  for (const texFile of texFiles) {
    try {
      await compileAndPublish(deps, texFile, sha);
      console.log(`resume-editor: synced ${texFile}`);
    } catch (error) {
      failures.push(
        `${texFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `sync failed for ${failures.length}/${texFiles.length} resume(s): ${failures.join('; ')}`,
    );
  }
  return { commitSha: sha, transcript: null };
}

/** The manual editor's payload, carried in the run row's prompt as JSON. */
interface WritePayload {
  texPath: string;
  content: string;
}

/**
 * Parse + validate the write payload: the path must be a direct
 * developer/resumes/<name>.tex member — no traversal, no other repo files
 * (the manual editor only ever edits resumes).
 */
export function parseWritePayload(prompt: string | null): WritePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt ?? '');
  } catch {
    throw new Error('write run prompt is not valid JSON');
  }
  const payload = parsed as Partial<WritePayload>;
  if (
    typeof payload.texPath !== 'string' ||
    typeof payload.content !== 'string'
  ) {
    throw new Error('write run prompt must be {texPath, content}');
  }
  const fileName = payload.texPath.slice(SUBMODULE_PATH.length + 1);
  if (
    !payload.texPath.startsWith(`${SUBMODULE_PATH}/`) ||
    !fileName.endsWith('.tex') ||
    fileName === '.tex' ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('..')
  ) {
    throw new Error(
      `write run texPath must be ${SUBMODULE_PATH}/<name>.tex (got ${JSON.stringify(payload.texPath)})`,
    );
  }
  return { texPath: payload.texPath, content: payload.content };
}

/**
 * write: the manual editor's save. Write the file verbatim, commit + push in
 * the SUBMODULE, bump the submodule pointer in the parent (+ push), then
 * compile/upload/upsert like sync. A no-change save skips the commit
 * (idempotent) but still recompiles.
 */
export async function runWrite(
  deps: ModeDeps,
  run: ResumeRun,
): Promise<ModeOutcome> {
  const { repo } = deps;
  const payload = parseWritePayload(run.prompt);
  const texFile = path.posix.basename(payload.texPath);
  await fs.writeFile(
    path.join(repo.submoduleDir, texFile),
    payload.content,
    'utf8',
  );
  if (await isDirty(repo, repo.submoduleDir)) {
    await commitAll(repo, repo.submoduleDir, 'resume: manual edit via sower');
    await push(repo, repo.submoduleDir, repo.submoduleBranch);
    await bumpSubmodulePointer(repo, 'resume: manual edit via sower');
  }
  const sha = await head(repo, repo.submoduleDir);
  await compileAndPublish(deps, texFile, sha, payload.content);
  return { commitSha: sha, transcript: null };
}

/**
 * agent: run the Claude session inside the checkout, then RECONCILE — the
 * agent is instructed to commit + push both repos, but the pipeline makes
 * the invariant true even when it stops short: leftover submodule changes
 * are committed, an unpushed submodule branch is pushed, the parent gitlink
 * is bumped + pushed (each step no-ops when the agent already did it, which
 * is also how the push is VERIFIED — local vs remote SHA). Finally every
 * .tex the session changed is recompiled/uploaded/upserted like sync.
 */
export async function runAgent(
  deps: ModeDeps,
  run: ResumeRun,
): Promise<ModeOutcome> {
  const { db, repo } = deps;
  if (!run.resumeId) {
    throw new Error('agent run has no resumeId');
  }
  if (!run.prompt || run.prompt.trim() === '') {
    throw new Error('agent run has no prompt');
  }
  const resumeRows = await db
    .select()
    .from(resumes)
    .where(eq(resumes.id, run.resumeId))
    .limit(1);
  const resume = resumeRows[0];
  if (!resume) {
    throw new Error(`resume ${run.resumeId} not found`);
  }

  const beforeSub = await head(repo, repo.submoduleDir);
  const beforeParent = await head(repo, repo.root);

  console.log(
    `resume-editor: agent session for ${resume.texPath} (prompt ${run.prompt.length} chars)`,
  );
  const { transcript } = await runResumeAgent({
    cwd: repo.root,
    gitHome: repo.gitHome,
    texPath: resume.texPath,
    prompt: run.prompt,
  });

  // Reconcile the submodule: commit leftovers, verify/perform the push.
  if (await isDirty(repo, repo.submoduleDir)) {
    await commitAll(repo, repo.submoduleDir, 'resume: edits via sower agent');
  }
  const afterSub = await head(repo, repo.submoduleDir);
  if (afterSub !== beforeSub) {
    const remote = await remoteBranchSha(
      repo,
      repo.submoduleDir,
      repo.submoduleBranch,
    );
    if (remote !== afterSub) {
      await push(repo, repo.submoduleDir, repo.submoduleBranch);
    }
    await bumpSubmodulePointer(
      repo,
      'resume: bump resumes submodule (sower agent)',
    );
  } else if (await isDirty(repo, repo.root)) {
    // Parent-only edits (repo conventions can require touching other files):
    // commit them, then the push check below ships them.
    await commitAll(repo, repo.root, 'portfolio: edits via sower agent');
  }
  const afterParent = await head(repo, repo.root);
  if (afterParent !== beforeParent) {
    const remoteParent = await remoteBranchSha(repo, repo.root, repo.branch);
    if (remoteParent !== afterParent) {
      await push(repo, repo.root, repo.branch);
    }
  }

  // Recompile + republish every resume the session touched.
  if (afterSub !== beforeSub) {
    const changed = await changedFiles(
      repo,
      repo.submoduleDir,
      beforeSub,
      afterSub,
    );
    const texChanged = changed.filter(
      (f) => f.endsWith('.tex') && !f.includes('/'),
    );
    for (const texFile of texChanged) {
      await compileAndPublish(deps, texFile, afterSub);
      console.log(`resume-editor: republished ${texFile}`);
    }
  }

  const commitSha =
    afterSub !== beforeSub
      ? afterSub
      : afterParent !== beforeParent
        ? afterParent
        : null;
  return { commitSha, transcript };
}
