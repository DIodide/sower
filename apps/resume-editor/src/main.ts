/**
 * Cloud Run Job entrypoint for the resume editor. Reads the resume_runs row
 * named by RESUME_RUN_ID and executes it against a fresh clone of the user's
 * private portfolio repo (DIodide/portfolio + the developer/resumes
 * submodule, authenticated via GITHUB_PORTFOLIO_TOKEN — see git.ts for the
 * token mechanics and redact.ts/exec.ts for why it can never leak into logs
 * or the run row):
 *
 * - sync:  compile every developer/resumes/*.tex, upload the PDFs to the
 *          vault, upsert resumes + documents rows. No commits.
 * - write: the manual editor's save — write the file, commit + push
 *          (submodule, then the parent pointer bump), compile, upload.
 * - agent: a Claude Agent SDK session inside the checkout (trusted-repo
 *          posture — see agent-session.ts), then reconcile commits/pushes
 *          and republish whatever the session changed.
 *
 * Unlike the investigator (which POSTs results into the ingest pipeline),
 * this job writes status/transcript/commitSha DIRECTLY to its resume_runs
 * row — the job IS the pipeline here, and it already holds a DB connection
 * for the upserts, so an HTTP callback would add surface without value. The
 * run row is finalized in a finally: no outcome path can leave it 'running'.
 *
 * Exit codes: 0 on success (or when the run cannot ever succeed — missing
 * tokens are recorded on the run row, and a Cloud Run retry would not help),
 * 1 on failure so Cloud Run Jobs retries.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createDb,
  type ResumeRun,
  type ResumeRunStatus,
  resumeRuns,
} from '@sower/db';
import { createStorage } from '@sower/storage';
import { eq } from 'drizzle-orm';
import { setupPortfolioRepo } from './git.js';
import { type ModeOutcome, runAgent, runSync, runWrite } from './modes.js';
import { redactSecrets } from './redact.js';

type Db = ReturnType<typeof createDb>;

async function finishRun(
  db: Db,
  runId: string,
  patch: {
    status: ResumeRunStatus;
    error?: string | null;
    commitSha?: string | null;
    transcript?: ModeOutcome['transcript'];
  },
): Promise<void> {
  await db
    .update(resumeRuns)
    .set({
      status: patch.status,
      error: patch.error ?? null,
      commitSha: patch.commitSha ?? null,
      transcript: patch.transcript ?? null,
      finishedAt: new Date(),
    })
    .where(eq(resumeRuns.id, runId));
}

export async function run(): Promise<number> {
  const runId = process.env.RESUME_RUN_ID || process.argv[2];
  if (!runId) {
    console.error(
      'resume-editor: no RESUME_RUN_ID (env or argv) — nothing to do',
    );
    return 1;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('resume-editor: DATABASE_URL is not set');
    return 1;
  }

  const db = createDb(databaseUrl);
  let runRow: ResumeRun | undefined;
  try {
    const rows = await db
      .select()
      .from(resumeRuns)
      .where(eq(resumeRuns.id, runId))
      .limit(1);
    runRow = rows[0];
  } catch (error) {
    console.error(
      `resume-editor: failed to load run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  if (!runRow) {
    console.error(`resume-editor: run ${runId} not found`);
    return 1;
  }
  if (runRow.status !== 'running') {
    // A Cloud Run retry of an already-finished execution: nothing to redo.
    console.log(
      `resume-editor: run ${runId} already ${runRow.status} — nothing to do`,
    );
    return 0;
  }

  // Graceful degradation while infra wires the secrets: the run is marked
  // failed (so the dashboard is not left polling 'running' forever) but the
  // exit code is 0 — a retry cannot conjure the token.
  const token = process.env.GITHUB_PORTFOLIO_TOKEN;
  if (!token) {
    console.log('resume-editor: disabled (GITHUB_PORTFOLIO_TOKEN is not set)');
    await finishRun(db, runId, {
      status: 'failed',
      error: 'GITHUB_PORTFOLIO_TOKEN is not configured',
    });
    return 0;
  }
  if (runRow.kind === 'agent' && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.log(
      'resume-editor: agent runs disabled (CLAUDE_CODE_OAUTH_TOKEN is not set)',
    );
    await finishRun(db, runId, {
      status: 'failed',
      error: 'CLAUDE_CODE_OAUTH_TOKEN is not configured',
    });
    return 0;
  }

  const storage = createStorage();
  let workdir: string | undefined;
  let code = 0;
  let status: ResumeRunStatus = 'succeeded';
  let errorMessage: string | null = null;
  let outcome: ModeOutcome = { commitSha: null, transcript: null };
  try {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'sower-resume-'));
    console.log(
      `resume-editor: run ${runId} kind=${runRow.kind} — cloning portfolio`,
    );
    const repo = await setupPortfolioRepo(workdir, token);
    const deps = { db, storage, repo };
    if (runRow.kind === 'sync') {
      outcome = await runSync(deps);
    } else if (runRow.kind === 'write') {
      outcome = await runWrite(deps, runRow);
    } else if (runRow.kind === 'agent') {
      outcome = await runAgent(deps, runRow);
    } else {
      throw new Error(`unknown run kind '${runRow.kind}'`);
    }
  } catch (error) {
    status = 'failed';
    // Belt and braces: exec.ts already scrubs subprocess failures at the
    // source; scrub once more so NO path can write the token to the run row.
    errorMessage = redactSecrets(
      error instanceof Error ? error.message : String(error),
      [token],
    );
    console.error(`resume-editor: run ${runId} failed: ${errorMessage}`);
    code = 1;
  } finally {
    try {
      await finishRun(db, runId, {
        status,
        error: errorMessage,
        commitSha: outcome.commitSha,
        transcript: outcome.transcript,
      });
    } catch (error) {
      console.error(
        `resume-editor: failed to record outcome for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      code = 1;
    }
    if (workdir !== undefined) {
      // The checkout holds the user's private repo — always clean it up.
      await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (code === 0) {
    console.log(`resume-editor: run ${runId} complete (${status})`);
  }
  return code;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const code = await run();
  // Explicit exit: the postgres pool keeps the event loop alive otherwise.
  process.exit(code);
}
