import {
  type Database,
  documents,
  type ResumeVersionKind,
  resumes,
  resumeVersions,
} from '@sower/db';
import type { Storage } from '@sower/storage';
import { desc, eq } from 'drizzle-orm';

/**
 * Publish one compiled resume: upload the PDF to the vault (fixed path,
 * overwritten every time) and upsert the resumes row + its auto-registered
 * kind='resume' documents row. The documents row is UPDATED via
 * resumes.documentId when one exists, so repeated syncs refresh a single
 * document instead of piling up duplicates in the library.
 *
 * VERSIONING: when the caller provides `version` (every mode does), the same
 * compile output is ALSO uploaded to the per-commit vault path
 * (resumes/<name>/versions/<sha>.pdf — cheap, it is already in memory) and a
 * resume_versions row is recorded. Idempotent on (resumeId, commitSha) via
 * ON CONFLICT DO NOTHING, so Cloud Run retries never duplicate history.
 * kind='sync' additionally skips recording when the tex matches the latest
 * recorded version (the repo did not drift; only the sha moved) — but a
 * resume with ZERO versions always gets its current state backfilled as the
 * first version.
 */

export interface PublishVersion {
  kind: ResumeVersionKind;
  /** The resume_runs row driving this publish (null when none). */
  runId: string | null;
}

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
  /**
   * Record a resume_versions row (+ the per-commit PDF copy) for this
   * publish. Skipped when commitSha is null — a version without a commit
   * identity would break the idempotence key.
   */
  version?: PublishVersion;
}

export function vaultPathFor(name: string): string {
  return `resumes/${name}/${name}.pdf`;
}

/** Immutable per-commit PDF path, next to the latest-pointer upload. */
export function versionPdfPathFor(name: string, commitSha: string): string {
  return `resumes/${name}/versions/${commitSha}.pdf`;
}

export interface VersionInput {
  resumeId: string;
  name: string;
  commitSha: string;
  texSource: string;
  pdf: Buffer;
  kind: ResumeVersionKind;
  runId: string | null;
}

/**
 * Record one resume_versions row + its vault PDF copy. kind='sync' compares
 * against the latest recorded version first: an unchanged tex records
 * nothing (the repo merely moved on other files), while a resume with no
 * versions yet gets its current state as the backfilled first version.
 * Returns whether a version was (re-)recorded.
 */
export async function recordResumeVersion(
  db: Database,
  storage: Storage,
  input: VersionInput,
): Promise<{ recorded: boolean }> {
  if (input.kind === 'sync') {
    const latestRows = await db
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.resumeId, input.resumeId))
      .orderBy(desc(resumeVersions.createdAt))
      .limit(1);
    const latest = latestRows[0];
    if (latest && latest.texSource === input.texSource) {
      // Nothing changed since the last recorded version — no new history.
      return { recorded: false };
    }
  }
  const pdfStoragePath = versionPdfPathFor(input.name, input.commitSha);
  await storage.put(pdfStoragePath, input.pdf, 'application/pdf');
  await db
    .insert(resumeVersions)
    .values({
      resumeId: input.resumeId,
      commitSha: input.commitSha,
      texSource: input.texSource,
      pdfStoragePath,
      runId: input.runId,
      kind: input.kind,
    })
    .onConflictDoNothing({
      target: [resumeVersions.resumeId, resumeVersions.commitSha],
    });
  return { recorded: true };
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

  let resumeId: string | null;
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
    resumeId = existing.id;
  } else {
    const insertedDoc = await db
      .insert(documents)
      .values(documentValues)
      .returning({ id: documents.id });
    const insertedResume = await db
      .insert(resumes)
      .values({
        name: input.name,
        texPath: input.texPath,
        texSource: input.texSource,
        pdfStoragePath: storagePath,
        lastCommitSha: input.commitSha,
        documentId: insertedDoc[0]?.id ?? null,
        updatedAt: new Date(),
      })
      .returning({ id: resumes.id });
    resumeId = insertedResume[0]?.id ?? null;
  }

  if (input.version && input.commitSha !== null && resumeId !== null) {
    await recordResumeVersion(db, storage, {
      resumeId,
      name: input.name,
      commitSha: input.commitSha,
      texSource: input.texSource,
      pdf: input.pdf,
      kind: input.version.kind,
      runId: input.version.runId,
    });
  }

  return { storagePath };
}
