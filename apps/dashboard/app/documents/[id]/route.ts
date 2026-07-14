import { documents } from '@sower/db';
import { createStorage } from '@sower/storage';
import { eq } from 'drizzle-orm';
import { getDb } from '../../../lib/db';

export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Serve a stored document's bytes (e.g. an ingested screenshot rendered on the
 * task page). IAP-gated like every other dashboard route; the id is validated
 * and the storage path comes only from OUR documents row, never from input.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return new Response('not found', { status: 404 });
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.id, id))
    .limit(1);
  const doc = rows[0];
  if (!doc) {
    return new Response('not found', { status: 404 });
  }

  let buffer: Buffer;
  try {
    buffer = await createStorage().get(doc.storagePath);
  } catch {
    // Row exists but the blob is gone (vault pruned / misconfigured).
    return new Response('not found', { status: 404 });
  }

  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type': doc.contentType ?? 'application/octet-stream',
      'cache-control': 'private, max-age=3600',
    },
  });
}
