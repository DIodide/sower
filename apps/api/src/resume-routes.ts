import { type ResumeRun, resumeRuns, resumes } from '@sower/db';
import { desc, eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runCloudJob } from './run-cloud-job.js';
import type { Deps } from './types.js';

/**
 * Resume-editor routes (/resumes): the dashboard's window onto the LaTeX
 * resumes living in the user's private portfolio repo (DIodide/portfolio,
 * submodule developer/resumes). All heavy lifting — clone, tectonic compile,
 * vault upload, git push, the Claude agent session — happens in the
 * `sower-resume-editor` Cloud Run Job; these routes only record resume_runs
 * rows, start Job executions (RESUME_RUN_ID env override), and serve reads.
 * The job writes status/transcript back to the run row directly, so the
 * dashboard polls GET /resumes/runs/:id.
 *
 * Fully dormant unless config.RESUME_EDITOR_ENABLED is true: every trigger
 * route answers 503 without touching the DB. All routes require x-api-key via
 * the server-wide preHandler.
 */

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

// The manual editor's full .tex source. 200k chars comfortably fits any
// real resume source while bounding the run row's prompt column.
const editBodySchema = z.object({
  content: z.string().min(1).max(200_000),
});

// The natural-language change request for an agent run.
const askBodySchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
});

/**
 * Start the resume-editor Job for a freshly inserted run row. Never throws:
 * the 'running' run row is the visible breadcrumb either way, and the caller
 * reports `fired` honestly so the dashboard can message a Job that failed to
 * start (the row would otherwise sit 'running' forever).
 */
async function fireResumeJob(deps: Deps, runId: string): Promise<boolean> {
  try {
    await runCloudJob(deps, deps.config.RESUME_EDITOR_JOB_NAME, {
      RESUME_RUN_ID: runId,
    });
    return true;
  } catch (error) {
    console.error(
      `[sower] resume-editor job start failed for run ${runId}:`,
      error,
    );
    return false;
  }
}

export function registerResumeRoutes(app: FastifyInstance, deps: Deps): void {
  // List every known resume with its latest run (the dashboard's index).
  app.get('/resumes', async () => {
    const rows = await deps.db.select().from(resumes).orderBy(resumes.name);
    // Latest run per resume, resolved in JS from one recency-ordered query:
    // simpler than DISTINCT ON and plenty for a personal-scale table. The cap
    // bounds the scan; runs beyond it are older than any resume's latest.
    const runs = await deps.db
      .select()
      .from(resumeRuns)
      .where(isNotNull(resumeRuns.resumeId))
      .orderBy(desc(resumeRuns.startedAt))
      .limit(200);
    const latestByResume = new Map<string, ResumeRun>();
    for (const run of runs) {
      if (run.resumeId !== null && !latestByResume.has(run.resumeId)) {
        latestByResume.set(run.resumeId, run);
      }
    }
    return {
      resumes: rows.map((resume) => ({
        ...resume,
        latestRun: latestByResume.get(resume.id) ?? null,
      })),
    };
  });

  // Repo-wide sync: compile every developer/resumes/*.tex, refresh vault
  // PDFs + resumes rows. No commits. Returns the run id to poll.
  app.post('/resumes/sync', async (_request, reply) => {
    if (!deps.config.RESUME_EDITOR_ENABLED) {
      return reply.code(503).send({
        error: 'resume editor is not enabled (RESUME_EDITOR_ENABLED)',
      });
    }
    const inserted = await deps.db
      .insert(resumeRuns)
      .values({ kind: 'sync', status: 'running' })
      .returning({ id: resumeRuns.id });
    const runId = inserted[0]?.id;
    if (runId === undefined) {
      return reply.code(500).send({ error: 'failed to record resume run' });
    }
    const fired = await fireResumeJob(deps, runId);
    return reply.code(200).send({ runId, fired });
  });

  // Manual editor save: the job writes the full source to the submodule,
  // commits + pushes (submodule then parent pointer), recompiles, re-uploads.
  app.post('/resumes/:id/edit', async (request, reply) => {
    if (!deps.config.RESUME_EDITOR_ENABLED) {
      return reply.code(503).send({
        error: 'resume editor is not enabled (RESUME_EDITOR_ENABLED)',
      });
    }
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid resume id', issues: params.error.issues });
    }
    const body = editBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
    }
    const rows = await deps.db
      .select()
      .from(resumes)
      .where(eq(resumes.id, params.data.id))
      .limit(1);
    const resume = rows[0];
    if (!resume) {
      return reply.code(404).send({ error: 'resume not found' });
    }
    const inserted = await deps.db
      .insert(resumeRuns)
      .values({
        resumeId: resume.id,
        kind: 'write',
        // The job re-parses this JSON; texPath rides along so the write
        // needs no second lookup and survives a later texPath rename.
        prompt: JSON.stringify({
          texPath: resume.texPath,
          content: body.data.content,
        }),
        status: 'running',
      })
      .returning({ id: resumeRuns.id });
    const runId = inserted[0]?.id;
    if (runId === undefined) {
      return reply.code(500).send({ error: 'failed to record resume run' });
    }
    const fired = await fireResumeJob(deps, runId);
    return reply.code(200).send({ runId, fired });
  });

  // Natural-language change request: the job runs a Claude Agent SDK session
  // inside the portfolio checkout, which edits, verifies the compile,
  // commits, and pushes.
  app.post('/resumes/:id/ask', async (request, reply) => {
    if (!deps.config.RESUME_EDITOR_ENABLED) {
      return reply.code(503).send({
        error: 'resume editor is not enabled (RESUME_EDITOR_ENABLED)',
      });
    }
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid resume id', issues: params.error.issues });
    }
    const body = askBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
    }
    const rows = await deps.db
      .select({ id: resumes.id })
      .from(resumes)
      .where(eq(resumes.id, params.data.id))
      .limit(1);
    const resume = rows[0];
    if (!resume) {
      return reply.code(404).send({ error: 'resume not found' });
    }
    const inserted = await deps.db
      .insert(resumeRuns)
      .values({
        resumeId: resume.id,
        kind: 'agent',
        prompt: body.data.prompt,
        status: 'running',
      })
      .returning({ id: resumeRuns.id });
    const runId = inserted[0]?.id;
    if (runId === undefined) {
      return reply.code(500).send({ error: 'failed to record resume run' });
    }
    const fired = await fireResumeJob(deps, runId);
    return reply.code(200).send({ runId, fired });
  });

  // Run status/transcript — what the dashboard polls after sync/edit/ask.
  app.get('/resumes/runs/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid run id', issues: params.error.issues });
    }
    const rows = await deps.db
      .select()
      .from(resumeRuns)
      .where(eq(resumeRuns.id, params.data.id))
      .limit(1);
    const run = rows[0];
    if (!run) {
      return reply.code(404).send({ error: 'run not found' });
    }
    return { run };
  });
}
