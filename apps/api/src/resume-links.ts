import { randomBytes } from 'node:crypto';
import { type ResumeLink, resumeLinks, resumes } from '@sower/db';
import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from './types.js';

/**
 * Resume share links: named, revocable public URLs (/r/<token>) that always
 * serve the resume's CURRENT PDF — send a recruiter one link and every later
 * edit is what they see.
 *
 * SECURITY POSTURE of GET /r/:token (the ONLY x-api-key-exempt data route,
 * see the preHandler in server.ts):
 * - the token IS the auth: 32 url-safe chars from 24 crypto-random bytes
 *   (192 bits — unguessable, unbruteforceable);
 * - revocation is enabled=false (disable route below): a disabled or
 *   unknown token is a plain 404 with NO db write, so scanning tokens costs
 *   us one indexed SELECT and nothing else (rate-limit friendly);
 * - the storage path comes only from OUR resumes row, never from input;
 * - `cache-control: no-store` so a revoked link stops working immediately
 *   and viewers always fetch the current PDF.
 *
 * View stats (viewCount/lastViewedAt) are best-effort: a failed stat write
 * never breaks the PDF response.
 */

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

const linkIdParamsSchema = z.object({
  linkId: z.string().uuid(),
});

// The link's human label ('Stripe application') — shown in the dashboard,
// never to the public viewer.
const createLinkBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
});

/** Base64url token chars only — anything else can NEVER be a valid token. */
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

/** 24 crypto-random bytes -> 32 url-safe chars (192 bits of entropy). */
export function generateLinkToken(): string {
  return randomBytes(24).toString('base64url');
}

/** The public URL for a link: configured base first, request host second. */
function publicUrlFor(
  deps: Deps,
  request: FastifyRequest,
  token: string,
): string {
  const configured = deps.config.PUBLIC_API_BASE_URL?.replace(/\/$/, '');
  const base =
    configured ?? `${request.protocol}://${request.headers.host ?? ''}`;
  return `${base}/r/${token}`;
}

function withUrl(deps: Deps, request: FastifyRequest, link: ResumeLink) {
  return { ...link, url: publicUrlFor(deps, request, link.token) };
}

export function registerResumeLinkRoutes(
  app: FastifyInstance,
  deps: Deps,
): void {
  // Create a named share link for a resume.
  app.post('/resumes/:id/links', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid resume id', issues: params.error.issues });
    }
    const body = createLinkBodySchema.safeParse(request.body);
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
    if (!rows[0]) {
      return reply.code(404).send({ error: 'resume not found' });
    }
    const inserted = await deps.db
      .insert(resumeLinks)
      .values({
        resumeId: params.data.id,
        name: body.data.name,
        token: generateLinkToken(),
      })
      .returning();
    const link = inserted[0];
    if (!link) {
      return reply.code(500).send({ error: 'failed to create share link' });
    }
    return reply.code(200).send({ link: withUrl(deps, request, link) });
  });

  // List a resume's share links (newest first), each with its public URL.
  app.get('/resumes/:id/links', async (request, reply) => {
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
    const links = await deps.db
      .select()
      .from(resumeLinks)
      .where(eq(resumeLinks.resumeId, params.data.id))
      .orderBy(desc(resumeLinks.createdAt));
    return {
      links: links.map((link) => withUrl(deps, request, link)),
    };
  });

  // Disable (revoke) / re-enable a link. Disable IS the revoke — the row
  // stays for its stats, and re-enabling restores the same URL. Idempotent.
  for (const enabled of [false, true]) {
    const action = enabled ? 'enable' : 'disable';
    app.post(`/resumes/links/:linkId/${action}`, async (request, reply) => {
      const params = linkIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .code(400)
          .send({ error: 'invalid link id', issues: params.error.issues });
      }
      const updated = await deps.db
        .update(resumeLinks)
        .set({ enabled })
        .where(eq(resumeLinks.id, params.data.linkId))
        .returning();
      const link = updated[0];
      if (!link) {
        return reply.code(404).send({ error: 'link not found' });
      }
      return reply.code(200).send({ link: withUrl(deps, request, link) });
    });
  }

  // PUBLIC route — exempt from x-api-key (see the server.ts preHandler):
  // the unguessable token is the auth. Serves the resume's CURRENT PDF
  // inline; disabled/unknown tokens are indistinguishable plain 404s with
  // no DB write.
  app.get('/r/:token', async (request, reply) => {
    const token = (request.params as { token?: unknown }).token;
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
      // Malformed tokens never reach the DB.
      return reply.code(404).type('text/plain').send('not found');
    }
    const linkRows = await deps.db
      .select()
      .from(resumeLinks)
      .where(eq(resumeLinks.token, token))
      .limit(1);
    const link = linkRows[0];
    // Disabled and unknown are indistinguishable 404s (revoked = gone).
    if (!link?.enabled) {
      return reply.code(404).type('text/plain').send('not found');
    }
    const resumeRows = await deps.db
      .select()
      .from(resumes)
      .where(eq(resumes.id, link.resumeId))
      .limit(1);
    const resume = resumeRows[0];
    if (!resume?.pdfStoragePath || !deps.storage) {
      return reply.code(404).type('text/plain').send('not found');
    }
    let pdf: Buffer;
    try {
      pdf = await deps.storage.get(resume.pdfStoragePath);
    } catch {
      // Row exists but the blob is gone (vault pruned / misconfigured).
      return reply.code(404).type('text/plain').send('not found');
    }
    // Best-effort view stats — never let a stat hiccup break the response.
    try {
      await deps.db
        .update(resumeLinks)
        .set({
          viewCount: sql`${resumeLinks.viewCount} + 1`,
          lastViewedAt: new Date(),
        })
        .where(eq(resumeLinks.id, link.id));
    } catch (error) {
      console.error('[sower] share-link view stat write failed:', error);
    }
    return (
      reply
        .code(200)
        .header('content-type', 'application/pdf')
        .header('content-disposition', `inline; filename="${resume.name}.pdf"`)
        // Always-current + instantly revocable: nothing may cache the bytes.
        .header('cache-control', 'no-store')
        .send(pdf)
    );
  });
}
