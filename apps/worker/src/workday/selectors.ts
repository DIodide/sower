/**
 * Workday DOM conventions for the candidate apply flow.
 *
 * Workday renders every meaningful control with a stable
 * `data-automation-id` attribute, consistent across tenants for the ACCOUNT
 * and NAVIGATION chrome (sign in, create account, page-to-page nav, resume
 * upload). The QUESTIONNAIRE fields themselves get per-questionnaire
 * automation-ids, so those are discovered at runtime by scraping — never
 * hardcoded here (see field-map.ts).
 *
 * Only pure selector strings/helpers live in this module so it is unit
 * testable without a browser.
 */

/** CSS selector for a `data-automation-id`. */
export function automationId(id: string): string {
  return `[data-automation-id="${id}"]`;
}

/**
 * Stable automation-ids for the account + navigation chrome. Each entry is a
 * list of known variants (Workday has renamed a few across releases); the
 * driver tries them in order and uses the first present. Keeping variants
 * here — not in the driver — keeps the driver logic testable and the
 * brittle knowledge in one auditable place.
 */
export const WORKDAY_IDS = {
  /** The job-posting "Apply" entry points. */
  applyButton: ['adventureButton', 'applyButton'],
  applyManually: ['applyManually'],
  autofillWithResume: ['autofillWithResume'],

  /** Sign-in page. */
  email: ['email'],
  password: ['password'],
  signInSubmit: ['signInSubmitButton', 'click_filter'],
  signInLink: ['signInLink'],

  /** Create-account page. */
  createAccountLink: ['createAccountLink'],
  verifyPassword: ['verifyPassword'],
  createAccountCheckbox: ['createAccountCheckbox'],
  createAccountSubmit: ['createAccountSubmitButton'],

  /** Email-verification / OTP wall. */
  verificationCodeInput: ['verificationCode', 'otpCode'],
  verifyEmailSubmit: ['verifyEmailSubmitButton', 'submitButton'],

  /** Multi-page questionnaire navigation. */
  nextButton: ['pageFooterNextButton', 'bottom-navigation-next-button'],
  submitButton: ['pageFooterSubmitButton', 'bottom-navigation-submit-button'],
  progressBar: ['progressBar'],

  /** Resume upload (the file input lives inside the resume section). */
  resumeUploadInput: ['file-upload-input-ref'],
  resumeSection: ['resumeSection'],

  /** A Workday custom-select option row inside an opened listbox. */
  promptOption: ['promptOption'],
} as const satisfies Record<string, readonly string[]>;

/** Build a CSS selector matching any of an id list (comma-joined). */
export function anyAutomationId(ids: readonly string[]): string {
  return ids.map(automationId).join(', ');
}

/**
 * Known Workday step (page) titles, normalized. The apply flow walks these in
 * order; not every questionnaire has every step. Used to recognize where the
 * driver is and when the "Review" step (the last one before Submit) is
 * reached — the guardrail stops there.
 */
export const WORKDAY_STEPS = [
  'my information',
  'my experience',
  'application questions',
  'voluntary disclosures',
  'self identify',
  'review',
] as const;

export type WorkdayStep = (typeof WORKDAY_STEPS)[number];

/** The final step; the browser tier MUST stop here and never submit. */
export const REVIEW_STEP: WorkdayStep = 'review';

/**
 * Normalize a scraped step heading to a known WorkdayStep, or null when it is
 * not one of the recognized steps (an unknown step is treated conservatively
 * as "not review", so the flow never mistakes an unknown page for the safe
 * stopping point).
 */
export function normalizeStep(heading: string): WorkdayStep | null {
  const cleaned = heading
    .toLowerCase()
    .replace(/[0-9]+\s*(of|\/)\s*[0-9]+/g, '')
    .replace(/step/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const step of WORKDAY_STEPS) {
    if (cleaned.includes(step)) {
      return step;
    }
  }
  return null;
}

/** True when the heading is the Review step (the hard stop). */
export function isReviewStep(heading: string): boolean {
  return normalizeStep(heading) === REVIEW_STEP;
}
