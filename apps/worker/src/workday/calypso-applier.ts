import type {
  AnswerBank,
  BankEntry,
  DocumentEntry,
  Profile,
} from '@sower/answers';
import { resolveAnswers } from '@sower/answers';
import type { Question } from '@sower/core';
import {
  buildEmailSection,
  buildNameSection,
  buildPhoneSection,
  buildQuestionnaireResolution,
  type WorkdayQuestionnaireField,
} from '@sower/platforms';

/**
 * The Workday calypso apply orchestrator (whitepaper #3): drive an application
 * over HTTP with a captured session — start → fill the info sections → read the
 * questionnaire (with its options) → map answers → validate — and STOP before
 * `finalize`. Submission stays a separate, human-approved, double-gated step;
 * this never calls finalize.
 *
 * Resilient by design: each section is filled best-effort (a per-tenant section
 * that rejects is recorded, not fatal), because Workday forms vary across
 * tenants and one HAR is not representative. The client is an interface so the
 * flow is unit-tested without a network.
 */

/** The calypso operations the applier needs (CalypsoClient satisfies this). */
export interface ApplyClient {
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

export interface CalypsoApplyInput {
  jobSlug: string;
  /** From the public cxs job detail; when absent the questionnaire is skipped. */
  questionnaireId?: string | null;
  profile: Profile;
  answerBank?: AnswerBank;
  bank?: BankEntry[];
  documents?: DocumentEntry[];
  /** Normalized company key for company-scoped answers. */
  company?: string;
}

export interface CalypsoApplyResult {
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

/** WorkdayQuestionnaireField -> the platform-neutral Question the resolver uses. */
function fieldToQuestion(field: WorkdayQuestionnaireField): Question {
  const type: Question['type'] =
    field.control === 'select'
      ? 'select'
      : field.control === 'file'
        ? 'file'
        : 'text';
  const question: Question = {
    id: field.id,
    label: field.label,
    type,
    required: field.required,
  };
  if (field.options && field.options.length > 0) {
    // Match on the human descriptor; buildQuestionnaireResolution maps the
    // chosen descriptor back to the option GUID.
    question.options = field.options.map((o) => ({
      label: o.descriptor,
      value: o.descriptor,
    }));
  }
  return question;
}

export async function applyViaCalypso(
  client: ApplyClient,
  input: CalypsoApplyInput,
): Promise<CalypsoApplyResult> {
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
    buildNameSection(input.profile.name.first, input.profile.name.last),
  );
  await fill('emailaddress', buildEmailSection(input.profile.email));
  await fill('phonenumber', buildPhoneSection(input.profile.phone));
  await client.validate(jobApplicationId).catch(() => {});

  // --- Application Questions. ---
  let questionnaire: CalypsoApplyResult['questionnaire'] = null;
  if (input.questionnaireId) {
    const fields = await client.getQuestionnaireFields(
      jobApplicationId,
      input.questionnaireId,
    );
    const questions = fields.map(fieldToQuestion);
    const { resolved } = resolveAnswers(questions, input.profile, {
      answerBank: input.answerBank,
      bank: input.bank,
      documents: input.documents,
      company: input.company,
    });
    const valueById: Record<string, string> = {};
    for (const answer of resolved) {
      if (typeof answer.value === 'string') {
        valueById[answer.questionId] = answer.value;
      }
    }
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
