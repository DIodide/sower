/**
 * E2E seeding helper (local only — refuses to run against a GCS vault).
 *
 * Picks ONE coverable NEEDS_INPUT task (job spec discovered, every required
 * missing question answerable), then:
 *   1. writes a fake resume into the local vault via @sower/storage and
 *      inserts the matching documents row (kind 'resume'; plus a cover
 *      letter document when a required cover-letter file question exists),
 *   2. upserts answers-bank rows for the remaining required questions —
 *      select/multiselect values are EXACT option labels copied from the
 *      task's own job_spec (never guessed), free-text gets a marker string.
 *
 * Prints a single JSON line: { taskId, resumePath, bankSeeded, seededDocs }.
 */
import { randomUUID } from 'node:crypto';
import { normalizeLabel } from '@sower/answers';
import type { Question } from '@sower/core';
import { answers, applicationTasks, createDb, documents } from '@sower/db';
import { createStorage } from '@sower/storage';
import { and, eq, isNotNull } from 'drizzle-orm';

type DocumentKind = 'resume' | 'cover_letter';

/** Classify a file question by its id/label (mirrors answer resolution). */
function fileKind(question: Question): DocumentKind | null {
  const idLabel = normalizeLabel(question.id);
  const label = normalizeLabel(question.label);
  if (
    question.id === 'resume' ||
    /\b(resume|cv)\b/.test(label) ||
    /\b(resume|cv)\b/.test(idLabel)
  ) {
    return 'resume';
  }
  if (
    question.id === 'cover_letter' ||
    /\bcover letter\b/.test(label) ||
    /\bcover letter\b/.test(idLabel)
  ) {
    return 'cover_letter';
  }
  return null;
}

/** Can this required-missing question be covered by seeded bank/documents? */
function isCoverable(question: Question): boolean {
  if (question.type === 'file') {
    return fileKind(question) !== null;
  }
  if (question.type === 'select' || question.type === 'multiselect') {
    return (question.options?.length ?? 0) > 0;
  }
  return normalizeLabel(question.label) !== '';
}

async function seedDocument(
  db: ReturnType<typeof createDb>,
  storage: ReturnType<typeof createStorage>,
  kind: DocumentKind,
): Promise<string> {
  const filename = kind === 'resume' ? 'resume.pdf' : 'cover-letter.pdf';
  const storagePath = `documents/${randomUUID()}/${filename}`;
  const bytes = Buffer.from(`%PDF-1.4\n% sower e2e fake ${kind}\n`);
  await storage.put(storagePath, bytes, 'application/pdf');
  await db.insert(documents).values({
    kind,
    filename,
    storagePath,
    contentType: 'application/pdf',
    sizeBytes: bytes.length,
  });
  return storagePath;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  if (process.env.VAULT_BUCKET) {
    throw new Error(
      'refusing to seed e2e data against a GCS vault — unset VAULT_BUCKET',
    );
  }
  const db = createDb(databaseUrl);
  const storage = createStorage();

  const tasks = await db
    .select()
    .from(applicationTasks)
    .where(
      and(
        eq(applicationTasks.state, 'NEEDS_INPUT'),
        isNotNull(applicationTasks.jobSpec),
        isNotNull(applicationTasks.resolution),
      ),
    );

  const candidate = tasks.find((task) => {
    const spec = task.jobSpec;
    const resolution = task.resolution;
    if (!spec || !resolution) {
      return false;
    }
    // The final e2e assertion needs the dry-run payload to reference the
    // resume, so the job must actually ask for one.
    const asksForResume = spec.questions.some(
      (question) => question.type === 'file' && fileKind(question) === 'resume',
    );
    if (!asksForResume) {
      return false;
    }
    return resolution.missing
      .filter((question) => question.required)
      .every(isCoverable);
  });
  if (!candidate?.jobSpec || !candidate.resolution) {
    console.error(
      'e2e-seed: no coverable NEEDS_INPUT task with a resume question found',
    );
    process.exit(1);
    return;
  }
  const requiredMissing = candidate.resolution.missing.filter(
    (question) => question.required,
  );

  // 1) Documents: always a resume; a cover letter only when required.
  const resumePath = await seedDocument(db, storage, 'resume');
  const seededDocs: string[] = [resumePath];
  const needsCoverLetter = requiredMissing.some(
    (question) =>
      question.type === 'file' && fileKind(question) === 'cover_letter',
  );
  if (needsCoverLetter) {
    seededDocs.push(await seedDocument(db, storage, 'cover_letter'));
  }

  // 2) Answers bank for the remaining required questions. Exact option
  // labels only for (multi)selects; last write wins on duplicate labels.
  const byNormalizedLabel = new Map<string, { label: string; value: string }>();
  for (const question of requiredMissing) {
    if (question.type === 'file') {
      continue;
    }
    const firstOption = question.options?.[0];
    const value = firstOption
      ? String(firstOption.label)
      : 'Sower e2e seeded answer';
    byNormalizedLabel.set(normalizeLabel(question.label), {
      label: question.label,
      value,
    });
  }
  for (const [normalized, entry] of byNormalizedLabel) {
    await db.delete(answers).where(eq(answers.normalizedLabel, normalized));
    await db.insert(answers).values({
      questionLabel: entry.label,
      normalizedLabel: normalized,
      value: entry.value,
      source: 'user',
    });
  }

  console.log(
    JSON.stringify({
      taskId: candidate.id,
      resumePath,
      bankSeeded: byNormalizedLabel.size,
      seededDocs,
    }),
  );
  process.exit(0);
}

main().catch((error) => {
  console.error('e2e-seed failed:', error);
  process.exit(1);
});
