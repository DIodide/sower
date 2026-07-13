/**
 * Run the Workday browser tier for ONE task — the observed first-run entry.
 *
 *   SOWER_WORKER_FILL_ENABLED=true \
 *   DATABASE_URL=... PROFILE_PATH=config/profile.yaml \
 *     pnpm --filter @sower/worker exec tsx scripts/workday-fill.ts <taskId> [--force] [--headful]
 *
 * Signs into (or creates) the tenant candidate account, walks the
 * questionnaire filling strictly-resolved answers, and STOPS before submit —
 * capturing screenshots to the vault. It then applies the resulting event to
 * the task (FILLED -> REVIEW, or NEED_OTP -> AWAITING_OTP).
 *
 * GUARDRAILS:
 * - Double env gate: refuses to run unless SOWER_WORKER_FILL_ENABLED === 'true'.
 * - It never clicks the application Submit control (see flow.ts).
 * - --force is required to move a parked (NEEDS_INPUT/REVIEW) task into FILLING
 *   for a manual first run; without it, only an already-FILLING task runs.
 */
import { AccountManager } from '@sower/accounts';
import { loadAnswerBank, loadProfile } from '@sower/answers';
import { transition } from '@sower/core';
import { applicationTasks, createDb, events } from '@sower/db';
import { createStorage } from '@sower/storage';
import { eq } from 'drizzle-orm';
import { createPlaywrightOpener } from '../src/workday/playwright-launcher.js';
import { createWorkdayWorker } from '../src/workday/worker.js';

async function main(): Promise<void> {
  if (process.env.SOWER_WORKER_FILL_ENABLED !== 'true') {
    console.error(
      'Refusing to run: set SOWER_WORKER_FILL_ENABLED=true to enable the browser tier.',
    );
    process.exit(2);
  }
  const taskId = process.argv[2];
  if (!taskId) {
    console.error('usage: workday-fill.ts <taskId> [--force] [--headful]');
    process.exit(1);
  }
  const force = process.argv.includes('--force');
  const headful = process.argv.includes('--headful');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }
  const db = createDb(databaseUrl);
  const storage = createStorage();
  const accounts = new AccountManager(db, storage);
  const profile = loadProfile(
    process.env.PROFILE_PATH ?? 'config/profile.yaml',
  );
  const answerBank = (() => {
    try {
      return loadAnswerBank(
        process.env.ANSWER_BANK_PATH ?? 'config/answer-bank.yaml',
      );
    } catch {
      return undefined;
    }
  })();

  const rows = await db
    .select()
    .from(applicationTasks)
    .where(eq(applicationTasks.id, taskId))
    .limit(1);
  const taskRow = rows[0];
  if (!taskRow) {
    console.error(`task ${taskId} not found`);
    process.exit(1);
  }

  // A first manual run typically starts from a parked (NEEDS_INPUT) Workday
  // task; --force moves it into FILLING (operator override for the observed
  // run — the automatic trigger integration comes later).
  if (taskRow.state !== 'FILLING') {
    if (!force) {
      console.error(
        `task is in ${taskRow.state}; pass --force to move it into FILLING for a manual run.`,
      );
      process.exit(1);
    }
    await db
      .update(applicationTasks)
      .set({ state: 'FILLING', updatedAt: new Date() })
      .where(eq(applicationTasks.id, taskId));
    await db.insert(events).values({
      taskId,
      type: 'APPROVED',
      fromState: taskRow.state,
      toState: 'FILLING',
      data: { via: 'operator-fill-cli' },
    });
    taskRow.state = 'FILLING';
  }

  const worker = createWorkdayWorker({
    db,
    storage,
    accounts,
    profile,
    answerBank,
    openPage: createPlaywrightOpener(storage, { headful }),
  });

  console.log(`Filling task ${taskId} …`);
  const artifacts = await worker.fill(taskRow);
  console.log('\nResult:');
  console.log(`  nextEvent:          ${artifacts.nextEvent}`);
  console.log(`  fields filled:      ${artifacts.filledFieldCount}`);
  console.log(`  stoppedBeforeSubmit: ${artifacts.stoppedBeforeSubmit}`);
  console.log(`  screenshots:        ${artifacts.screenshotPaths.length}`);
  for (const path of artifacts.screenshotPaths) console.log(`    - ${path}`);

  // Apply the event via the core state machine.
  const toState = transition('FILLING', artifacts.nextEvent);
  await db
    .update(applicationTasks)
    .set({ state: toState, updatedAt: new Date() })
    .where(eq(applicationTasks.id, taskId));
  await db.insert(events).values({
    taskId,
    type: artifacts.nextEvent,
    fromState: 'FILLING',
    toState,
    data: {
      filledFieldCount: artifacts.filledFieldCount,
      screenshots: artifacts.screenshotPaths.length,
    },
  });
  console.log(`\nTask moved FILLING -> ${toState}.`);
  if (artifacts.nextEvent === 'NEED_OTP') {
    console.log(
      'Enter the emailed code via the dashboard OTP box (or POST /tasks/:id/otp), then re-run this with the same task id to resume.',
    );
  } else {
    console.log(
      'Review the filled form in the screenshots before any submission. Submission stays a separate, human-approved, double-gated step.',
    );
  }
  process.exit(0);
}

main().catch((error) => {
  console.error('fill failed:', error);
  process.exit(1);
});
