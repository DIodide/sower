import { emptyProfile, ProfileSchema } from '@sower/answers';
import { profiles } from '@sower/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Deps } from './types.js';

/**
 * Profile routes (/profile): the dashboard's window onto the single stored
 * answer-resolution profile (Answers → Profile). SINGLE-PROFILE-PER-
 * DEPLOYMENT: one `profiles` row is expected; PUT upserts that first row
 * (update when one exists, insert otherwise) rather than ever creating a
 * second, and GET serves the newest row by updated_at. The DB row is the
 * source of truth — the legacy PROFILE_PATH YAML file is only getProfile's
 * dev fallback and is never read here.
 *
 * Both routes require x-api-key via the server-wide preHandler.
 */
export function registerProfileRoutes(app: FastifyInstance, deps: Deps): void {
  // The stored profile (or the empty profile when none is configured yet,
  // so the editor always has a well-typed document to render).
  app.get('/profile', async () => {
    const rows = await deps.db.select().from(profiles);
    const row = [...rows].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    )[0];
    if (row === undefined) {
      return { profile: emptyProfile(), updatedAt: null, configured: false };
    }
    return { profile: row.data, updatedAt: row.updatedAt, configured: true };
  });

  // Full-document save: the body must be a COMPLETE valid profile
  // (ProfileSchema — the same validation the YAML loader applied), so a
  // half-filled editor can never store a profile that resolution would
  // reject at read time.
  app.put('/profile', async (request, reply) => {
    const parsed = ProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid profile', issues: parsed.error.issues });
    }
    const now = new Date();
    const existing = await deps.db
      .select({ id: profiles.id })
      .from(profiles)
      .limit(1);
    const id = existing[0]?.id;
    if (id === undefined) {
      await deps.db
        .insert(profiles)
        .values({ data: parsed.data, updatedAt: now });
    } else {
      await deps.db
        .update(profiles)
        .set({ data: parsed.data, updatedAt: now })
        .where(eq(profiles.id, id));
    }
    return reply.code(200).send({ ok: true, updatedAt: now.toISOString() });
  });
}
