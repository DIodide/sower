import { type ResumeRun, resumeRuns, resumes, resumeVersions } from '@sower/db';
import { desc, eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fetchIdToken } from './oidc.js';
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

// The editor buffer as-typed, compiled for PREVIEW only — nothing persisted.
// Same 200k cap as the edit body (and the compile service's own limit).
const compilePreviewBodySchema = z.object({
  source: z.string().min(1).max(200_000),
});

// A fork's new resume name: a filename stem / vault path segment — short,
// no path bits, no dots. Mirrors FORK_NAME_RE in @sower/resume-editor; the
// job re-validates and also probes the repo for a .tex collision.
const forkBodySchema = z.object({
  name: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9_-]{2,60}$/i,
      'name must be 2-60 letters/digits/dashes/underscores',
    ),
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
  //
  // The route reads NO body, but clients routinely send `content-type:
  // application/json` with an EMPTY body (bare curl -X POST, fetch wrappers
  // that always set the header), which Fastify's default parser rejects with
  // "Body cannot be empty…" before the handler ever runs. Registered inside
  // an encapsulated scope (the same pattern as /discord/interactions) whose
  // JSON parser tolerates an absent/empty body; non-empty JSON still parses
  // (so an explicit {} keeps working) and malformed JSON stays a 400. The
  // server-wide x-api-key preHandler applies inside the scope unchanged.
  app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_request, body, done) => {
        const text = typeof body === 'string' ? body : body.toString('utf8');
        if (text.trim() === '') {
          done(null, undefined);
          return;
        }
        try {
          done(null, JSON.parse(text));
        } catch (error) {
          const parseError =
            error instanceof Error ? error : new Error(String(error));
          Object.assign(parseError, { statusCode: 400 });
          done(parseError, undefined);
        }
      },
    );
    scope.post('/resumes/sync', async (_request, reply) => {
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

  // Fast compile preview: proxy the in-editor source to the IAM-gated
  // compile service (the resume-editor image in server mode, reached with a
  // metadata-server OIDC token) and pass its verdict through — {ok:true,
  // pdf:<base64>} or {ok:false, log}. Nothing is persisted and no Job runs;
  // a failed compile is an expected 200, only an unreachable/erroring
  // service is a 502. Gated on COMPILE_SERVICE_URL alone, not
  // RESUME_EDITOR_ENABLED: a preview writes nothing, so it is safe without
  // the Job pipeline. x-api-key comes from the server-wide preHandler.
  app.post('/resumes/:id/compile-preview', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid resume id', issues: params.error.issues });
    }
    const body = compilePreviewBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
    }
    const rows = await deps.db
      .select({ id: resumes.id, name: resumes.name })
      .from(resumes)
      .where(eq(resumes.id, params.data.id))
      .limit(1);
    const resume = rows[0];
    if (!resume) {
      return reply.code(404).send({ error: 'resume not found' });
    }
    const serviceUrl = deps.config.COMPILE_SERVICE_URL;
    if (serviceUrl === undefined || serviceUrl === '') {
      return reply
        .code(503)
        .send({ error: 'compile preview is not configured' });
    }
    try {
      // The audience must be the service's base URL exactly — Cloud Run IAM
      // rejects tokens minted for anything else.
      const token = await fetchIdToken(serviceUrl);
      const upstream = await fetch(`${serviceUrl}/compile`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ source: body.data.source, name: resume.name }),
        // Above the service's own 90s compile timeout, so ITS verdict
        // ('compile timed out') arrives instead of an abort here.
        signal: AbortSignal.timeout(100_000),
      });
      if (!upstream.ok) {
        request.log.error(
          `compile service answered HTTP ${upstream.status} for resume ${resume.id}`,
        );
        return reply.code(502).send({ error: 'compile service unavailable' });
      }
      const verdict = (await upstream.json()) as {
        ok: boolean;
        pdf?: string;
        log?: string;
      };
      return reply.code(200).send(verdict);
    } catch (error) {
      // OIDC mint (no metadata server off-GCP), network, and JSON failures
      // all land here: detail goes to the log, the client gets an opaque 502.
      request.log.error({ err: error }, 'compile preview upstream failed');
      return reply.code(502).send({ error: 'compile service unavailable' });
    }
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

  // Fork: copy an existing resume's current source to a brand-new
  // developer/resumes/<name>.tex. The job (clone-free — Contents API) reads
  // the source fresh from the repo, validates the compile BEFORE creating
  // anything, then registers the new resume + its first version.
  app.post('/resumes/:id/fork', async (request, reply) => {
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
    const body = forkBodySchema.safeParse(request.body);
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
    // Cheap early collision check on the resumes table; the job's Contents
    // GET on the target path is the definitive repo-side check.
    const collisions = await deps.db
      .select({ id: resumes.id })
      .from(resumes)
      .where(eq(resumes.name, body.data.name))
      .limit(1);
    if (collisions[0]) {
      return reply
        .code(409)
        .send({ error: `a resume named '${body.data.name}' already exists` });
    }
    const inserted = await deps.db
      .insert(resumeRuns)
      .values({
        // The SOURCE resume: the new one has no row until the job creates it.
        resumeId: resume.id,
        kind: 'fork',
        prompt: JSON.stringify({
          sourceResumeId: resume.id,
          newName: body.data.name,
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

  // Version history, newest first. Each row carries pdfStoragePath (the
  // immutable vault path resumes/<name>/versions/<sha>.pdf); the DASHBOARD
  // streams those bytes through its own IAP-gated route — the api serves no
  // version-PDF bytes, keeping this a pure metadata read.
  app.get('/resumes/:id/versions', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid resume id', issues: params.error.issues });
    }
    const rows = await deps.db
      .select({ id: resumes.id })
      .from(resumes)
      .where(eq(resumes.id, params.data.id))
      .limit(1);
    if (!rows[0]) {
      return reply.code(404).send({ error: 'resume not found' });
    }
    const versions = await deps.db
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.resumeId, params.data.id))
      .orderBy(desc(resumeVersions.createdAt));
    return { versions };
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
