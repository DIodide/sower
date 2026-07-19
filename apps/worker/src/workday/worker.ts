import type { AccountManager } from '@sower/accounts';
import type { AnswerBank, BankValue, Profile } from '@sower/answers';
import { resolveAnswers } from '@sower/answers';
import type { Question, ResolvedAnswer } from '@sower/core';
import type { ApplicationTask, Database } from '@sower/db';
import { answers, documents, jobs } from '@sower/db';
import type { Storage } from '@sower/storage';
import { eq } from 'drizzle-orm';
import type { BrowserWorker, FillArtifacts } from '../browser-worker.js';
import type { HarAttachmentPlan } from '../har.js';
import { type FillContext, runApplyFlow } from './flow.js';
import type { WorkdayPage } from './page.js';

/** A browser session the worker fills through, then closes. */
export interface WorkdayPageSession {
  page: WorkdayPage;
  close(): Promise<void>;
  /** Persist the captured HAR after close; null when none was captured. */
  finalizeHar?(): Promise<HarAttachmentPlan | null>;
}

/** Opens a page session for a task (default: launch Playwright). Injectable. */
export type OpenWorkdayPage = (taskId: string) => Promise<WorkdayPageSession>;

export interface WorkdayWorkerDeps {
  db: Database;
  storage: Storage;
  accounts: AccountManager;
  profile: Profile;
  answerBank?: AnswerBank;
  /** Opens the browser page; defaults to the Playwright launcher. */
  openPage: OpenWorkdayPage;
  /** Safety cap on questionnaire pages walked. */
  maxSteps?: number;
}

/**
 * The Workday browser tier (T1). Implements BrowserWorker.fill() for a
 * FILLING Workday task: signs into (or creates) the per-tenant candidate
 * account, walks the questionnaire filling strictly-resolved answers, and
 * STOPS before submit — returning FILLED (or NEED_OTP at a verification wall).
 *
 * All decision logic is the pure, tested flow (runApplyFlow); this class is
 * the wiring: credentials from the AccountManager, answers from the resolver,
 * screenshots/resume bytes from the vault.
 */
export function createWorkdayWorker(deps: WorkdayWorkerDeps): BrowserWorker {
  return {
    async fill(task: ApplicationTask): Promise<FillArtifacts> {
      const spec = task.jobSpec;
      if (spec?.platform !== 'workday') {
        throw new Error(
          `WorkdayBrowserWorker.fill: task ${task.id} is not a workday task`,
        );
      }

      const jobRows = await deps.db
        .select({
          company: jobs.company,
          tenant: jobs.tenant,
          url: jobs.url,
        })
        .from(jobs)
        .where(eq(jobs.id, task.jobId))
        .limit(1);
      const job = jobRows[0];

      const tenant = spec.tenant || job?.tenant || '';
      const site = (spec.meta?.site as string | undefined) ?? null;
      const applyUrl = spec.applyUrl || job?.url || '';
      if (!tenant || !applyUrl) {
        throw new Error(
          `WorkdayBrowserWorker.fill: task ${task.id} missing tenant/applyUrl`,
        );
      }

      // Provision or fetch the per-tenant candidate account.
      const { account, credential } = await deps.accounts.ensureAccount({
        platform: 'workday',
        tenant,
        site,
        email: deps.profile.email,
      });
      const accountIntent =
        account.status === 'provisioned' ? 'create' : 'sign-in';

      const resolve = await buildResolver(deps, task, job?.company ?? null);

      const session = await deps.openPage(task.id);
      let result: Awaited<ReturnType<typeof runApplyFlow>>;
      try {
        const ctx: FillContext = {
          applyUrl,
          credential: {
            email: credential.email,
            password: credential.password,
          },
          accountIntent,
          resolve,
          getFileBytes: (storagePath) =>
            readFileBytes(deps.storage, storagePath),
          saveScreenshot: (png, label) =>
            saveScreenshot(deps.storage, task.id, png, label),
          pendingOtp: task.pendingOtp,
          maxSteps: deps.maxSteps,
        };
        result = await runApplyFlow(session.page, ctx);
      } finally {
        await session.close();
      }

      const har = session.finalizeHar
        ? await session.finalizeHar().catch(() => null)
        : null;

      // Advance the account lifecycle from what actually happened.
      if (accountIntent === 'create' && result.outcome !== 'failed') {
        await deps.accounts.setStatus('workday', tenant, 'registered');
      }
      if (result.outcome === 'filled' && task.pendingOtp) {
        await deps.accounts.setStatus('workday', tenant, 'verified');
      }

      if (result.outcome === 'failed') {
        throw new Error(`workday fill failed: ${result.detail}`);
      }

      return {
        tier: 'T1',
        screenshotPaths: result.screenshotPaths,
        har,
        apiCalls: [],
        filledFieldCount: result.filledFieldCount,
        nextEvent: result.outcome === 'needs-otp' ? 'NEED_OTP' : 'FILLED',
        stoppedBeforeSubmit: true,
      };
    },
  };
}

/**
 * Build the answer resolver for a task, wiring the same sources as the api's
 * process.ts: profile + curated answer bank + company-scoped user bank +
 * stored documents. Returns a closure the flow calls per questionnaire page.
 */
async function buildResolver(
  deps: WorkdayWorkerDeps,
  task: ApplicationTask,
  jobCompany: string | null,
): Promise<(questions: Question[]) => ResolvedAnswer[]> {
  const bankRows = await deps.db
    .select({
      normalizedLabel: answers.normalizedLabel,
      value: answers.value,
      company: answers.company,
    })
    .from(answers);
  const documentRows = await deps.db
    .select({
      kind: documents.kind,
      storagePath: documents.storagePath,
      filename: documents.filename,
    })
    .from(documents);

  const companyKey = (jobCompany ?? task.jobSpec?.company ?? '')
    .toLowerCase()
    .trim();

  return (questions: Question[]): ResolvedAnswer[] =>
    resolveAnswers(questions, deps.profile, {
      bank: bankRows.map((row) => ({
        normalizedLabel: row.normalizedLabel,
        value: row.value as BankValue,
        company: row.company,
      })),
      documents: documentRows,
      answerBank: deps.answerBank,
      company: companyKey,
    }).resolved;
}

async function readFileBytes(
  storage: Storage,
  storagePath: string,
): Promise<Uint8Array | null> {
  try {
    return await storage.get(storagePath);
  } catch {
    return null;
  }
}

async function saveScreenshot(
  storage: Storage,
  taskId: string,
  png: Uint8Array,
  label: string,
): Promise<string> {
  const safeLabel = label.replace(/[^a-z0-9-]/gi, '_');
  const key = `tasks/${taskId}/screenshots/${safeLabel}.png`;
  await storage.put(key, png, 'image/png');
  return key;
}
