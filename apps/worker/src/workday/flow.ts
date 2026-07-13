import type { Question, ResolvedAnswer } from '@sower/core';
import {
  type AccountIntent,
  type BrowserCredential,
  bootstrapAccount,
  submitVerificationCode,
} from './account.js';
import { rawFieldsToQuestions } from './field-map.js';
import { buildFillPlan } from './fill-plan.js';
import type { WorkdayPage } from './page.js';
import { isReviewStep, WORKDAY_IDS } from './selectors.js';

/**
 * Everything runApplyFlow needs that lives outside the browser: the
 * credential, an answer resolver (closes over profile + banks), file-byte
 * access for the resume, and a screenshot sink. Injecting these keeps the
 * flow testable against a fake page with no db/storage/Playwright.
 */
export interface FillContext {
  applyUrl: string;
  credential: BrowserCredential;
  /** 'create' on first application to a tenant, else 'sign-in'. */
  accountIntent: AccountIntent;
  /** Resolve answers for the scraped questions (never fabricates). */
  resolve(questions: Question[]): ResolvedAnswer[];
  /** Read a stored document's bytes for a file action; null if unavailable. */
  getFileBytes(storagePath: string): Promise<Uint8Array | null>;
  /** Persist a screenshot; returns its vault storage key. */
  saveScreenshot(png: Uint8Array, label: string): Promise<string>;
  /** A pending OTP code to consume when resuming from AWAITING_OTP. */
  pendingOtp?: string | null;
  /** Safety cap on questionnaire pages walked (default 10). */
  maxSteps?: number;
}

export interface FlowResult {
  outcome: 'filled' | 'needs-otp' | 'failed';
  screenshotPaths: string[];
  filledFieldCount: number;
  skippedRequired: number;
  reachedReview: boolean;
  detail: string;
}

const DEFAULT_MAX_STEPS = 10;

/** Click into the application form from the job posting's Apply entry points. */
async function clickApply(page: WorkdayPage): Promise<boolean> {
  let clicked = false;
  if (await page.clickFirst(WORKDAY_IDS.applyButton)) {
    clicked = true;
  }
  // Prefer manual entry (we control every field) over resume autofill.
  if (await page.clickFirst(WORKDAY_IDS.applyManually)) {
    clicked = true;
  }
  return clicked;
}

/**
 * Drive a Workday application from the job posting up to — but never
 * including — submission.
 *
 * GUARDRAIL (never submit): no code path here clicks the application Submit
 * control. The WorkdayPage interface exposes only `clickNext` (the per-page
 * "Next"), never a submit; and the loop BREAKS the moment the Review step is
 * reached. Submission remains a separate, human-approved, double-gated action.
 *
 * GUARDRAIL (never invent): fields are filled strictly from `resolve()` via
 * buildFillPlan — a question with no resolved answer is left blank.
 */
export async function runApplyFlow(
  page: WorkdayPage,
  ctx: FillContext,
): Promise<FlowResult> {
  const screenshotPaths: string[] = [];
  const capture = async (label: string): Promise<void> => {
    const png = await page.screenshot();
    screenshotPaths.push(await ctx.saveScreenshot(png, label));
  };

  await page.open(ctx.applyUrl);
  await clickApply(page);

  // Account bootstrap (create or sign-in), including an OTP wall.
  let account = await bootstrapAccount(page, ctx.credential, ctx.accountIntent);
  if (account === 'needs-otp') {
    if (ctx.pendingOtp) {
      // Resuming with a code: enter it and continue only if the wall clears.
      await submitVerificationCode(page, ctx.pendingOtp);
      if (await page.isPresent(WORKDAY_IDS.verificationCodeInput)) {
        await capture('otp-rejected');
        return {
          outcome: 'needs-otp',
          screenshotPaths,
          filledFieldCount: 0,
          skippedRequired: 0,
          reachedReview: false,
          detail: 'verification code was not accepted; a new code is needed',
        };
      }
      account = 'signed-in';
    } else {
      await capture('otp-wall');
      return {
        outcome: 'needs-otp',
        screenshotPaths,
        filledFieldCount: 0,
        skippedRequired: 0,
        reachedReview: false,
        detail:
          'email verification required before the application can proceed',
      };
    }
  }
  if (account === 'failed') {
    await capture('auth-failed');
    return {
      outcome: 'failed',
      screenshotPaths,
      filledFieldCount: 0,
      skippedRequired: 0,
      reachedReview: false,
      detail: 'could not establish the candidate-account session',
    };
  }

  // Walk the questionnaire pages, filling each, stopping at Review.
  let filledFieldCount = 0;
  let skippedRequired = 0;
  let reachedReview = false;
  const maxSteps = ctx.maxSteps ?? DEFAULT_MAX_STEPS;

  for (let step = 0; step < maxSteps; step++) {
    const heading = await page.heading();
    if (isReviewStep(heading)) {
      reachedReview = true;
      break;
    }

    const questions = rawFieldsToQuestions(await page.scrapeFields());
    const plan = buildFillPlan(questions, ctx.resolve(questions));
    for (const action of plan.actions) {
      const fileBytes =
        action.kind === 'file'
          ? ((await ctx.getFileBytes(action.storagePath)) ?? undefined)
          : undefined;
      if (await page.applyAction(action, fileBytes)) {
        filledFieldCount += 1;
      }
    }
    skippedRequired += plan.skippedRequired;
    await capture(`step-${step}`);

    // clickNext touches ONLY the "Next" control — never Submit. When there is
    // no Next (last page reached without a Review step), stop here.
    if (!(await page.clickNext())) {
      break;
    }
  }

  await capture(reachedReview ? 'review-stop' : 'filled-stop');
  return {
    outcome: 'filled',
    screenshotPaths,
    filledFieldCount,
    skippedRequired,
    reachedReview,
    detail: reachedReview
      ? 'reached the Review step and stopped before submit'
      : 'filled all reachable pages and stopped before submit',
  };
}
