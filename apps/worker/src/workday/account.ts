import type { WorkdayPage } from './page.js';
import { WORKDAY_IDS } from './selectors.js';

/**
 * The credential the browser tier signs in with — the subset of
 * @sower/accounts AccountCredential the flow needs (kept local so this module
 * has no dependency on the accounts package's shape).
 */
export interface BrowserCredential {
  email: string;
  password: string;
}

/** Whether to sign into an existing account or create a new one. */
export type AccountIntent = 'sign-in' | 'create';

export type AccountOutcome = 'signed-in' | 'created' | 'needs-otp' | 'failed';

/**
 * Bootstrap the candidate-account session after the Apply button has routed
 * to Workday's auth page.
 *
 * - intent 'sign-in': existing account -> fill email/password -> submit.
 * - intent 'create':  new account -> fill email/password/verify -> agree ->
 *   submit.
 *
 * Either path may hit an email-verification wall; when the OTP input appears
 * after submit, returns 'needs-otp' (the worker parks the task in
 * AWAITING_OTP and resumes with the code). Returns 'failed' when the expected
 * controls are not present (the auth page changed / an error is shown).
 *
 * This module NEVER touches an application-submit control — only the auth
 * form's own submit button.
 */
export async function bootstrapAccount(
  page: WorkdayPage,
  credential: BrowserCredential,
  intent: AccountIntent,
): Promise<AccountOutcome> {
  if (intent === 'create') {
    return createAccount(page, credential);
  }
  return signIn(page, credential);
}

async function signIn(
  page: WorkdayPage,
  credential: BrowserCredential,
): Promise<AccountOutcome> {
  // Workday sometimes lands on the create-account view first; switch to
  // sign-in when that link is offered.
  if (await page.isPresent(WORKDAY_IDS.signInLink)) {
    await page.clickFirst(WORKDAY_IDS.signInLink);
  }
  const email = await page.fillFirst(WORKDAY_IDS.email, credential.email);
  const password = await page.fillFirst(
    WORKDAY_IDS.password,
    credential.password,
  );
  if (!email || !password) {
    return 'failed';
  }
  if (!(await page.clickFirst(WORKDAY_IDS.signInSubmit))) {
    return 'failed';
  }
  return afterAuthSubmit(page, 'signed-in');
}

async function createAccount(
  page: WorkdayPage,
  credential: BrowserCredential,
): Promise<AccountOutcome> {
  // Switch to the create-account view when the link is offered.
  if (await page.isPresent(WORKDAY_IDS.createAccountLink)) {
    await page.clickFirst(WORKDAY_IDS.createAccountLink);
  }
  const email = await page.fillFirst(WORKDAY_IDS.email, credential.email);
  const password = await page.fillFirst(
    WORKDAY_IDS.password,
    credential.password,
  );
  if (!email || !password) {
    return 'failed';
  }
  // Workday's create-account form has a "verify password" field; fill it when
  // present (some tenants omit it).
  await page.fillFirst(WORKDAY_IDS.verifyPassword, credential.password);
  // The "I agree / create account" consent checkbox, when present, is required.
  await page.checkFirst(WORKDAY_IDS.createAccountCheckbox);
  if (!(await page.clickFirst(WORKDAY_IDS.createAccountSubmit))) {
    return 'failed';
  }
  return afterAuthSubmit(page, 'created');
}

/**
 * After an auth submit: if an OTP/verification input appeared, the tenant
 * requires email verification -> 'needs-otp'. Otherwise the expected success
 * outcome. A still-present auth form (submit bounced) is a 'failed'.
 */
async function afterAuthSubmit(
  page: WorkdayPage,
  success: Extract<AccountOutcome, 'signed-in' | 'created'>,
): Promise<AccountOutcome> {
  if (await page.isPresent(WORKDAY_IDS.verificationCodeInput)) {
    return 'needs-otp';
  }
  return success;
}

/**
 * Enter a verification code into the OTP wall and submit. Returns true when
 * the code was entered and the verify button clicked; the worker re-checks
 * the page afterwards to decide success vs. a rejected code.
 */
export async function submitVerificationCode(
  page: WorkdayPage,
  code: string,
): Promise<boolean> {
  const filled = await page.fillFirst(WORKDAY_IDS.verificationCodeInput, code);
  if (!filled) {
    return false;
  }
  return page.clickFirst(WORKDAY_IDS.verifyEmailSubmit);
}
