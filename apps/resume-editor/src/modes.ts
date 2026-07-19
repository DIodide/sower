import { promises as fs } from 'node:fs';
import os from 'node:os';
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
  setupPortfolioRepo,
} from './git.js';
import { getRepoFile, putRepoFile } from './github.js';
import { type PublishVersion, publishResume } from './publish.js';
import { compileTex } from './tectonic.js';
import type { TranscriptStep } from './transcript.js';

/**
 * The resume-editor run kinds. sync and agent execute against a fresh
 * portfolio checkout (see git.ts setupPortfolioRepo) — the agent needs the
 * repo and sync enumerates it. write and fork are FAST clone-free flows over
 * the GitHub Contents API (github.ts): they touch exactly one file, compile
 * it standalone in a temp dir, and only commit after the compile succeeds
 * (validate-before-commit). Each returns what the run row should record;
 * main.ts owns run-row status bookkeeping.
 *
 * COMMIT/PUSH SHAPE of the clone flows depends on repo.isSubmodule (detected
 * at clone time): developer/resumes as a PLAIN DIRECTORY (the current
 * reality) means one commit + one push in the parent repo; as a GITLINK it
 * means the two-repo flow (commit + push in the submodule, then the parent
 * pointer bump). The Contents-API flows always commit to the parent branch —
 * correct for the plain-directory reality (a future submodule move would
 * 404 the Contents GET and fail loudly, never write to the wrong repo).
 *
 * VERSIONING: every flow that lands a change passes `version` through to
 * publishResume, which uploads the per-commit PDF copy and records the
 * resume_versions row (idempotent on (resumeId, commitSha)).
 */

export interface ModeDeps {
  db: Database;
  storage: Storage;
  repo: RepoContext;
}

/** What the clone-free (Contents API) flows need — no checkout. */
export interface FastModeDeps {
  db: Database;
  storage: Storage;
  /** GitHub token for the Contents API (and the clone fallback). */
  token: string;
}

export interface ModeOutcome {
  commitSha: string | null;
  transcript: TranscriptStep[] | null;
}

/** One synthetic transcript note (fast-flow observability). */
function noteStep(text: string, seq = 0): TranscriptStep {
  return { seq, kind: 'system', text, ts: Date.now() };
}

/** Compile one tex file in the resumes dir and publish its PDF + rows. */
async function compileAndPublish(
  deps: ModeDeps,
  texFile: string,
  commitSha: string | null,
  version: PublishVersion,
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
    version,
  });
}

/**
 * sync: enumerate developer/resumes/*.tex, compile each, upload each PDF to
 * the vault, and upsert the resumes/documents rows. NO commits — the repo is
 * read-only in this mode. Per-file tolerant: one broken resume doesn't stop
 * the others syncing, but any failure fails the run (with every failure
 * named) so the dashboard never shows a green sync that skipped something.
 * Version capture: publishResume records a kind='sync' version when the
 * repo's tex differs from the last recorded version (an out-of-band edit),
 * and backfills a first version for any resume with none yet.
 */
