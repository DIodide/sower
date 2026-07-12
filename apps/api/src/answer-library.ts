import { normalizeCompanyKey, normalizeLabel } from '@sower/answers';
import { type Answer, answers, type NewAnswer } from '@sower/db';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from './types.js';

/**
 * Company-scoped answer library CRUD (/answer-library).
 *
 * Rows live in the answers table, uniquely keyed by (company, normalized_label)
 * where company is a normalized companyKey (lowercase, trimmed) and the empty
 * string means GLOBAL — the answer may resolve for any company, but only when
 * no company-scoped answer for the same question exists (see @sower/answers).
 * All routes require the x-api-key header via the server-wide preHandler.
 *
 * TRUTHFULNESS: this API only stores and returns values the user typed in.
 * Resolution (process.ts -> resolveAnswers) copies them verbatim; nothing is
 * fabricated, and a question with no stored answer stays NEEDS_INPUT.
 */

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

const listQuerySchema = z.object({
  company: z.string().optional(),
});

// Values are strings (text/textarea/select) or string arrays (multiselect) —
// the same shapes the NEEDS_INPUT form saves and resolveAnswers consumes.
const valueSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
]);

const createBodySchema = z.object({
  /** Company scope; omitted or '' = global. Normalized to companyKey. */
  company: z.string().optional(),
  questionLabel: z.string().min(1),
  value: valueSchema,
});

const updateBodySchema = z.object({
  value: valueSchema,
  questionLabel: z.string().min(1).optional(),
  company: z.string().optional(),
});

/** Public row shape: {id, company, questionLabel, normalizedLabel, value, updatedAt}. */
function toLibraryRow(row: Answer) {
  return {
    id: row.id,
    company: row.company,
    questionLabel: row.questionLabel,
    normalizedLabel: row.normalizedLabel,
    value: row.value,
    // The answers table has no updated_at column; created_at doubles as the
    // last-write timestamp because every upsert/edit below bumps it.
    updatedAt: row.createdAt,
  };
}

/**
 * True for a Postgres unique-constraint violation (SQLSTATE 23505), whether
 * the driver error is surfaced directly or wrapped (drizzle's query error
 * keeps the postgres error as `cause`).
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if ((error as { code?: unknown }).code === '23505') {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === '23505'
  );
}

export function registerAnswerLibraryRoutes(
  app: FastifyInstance,
  deps: Deps,
): void {
  // List the whole library, optionally filtered to one scope:
  //   GET /answer-library            -> every entry (global + all companies)
  //   GET /answer-library?company=X  -> only entries scoped to companyKey(X)
  //   GET /answer-library?company=   -> only GLOBAL entries
  // The filter is applied in JS on the normalized companyKey (the library is
  // a small personal dataset, and this keeps company normalization in exactly
  // one place instead of duplicating it into SQL).
  app.get('/answer-library', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid query', issues: parsed.error.issues });
    }
    const rows = await deps.db
      .select({
        id: answers.id,
        company: answers.company,
        questionLabel: answers.questionLabel,
        normalizedLabel: answers.normalizedLabel,
        value: answers.value,
        updatedAt: answers.createdAt,
      })
      .from(answers)
      .orderBy(asc(answers.company), asc(answers.normalizedLabel));
    const companyFilter = parsed.data.company;
    if (companyFilter === undefined) {
      return { answers: rows };
    }
    const companyKey = normalizeCompanyKey(companyFilter);
    // Stored companies are already companyKeys; normalizing the row side too
    // costs nothing and keeps isolation correct even for legacy rows.
    return {
      answers: rows.filter(
        (row) => normalizeCompanyKey(row.company) === companyKey,
      ),
    };
  });

  // Upsert by (companyKey, normalizedLabel(questionLabel)) — the answers
  // table's unique index. Re-posting the same (company, question) replaces the
  // stored value instead of erroring, which is what "save this answer" means.
  app.post('/answer-library', async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: parsed.error.issues });
    }
    const companyKey = normalizeCompanyKey(parsed.data.company);
    const questionLabel = parsed.data.questionLabel.trim();
    const normalizedLabel = normalizeLabel(questionLabel);
    if (normalizedLabel === '') {
      return reply
        .code(400)
        .send({ error: 'questionLabel must contain letters or numbers' });
    }
    const rows = await deps.db
      .insert(answers)
      .values({
        company: companyKey,
        questionLabel,
        normalizedLabel,
        value: parsed.data.value,
        source: 'user',
      })
      .onConflictDoUpdate({
        target: [answers.company, answers.normalizedLabel],
        set: {
          questionLabel,
          value: parsed.data.value,
          source: 'user',
          // No updated_at column: bump created_at as the last-write time.
          createdAt: new Date(),
        },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      return reply.code(500).send({ error: 'upsert returned no row' });
    }
    return reply.code(200).send({ answer: toLibraryRow(row) });
  });

  // Edit an entry in place. questionLabel changes recompute normalizedLabel;
  // company changes re-normalize to companyKey. Rescoping onto an existing
  // (company, question) pair violates the unique index -> 409, never a 500.
  app.put('/answer-library/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid answer id', issues: params.error.issues });
    }
    const parsed = updateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: parsed.error.issues });
    }
    const set: Partial<NewAnswer> = {
      value: parsed.data.value,
      // No updated_at column: bump created_at as the last-write time.
      createdAt: new Date(),
    };
    if (parsed.data.questionLabel !== undefined) {
      const questionLabel = parsed.data.questionLabel.trim();
      const normalizedLabel = normalizeLabel(questionLabel);
      if (normalizedLabel === '') {
        return reply
          .code(400)
          .send({ error: 'questionLabel must contain letters or numbers' });
      }
      set.questionLabel = questionLabel;
      set.normalizedLabel = normalizedLabel;
    }
    if (parsed.data.company !== undefined) {
      set.company = normalizeCompanyKey(parsed.data.company);
    }
    try {
      const rows = await deps.db
        .update(answers)
        .set(set)
        .where(eq(answers.id, params.data.id))
        .returning();
      const row = rows[0];
      if (row === undefined) {
        return reply.code(404).send({ error: 'answer not found' });
      }
      return reply.code(200).send({ answer: toLibraryRow(row) });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({
          error: 'an answer for that company and question already exists',
        });
      }
      throw error;
    }
  });

  app.delete('/answer-library/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid answer id', issues: params.error.issues });
    }
    const rows = await deps.db
      .delete(answers)
      .where(eq(answers.id, params.data.id))
      .returning({ id: answers.id });
    if (rows[0] === undefined) {
      return reply.code(404).send({ error: 'answer not found' });
    }
    return reply.code(200).send({ deleted: true });
  });
}
