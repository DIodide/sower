import { resumes, resumeVersions } from '@sower/db';
import { createStorage } from '@sower/storage';
import { eq } from 'drizzle-orm';
import { getDb } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Serve one resume VERSION's PDF bytes from the vault (the immutable
 * resumes/<name>/versions/<sha>.pdf copy recorded by the resume-editor job).
 * IAP-gated like every dashboard route — the api deliberately has no
 * version-PDF streaming endpoint; internal viewing goes through here, the
 * same pattern as /documents/[id]. The id is validated and the storage path
 * comes only from OUR resume_versions row, never from input.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ versionId: string }> },
): Promise<Response> {
  const { versionId } = await params;
  if (!UUID_RE.test(versionId)) {
    return new Response('not found', { status: 404 });
  }

  const db = getDb();
  const rows = await db
    .select({ version: resumeVersions, resumeName: resumes.name })
    .from(resumeVersions)
    .innerJoin(resumes, eq(resumeVersions.resumeId, resumes.id))
    .where(eq(resumeVersions.id, versionId))
    .limit(1);
  const row = rows[0];
  // A version whose compile failed recorded its source but no PDF.
  if (!row?.version.pdfStoragePath) {
    return new Response('not found', { status: 404 });
  }

  let buffer: Buffer;
  try {
    buffer = await createStorage().get(row.version.pdfStoragePath);
  } catch {
    // Row exists but the blob is gone (vault pruned / misconfigured).
    return new Response('not found', { status: 404 });
  }

  const shortSha = row.version.commitSha.slice(0, 7);
  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${row.resumeName}-${shortSha}.pdf"`,
      // Version PDFs are immutable — cache freely within the session.
      'cache-control': 'private, max-age=3600',
    },
  });
}
