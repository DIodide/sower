import {
  buildEmailSection,
  buildNameSection,
  buildPhoneSection,
} from './calypso-sections.js';
import type { WorkdayQuestionnaireField } from './questionnaire.js';
import { buildQuestionnaireResolution } from './questionnaire-responses.js';

/**
 * The Workday calypso FILL orchestrator: drive an application over HTTP with a
 * captured session — start → fill the info sections → read the questionnaire
 * (with its option GUIDs) → map answers → validate — and STOP before
 * `finalize`. Submission stays a separate, human-approved, double-gated step;
 * this never calls finalize (it has no way to — `finalize` is not in the
 * client surface it accepts).
 *
 * The answer SOURCE is pluggable via `resolveQuestionnaireAnswers`, called with
 * the freshly-fetched fields (so callers see the real option GUIDs):
 *   - the worker resolves live from profile + answer bank against the fields;
 *   - the api approve path returns the answers the human already reviewed
 *     (the stored resolution), so it fills EXACTLY what was approved.
 * One fill sequence, two answer sources — no divergence.
 *
 * Resilient by design: each info section is filled best-effort (a per-tenant
 * section that rejects is recorded in `sectionErrors`, not fatal), because
 * Workday forms vary across tenants and one HAR is not representative. The
 * client is an interface so the flow is unit-tested without a network;
 * CalypsoClient satisfies it.
 */

/** The calypso operations the fill needs (CalypsoClient satisfies this). */
export interface CalypsoFillClient {
  checkSession(): Promise<boolean>;
  startApplication(jobSlug: string): Promise<{ jobApplicationId: string }>;
  fillSection(
    jobApplicationId: string,
    section: string,
    body: Record<string, unknown>,
  ): Promise<unknown>;
  validate(jobApplicationId: string): Promise<void>;
  /** Fetch the questionnaire fields WITH options (in the application context). */
  getQuestionnaireFields(
    jobApplicationId: string,
    questionnaireId: string,
  ): Promise<WorkdayQuestionnaireField[]>;
}

/** The "My Information" fields built from the applicant's profile. */
export interface CalypsoApplicant {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export interface CalypsoFillInput {
  jobSlug: string;
  /** From the public cxs job detail; when absent the questionnaire is skipped. */
  questionnaireId?: string | null;
  applicant: CalypsoApplicant;
  /**
   * Produce the answer for each questionnaire field id, given the fetched
   * fields (which carry the option GUIDs). Only string answers feed the
   * responses payload; a field with no entry (or a non-string value) is left
   * unanswered — the fill NEVER fabricates. Called once, after the fields are
   * fetched in the application context.
   */
  resolveQuestionnaireAnswers: (
    fields: WorkdayQuestionnaireField[],
  ) => Record<string, string | undefined>;
}

export interface CalypsoFillResult {
  jobApplicationId: string;
  sectionsFilled: string[];
  sectionErrors: { section: string; error: string }[];
  questionnaire: {
    fields: number;
    answered: number;
    skipped: number;
    skippedRequired: number;
  } | null;
  /** GUARDRAIL: always true — the orchestrator never submits. */
  stoppedBeforeSubmit: true;
}

export async function fillViaCalypso(
  client: CalypsoFillClient,
  input: CalypsoFillInput,
): Promise<CalypsoFillResult> {
  if (!(await client.checkSession())) {
    throw new Error(
      'workday session is invalid/expired — re-capture it (session broker)',
    );
  }

  const { jobApplicationId } = await client.startApplication(input.jobSlug);

  const sectionsFilled: string[] = [];
  const sectionErrors: { section: string; error: string }[] = [];
  const fill = async (
    section: string,
    body: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await client.fillSection(jobApplicationId, section, body);
      sectionsFilled.push(section);
    } catch (error) {
      sectionErrors.push({
        section,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // --- My Information: the sections we can build from the profile. ---
  await fill(
    'name',
    buildNameSection(input.applicant.firstName, input.applicant.lastName),
  );
  await fill('emailaddress', buildEmailSection(input.applicant.email));
  await fill('phonenumber', buildPhoneSection(input.applicant.phone));
  await client.validate(jobApplicationId).catch(() => {});

  // --- Application Questions. ---
  let questionnaire: CalypsoFillResult['questionnaire'] = null;
  if (input.questionnaireId) {
    const fields = await client.getQuestionnaireFields(
      jobApplicationId,
      input.questionnaireId,
    );
    const valueById = input.resolveQuestionnaireAnswers(fields);
    const { payload, skipped, skippedRequired } = buildQuestionnaireResolution(
      fields,
      valueById,
    );
    const answered = (payload.questionnaireAnswers as unknown[]).length;
    if (answered > 0) {
      await fill('questionnaireresponses', payload as Record<string, unknown>);
      await client.validate(jobApplicationId).catch(() => {});
    }
    questionnaire = {
      fields: fields.length,
      answered,
      skipped: skipped.length,
      skippedRequired,
    };
  }

  // GUARDRAIL: stop here. finalize is a separate, human-approved, gated call.
  return {
    jobApplicationId,
    sectionsFilled,
    sectionErrors,
    questionnaire,
    stoppedBeforeSubmit: true,
  };
}
