import type {
  AnswerBank,
  BankEntry,
  DocumentEntry,
  Profile,
} from '@sower/answers';
import { resolveAnswers } from '@sower/answers';
import type { Question } from '@sower/core';
import {
  type CalypsoFillClient,
  type CalypsoFillResult,
  fillViaCalypso,
  type WorkdayQuestionnaireField,
} from '@sower/platforms';

/**
 * The Workday calypso apply orchestrator (whitepaper #3): the WORKER-tier entry
 * that resolves answers LIVE (profile + answer bank) and drives the shared
 * `fillViaCalypso` sequence — start → fill the info sections → read the
 * questionnaire → map answers → validate — stopping before `finalize`.
 *
 * The fill sequence itself lives in @sower/platforms (`fillViaCalypso`), shared
 * with the api approve path (which supplies the human-reviewed answers instead
 * of re-resolving). This thin wrapper only adapts the worker's answer sources.
 */

/** The calypso operations the applier needs (CalypsoClient satisfies this). */
export type ApplyClient = CalypsoFillClient;

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

export type CalypsoApplyResult = CalypsoFillResult;

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
  return fillViaCalypso(client, {
    jobSlug: input.jobSlug,
    questionnaireId: input.questionnaireId,
    applicant: {
      firstName: input.profile.name.first,
      lastName: input.profile.name.last,
      email: input.profile.email,
      phone: input.profile.phone,
    },
    // Worker tier: resolve answers LIVE against the fetched questionnaire fields
    // (which carry option GUIDs). Only string answers feed the payload.
    resolveQuestionnaireAnswers: (fields) => {
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
      return valueById;
    },
  });
}
