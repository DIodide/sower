/**
 * Cloud Run Job entrypoint for Tier-2 screenshot investigation.
 *
 * Thin driver: looks up the task's job's latest screenshot document, fetches
 * the image bytes from the vault, runs the @sower/investigate agent, and
 * POSTs `{ result, transcript }` back to the API. All agent logic lives in
 * @sower/investigate.
 *
 * Exit codes: 0 on success (or when there is nothing to do — no token / no
 * screenshot), 1 on failure so Cloud Run Jobs retries.
 */
import { pathToFileURL } from 'node:url';
import { applicationTasks, createDb, documents, jobs } from '@sower/db';
import { investigateScreenshot } from '@sower/investigate';
import { createStorage } from '@sower/storage';
import { and, desc, eq } from 'drizzle-orm';

export async function run(): Promise<number> {
  const taskId = process.env.TASK_ID || process.argv[2];
  if (!taskId) {
    console.error('investigator: no TASK_ID (env or argv) — nothing to do');
    return 1;
  }

  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.log('investigator: investigation disabled (no token)');
    return 0;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('investigator: DATABASE_URL is not set');
    return 1;
  }
  const apiBase = process.env.API_BASE;
  const apiKey = process.env.INGEST_API_KEY;
  if (!apiBase || !apiKey) {
    console.error('investigator: API_BASE and INGEST_API_KEY are required');
    return 1;
  }

  try {
    const db = createDb(databaseUrl);

    console.log(`investigator: task ${taskId} — loading task + screenshot`);
    const [task] = await db
      .select()
      .from(applicationTasks)
      .where(eq(applicationTasks.id, taskId))
      .limit(1);
    if (!task) {
      console.error(`investigator: task ${taskId} not found`);
      return 1;
    }

    const [job] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, task.jobId))
      .limit(1);

    const [screenshot] = await db
      .select()
      .from(documents)
      .where(
        and(eq(documents.jobId, task.jobId), eq(documents.kind, 'screenshot')),
      )
      .orderBy(desc(documents.createdAt))
      .limit(1);
    if (!screenshot) {
      console.log(
        `investigator: task ${taskId} — no screenshot document for job ${task.jobId}, exiting`,
      );
      return 0;
    }

    console.log(
      `investigator: fetching screenshot ${screenshot.id} (${screenshot.storagePath})`,
    );
    const image = await createStorage().get(screenshot.storagePath);

    const hintParts: string[] = [];
    if (job?.company) hintParts.push(`company: ${job.company}`);
    if (job?.title) hintParts.push(`role title: ${job.title}`);
    const hint = hintParts.length > 0 ? hintParts.join('; ') : undefined;

    console.log(
      `investigator: running investigation (${image.byteLength} bytes, hint=${hint ? 'yes' : 'no'})`,
    );
    const outcome = await investigateScreenshot({
      image,
      contentType: screenshot.contentType ?? 'image/png',
      hint,
    });
    console.log(
      `investigator: investigation done — found=${outcome.result.found} confidence=${outcome.result.confidence} steps=${outcome.transcript.length}`,
    );

    const url = `${apiBase.replace(/\/$/, '')}/tasks/${taskId}/investigation-result`;
    console.log(`investigator: POSTing result to ${url}`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        result: outcome.result,
        transcript: outcome.transcript,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `investigation-result POST failed: ${response.status} ${body.slice(0, 500)}`,
      );
    }

    console.log(`investigator: task ${taskId} complete`);
    return 0;
  } catch (error) {
    console.error(
      `investigator: task ${taskId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const code = await run();
  // Explicit exit: the postgres pool keeps the event loop alive otherwise.
  process.exit(code);
}