export async function runSync(
  deps: ModeDeps,
  run: ResumeRun,
): Promise<ModeOutcome> {
  const entries = await fs.readdir(deps.repo.submoduleDir);
  const texFiles = entries.filter((f) => f.endsWith('.tex')).sort();
  // The commit the tex content came from: the submodule HEAD, or the parent
  // HEAD when developer/resumes is a plain directory of the parent repo.
  const sha = await head(
    deps.repo,
    deps.repo.isSubmodule ? deps.repo.submoduleDir : deps.repo.root,
  );
  console.log(
    `resume-editor: sync — ${texFiles.length} tex file(s) at ${sha.slice(0, 12)}`,
  );
  const failures: string[] = [];
  for (const texFile of texFiles) {
    try {
      await compileAndPublish(deps, texFile, sha, {
        kind: 'sync',
        runId: run.id,
      });
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
 * Does a tectonic failure look like a MISSING FILE rather than broken LaTeX?
 * A standalone temp-dir compile cannot resolve a repo-relative \input or
 * graphics file; those failures surface as "... not found" / "couldn't
 * find ..." in tectonic's output and mean the fast flow must fall back to
 * the full checkout. A genuine LaTeX error (undefined control sequence,
 * missing brace, ...) matches none of these and fails the run outright.
 */
export function isMissingFileCompileError(message: string): boolean {
  return /not found|couldn't find|cannot find|unable to load/i.test(message);
}

/**
 * writeViaClone: the ORIGINAL clone-based manual save, kept as the fallback
 * for the rare resume whose compile needs repo-relative includes. Write the
 * file verbatim, then commit + push where developer/resumes actually lives:
 * a single parent-repo commit ('resume: manual edit via sower') when it is
 * a plain directory, or the two-repo flow (submodule commit + push, then
 * the parent pointer bump) when it is a real submodule. Finally
 * compile/upload/upsert like sync. A no-change save skips the commit
 * (idempotent) but still recompiles.
 */
export async function writeViaClone(
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
  if (repo.isSubmodule) {
    if (await isDirty(repo, repo.submoduleDir)) {
      await commitAll(repo, repo.submoduleDir, 'resume: manual edit via sower');
      await push(repo, repo.submoduleDir, repo.submoduleBranch);
      await bumpSubmodulePointer(repo, 'resume: manual edit via sower');
    }
  } else if (await isDirty(repo, repo.root)) {
    // Plain directory: ONE commit + ONE push in the parent repo — there is
    // no gitlink to bump and no second push.
    await commitAll(repo, repo.root, 'resume: manual edit via sower');
    await push(repo, repo.root, repo.branch);
  }
  const sha = await head(
    repo,
    repo.isSubmodule ? repo.submoduleDir : repo.root,
  );
  await compileAndPublish(
    deps,
    texFile,
    sha,
    { kind: 'write', runId: run.id },
    payload.content,
  );
  return { commitSha: sha, transcript: null };
}

/** Clone-fallback wrapper for the fast write: own workdir, own cleanup. */
async function writeViaCloneFallback(
  deps: FastModeDeps,
  run: ResumeRun,
  compileError: string,
): Promise<ModeOutcome> {
  console.log(
    'resume-editor: fast write falling back to the clone flow (compile could not resolve a file standalone)',
  );
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'sower-resume-'));
  try {
    const repo = await setupPortfolioRepo(workdir, deps.token);
    const outcome = await writeViaClone(
      { db: deps.db, storage: deps.storage, repo },
      run,
    );
    // The fallback is worth seeing in the run transcript: it explains why
    // this save was slow and names the include the standalone compile missed.
    const note = noteStep(
      `fast write fell back to the clone flow — the standalone compile could not resolve a file (${compileError.slice(0, 400)})`,
    );
    return {
      ...outcome,
      transcript: [note, ...(outcome.transcript ?? [])].map((step, seq) => ({
        ...step,
        seq,
      })),
    };
  } finally {
    // The checkout holds the user's private repo — always clean it up.
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * write (FAST): the manual editor's save, clone-free. Fetch the file's
 * current blob via the Contents API; a byte-identical save succeeds as a
 * no-op (nothing committed, latest pointers untouched). Otherwise compile
 * the NEW content standalone in a temp dir — on success commit it via a
 * Contents PUT against the fetched blob sha ('resume: manual edit via
 * sower'; a stale sha 409s instead of clobbering a concurrent edit), then
 * upload latest + version PDFs and upsert the rows. On compile FAILURE the
 * run fails with tectonic's output and NOTHING is committed —
 * validate-before-commit is the point of the deterministic flow. A compile
 * failure that looks like a missing include falls back to writeViaClone
 * (noted in the transcript).
 */
export async function runWrite(
  deps: FastModeDeps,
  run: ResumeRun,
): Promise<ModeOutcome> {
  const payload = parseWritePayload(run.prompt);
  const texFile = path.posix.basename(payload.texPath);
  const name = texFile.slice(0, -'.tex'.length);

  const current = await getRepoFile(deps.token, payload.texPath);
  if (!current) {
    throw new Error(
      `${payload.texPath} does not exist in the portfolio repo — cannot save (was the resume renamed?)`,
    );
  }
  if (current.text === payload.content) {
    return {
      commitSha: null,
      transcript: [
        noteStep(
          'content is identical to the repo — nothing to commit (no-op save)',
        ),
      ],
    };
  }

  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'sower-resume-'));
  try {
    await fs.writeFile(path.join(workdir, texFile), payload.content, 'utf8');
    try {
      await compileTex(workdir, texFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMissingFileCompileError(message)) {
        return await writeViaCloneFallback(deps, run, message);
      }
      // Broken LaTeX: fail the run with tectonic's output; the repo is
      // untouched — the user fixes the source and saves again.
      throw error;
    }
    const pdf = await fs.readFile(path.join(workdir, `${name}.pdf`));
    // Compile verified — NOW commit. Returns the new commit sha.
    const commitSha = await putRepoFile(
      deps.token,
      payload.texPath,
      payload.content,
      'resume: manual edit via sower',
      current.sha,
    );
    await publishResume(deps.db, deps.storage, {
      name,
      texPath: payload.texPath,
      texSource: payload.content,
      pdf,
      commitSha,
      version: { kind: 'write', runId: run.id },
    });
    return { commitSha, transcript: null };
  } finally {
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The fork run's payload, carried in the run row's prompt as JSON. */
interface ForkPayload {
  sourceResumeId: string;
  newName: string;
}

/**
 * Fork names become filename stems and vault path segments: short, no path
 * bits, nothing a shell/URL would reinterpret. Mirrors the API-side check.
 */
export const FORK_NAME_RE = /^[a-z0-9_-]{2,60}$/i;

export function parseForkPayload(prompt: string | null): ForkPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt ?? '');
  } catch {
    throw new Error('fork run prompt is not valid JSON');
  }
  const payload = parsed as Partial<ForkPayload>;
  if (
    typeof payload.sourceResumeId !== 'string' ||
    typeof payload.newName !== 'string'
  ) {
    throw new Error('fork run prompt must be {sourceResumeId, newName}');
  }
  if (!FORK_NAME_RE.test(payload.newName)) {
    throw new Error(
      `fork newName must match ${FORK_NAME_RE} (got ${JSON.stringify(payload.newName)})`,
    );
  }
  return { sourceResumeId: payload.sourceResumeId, newName: payload.newName };
}

/**
 * fork (FAST, clone-free): copy the source resume's CURRENT tex to a new
 * developer/resumes/<newName>.tex. The source is read fresh from the repo
 * (Contents GET — the DB snapshot could trail an out-of-band edit; it is
 * only the fallback when the repo file vanished), the target path must be
 * free in BOTH the repo and the resumes table, and the copy is compiled
 * BEFORE anything is committed. Then: Contents PUT (create), latest +
 * version PDF uploads, new resumes + documents rows, and the first
 * resume_versions row (kind 'fork') — all via publishResume.
 */
export async function runFork(
  deps: FastModeDeps,
  run: ResumeRun,
): Promise<ModeOutcome> {
  const { sourceResumeId, newName } = parseForkPayload(run.prompt);
  const sourceRows = await deps.db
    .select()
    .from(resumes)
    .where(eq(resumes.id, sourceResumeId))
    .limit(1);
  const source = sourceRows[0];
  if (!source) {
    throw new Error(`source resume ${sourceResumeId} not found`);
  }
  const collisionRows = await deps.db
    .select({ id: resumes.id })
    .from(resumes)
    .where(eq(resumes.name, newName))
    .limit(1);
  if (collisionRows[0]) {
    throw new Error(`a resume named '${newName}' already exists`);
  }

  const repoFile = await getRepoFile(deps.token, source.texPath);
  const texSource = repoFile?.text ?? source.texSource;
  if (texSource === null || texSource === '') {
    throw new Error(
      `source resume '${source.name}' has no tex source to fork (repo file missing and no DB snapshot)`,
    );
  }

  const newTexFile = `${newName}.tex`;
  const newTexPath = `${SUBMODULE_PATH}/${newTexFile}`;
  if ((await getRepoFile(deps.token, newTexPath)) !== null) {
    throw new Error(`${newTexPath} already exists in the portfolio repo`);
  }

  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'sower-resume-'));
  try {
    // Compile BEFORE creating anything: an uncompilable fork commits nothing.
    await fs.writeFile(path.join(workdir, newTexFile), texSource, 'utf8');
    await compileTex(workdir, newTexFile);
    const pdf = await fs.readFile(path.join(workdir, `${newName}.pdf`));
    // No blob sha ⇒ create; GitHub 422s if the path appeared concurrently.
    const commitSha = await putRepoFile(
      deps.token,
      newTexPath,
      texSource,
      `resume: fork ${source.name} -> ${newName} via sower`,
    );
    await publishResume(deps.db, deps.storage, {
      name: newName,
      texPath: newTexPath,
      texSource,
      pdf,
      commitSha,
      version: { kind: 'fork', runId: run.id },
    });
    return {
      commitSha,
      transcript: [
        noteStep(`forked '${source.name}' to '${newName}' at ${commitSha}`),
      ],
    };
  } finally {
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

interface ReconcileResult {
  /** Sha for the run row (null when the session changed nothing). */
  commitSha: string | null;
  /** Top-level resume .tex files the session changed (bare filenames). */
  texChanged: string[];
  /** Sha the recompiled resumes are recorded against. */
  publishSha: string;
}

/**
 * Submodule reconcile (the two-repo flow): commit leftover submodule
 * changes, verify/perform the submodule push (local vs remote SHA), bump +
 * push the parent gitlink, and ship any parent-only edits.
 */
async function reconcileSubmoduleRepos(
  repo: RepoContext,
  beforeSub: string,
  beforeParent: string,
): Promise<ReconcileResult> {
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
  let texChanged: string[] = [];
  if (afterSub !== beforeSub) {
    const changed = await changedFiles(
      repo,
      repo.submoduleDir,
      beforeSub,
      afterSub,
    );
    texChanged = changed.filter((f) => f.endsWith('.tex') && !f.includes('/'));
  }
  const commitSha =
    afterSub !== beforeSub
      ? afterSub
      : afterParent !== beforeParent
        ? afterParent
        : null;
  return { commitSha, texChanged, publishSha: afterSub };
}

/**
 * Single-repo reconcile: developer/resumes is a plain directory of the
 * parent repo, so there is exactly one place to commit and one push to
 * verify — no gitlink bump, no second push. Changed resumes are the
 * developer/resumes/*.tex entries of the parent diff.
 */
async function reconcileSingleRepo(
  repo: RepoContext,
  before: string,
): Promise<ReconcileResult> {
  if (await isDirty(repo, repo.root)) {
    await commitAll(repo, repo.root, 'resume: edits via sower agent');
  }
  const after = await head(repo, repo.root);
  if (after !== before) {
    const remote = await remoteBranchSha(repo, repo.root, repo.branch);
    if (remote !== after) {
      await push(repo, repo.root, repo.branch);
    }
  }
  let texChanged: string[] = [];
  if (after !== before) {
    const changed = await changedFiles(repo, repo.root, before, after);
    texChanged = changed
      .filter((f) => f.startsWith(`${SUBMODULE_PATH}/`) && f.endsWith('.tex'))
      .map((f) => f.slice(SUBMODULE_PATH.length + 1))
      .filter((f) => !f.includes('/'));
  }
  return {
    commitSha: after !== before ? after : null,
    texChanged,
    publishSha: after,
  };
}

/**
 * agent: run the Claude session inside the checkout, then RECONCILE — the
 * agent is instructed to commit + push, but the pipeline makes the
 * invariant true even when it stops short: leftover changes are committed
 * and unpushed branches are pushed (each step no-ops when the agent already
 * did it, which is also how the push is VERIFIED — local vs remote SHA).
 * The reconcile shape follows repo.isSubmodule: the two-repo submodule flow
 * (with the parent gitlink bump) or the single parent-repo flow. Finally
 * every .tex the session changed is recompiled/uploaded/upserted like sync,
 * each recording a kind='agent' resume_versions row (one per changed
 * resume).
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

  const beforeParent = await head(repo, repo.root);
  const beforeSub = repo.isSubmodule
    ? await head(repo, repo.submoduleDir)
    : beforeParent;

  console.log(
    `resume-editor: agent session for ${resume.texPath} (prompt ${run.prompt.length} chars)`,
  );
  const { transcript } = await runResumeAgent({
    cwd: repo.root,
    gitHome: repo.gitHome,
    texPath: resume.texPath,
    prompt: run.prompt,
    isSubmodule: repo.isSubmodule,
  });

  const reconciled = repo.isSubmodule
    ? await reconcileSubmoduleRepos(repo, beforeSub, beforeParent)
    : await reconcileSingleRepo(repo, beforeParent);

  // Recompile + republish every resume the session touched.
  for (const texFile of reconciled.texChanged) {
    await compileAndPublish(deps, texFile, reconciled.publishSha, {
      kind: 'agent',
      runId: run.id,
    });
    console.log(`resume-editor: republished ${texFile}`);
  }

  return { commitSha: reconciled.commitSha, transcript };
}
