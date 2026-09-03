import { documents } from '@sower/db';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from './types.js';

/**
 * The document library over the api, for the fill runner (and the cli):
 * what is stored, and the bytes of one document so a browser fill can put
 * it in a form's file input. x-api-key via the server-wide preHandler.
 */

const idParamsSchema = z.object({ id: z.string().uuid() });

export function registerDocumentRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/documents', async () => {
    const rows = await deps.db
      .select({
        id: documents.id,
        kind: documents.kind,
        filename: documents.filename,
        storagePath: documents.storagePath,
        contentType: documents.contentType,
        sizeBytes: documents.sizeBytes,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .orderBy(desc(documents.createdAt));
    return { documents: rows };
  });

  app.get('/documents/:id/content', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid document id' });
    }
    if (!deps.storage) {
      return reply.code(503).send({ error: 'vault storage not configured' });
    }
    const rows = await deps.db
      .select({
        filename: documents.filename,
        storagePath: documents.storagePath,
        contentType: documents.contentType,
      })
      .from(documents)
      .where(eq(documents.id, params.data.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return reply.code(404).send({ error: 'document not found' });
    }
    let bytes: Buffer;
    try {
      bytes = await deps.storage.get(row.storagePath);
    } catch (error) {
      request.log.warn(
        { err: error, storagePath: row.storagePath },
        'document bytes missing from the vault',
      );
      return reply.code(404).send({ error: 'document bytes not in the vault' });
    }
    // The filename travels in a header the runner can read; RFC 5987 keeps
    // non-ASCII names intact.
    const encoded = encodeURIComponent(row.filename);
    return reply
      .header('content-type', row.contentType ?? 'application/octet-stream')
      .header(
        'content-disposition',
        `attachment; filename="${row.filename.replace(/["\\]/g, '_')}"; filename*=UTF-8''${encoded}`,
      )
      .send(bytes);
  });
}
