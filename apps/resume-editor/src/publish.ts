import { type Database, documents, resumes } from '@sower/db';
import type { Storage } from '@sower/storage';
import { eq } from 'drizzle-orm';

/**
 * Publish one compiled resume: upload the PDF to the vault (fixed path,
 * overwritten every time) and upsert the resumes row + its auto-registered
 * kind='resume' documents row. The documents row is UPDATED via
 * resumes.documentId when one exists, so repeated syncs refresh a single
 * document instead of piling up duplicates in the library.
 */

export interface PublishInput {
  /** The tex filename stem, e.g. 'swe-2027' (resumes.name upsert key). */
  name: string;
  /** Portfolio-repo-relative tex path, e.g. 'developer/resumes/swe-2027.tex'. */
  texPath: string;
  /** The LaTeX source the PDF was compiled from. */
  texSource: string;
  /** The compiled PDF bytes. */
  pdf: Buffer;
  /** Submodule HEAD the compile ran at. */
  commitSha: string | null;
}

export function vaultPathFor(name: string): string {
  return `resumes/${name}/${name}.pdf`;
}

export async function publishResume(
  db: Database,
  storage: Storage,
  input: PublishInput,
): Promise<{ storagePath: string }> {
  const storagePath = vaultPathFor(input.name);
  await storage.put(storagePath, input.pdf, 'application/pdf');

  const documentValues = {
    kind: 'resume',
    filename: `${input.name}.pdf`,
    storagePath,
    contentType: 'application/pdf',
    sizeBytes: input.pdf.length,
  };

  const existingRows = await db
    .select()
    .from(resumes)
    .where(eq(resumes.name, input.name))
    .limit(1);
  const existing = existingRows[0];

  if (existing) {
    let documentId = existing.documentId;
    if (documentId !== null) {
      await db
        .update(documents)
        .set(documentValues)
        .where(eq(documents.id, documentId));
    } else {
      const inserted = await db
        .insert(documents)
        .values(documentValues)
        .returning({ id: documents.id });
      documentId = inserted[0]?.id ?? null;
    }
    await db
      .update(resumes)
      .set({
        texPath: input.texPath,
        texSource: input.texSource,
        pdfStoragePath: storagePath,
        lastCommitSha: input.commitSha,
        documentId,
        updatedAt: new Date(),
      })
      .where(eq(resumes.id, existing.id));
  } else {
    const inserted = await db
      .insert(documents)
      .values(documentValues)
      .returning({ id: documents.id });
    await db.insert(resumes).values({
      name: input.name,
      texPath: input.texPath,
      texSource: input.texSource,
      pdfStoragePath: storagePath,
      lastCommitSha: input.commitSha,
      documentId: inserted[0]?.id ?? null,
      updatedAt: new Date(),
    });
  }

  return { storagePath };
}
