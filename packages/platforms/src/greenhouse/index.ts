import type {
  JobSpec,
  PlatformRef,
  Question,
  QuestionOption,
  ResolvedAnswer,
} from '@sower/core';
import { deadlineFromIsoDate } from '@sower/core';
import type {
  PlatformAdapter,
  SubmitFile,
  SubmitOptions,
  SubmitResult,
} from '../contract.js';
import { htmlEntityEncodedToPlainText } from '../description.js';
import { type Recorder, recordedFetch, safeRecord } from '../recorder.js';
import { realSubmit } from '../submit-common.js';

interface GreenhouseFieldValue {
  label: string;
  value: string | number;
}

interface GreenhouseField {
  name: string;
  type: string;
  values?: GreenhouseFieldValue[] | null;
}

interface GreenhouseQuestion {
  label: string;
  required: boolean | null;
  fields: GreenhouseField[];
}

interface GreenhouseComplianceBlock {
  type: string;
  description?: string | null;
  questions?: GreenhouseQuestion[] | null;
}

interface GreenhouseDemographicAnswerOption {
  id: number;
  label: string;
  free_form?: boolean;
  decline_to_answer?: boolean;
}

/**
 * Demographic questions use a different shape from regular questions: the
 * type lives on the question itself and options are `answer_options` keyed
 * by numeric id (regular/compliance selects key options by `value`, which
 * for compliance questions is a string like '1'/'2'/'3').
 */
interface GreenhouseDemographicQuestion {
  id: number;
  label: string;
  required: boolean | null;
  type: string;
  answer_options?: GreenhouseDemographicAnswerOption[] | null;
}

interface GreenhouseDemographicSection {
  header?: string | null;
  description?: string | null;
  questions?: GreenhouseDemographicQuestion[] | null;
}

interface GreenhouseJobPayload {
  title: string;
  company_name?: string | null;
  location?: { name?: string | null } | null;
  /** Board-configured departments/offices; employment type is NOT exposed. */
  departments?: Array<{ name?: string | null }> | null;
  offices?: Array<{ name?: string | null }> | null;
  absolute_url: string;
  /** Board-published application deadline (null on most postings). */
  application_deadline?: string | null;
  /** HTML-entity-encoded HTML description (present only with ?content=true). */
  content?: string | null;
  questions?: GreenhouseQuestion[] | null;
  location_questions?: GreenhouseQuestion[] | null;
  compliance?: GreenhouseComplianceBlock[] | null;
  demographic_questions?: GreenhouseDemographicSection | null;
}

const FIELD_TYPE_MAP: Record<string, Question['type']> = {
  input_text: 'text',
  textarea: 'textarea',
  input_file: 'file',
  multi_value_single_select: 'select',
  multi_value_multi_select: 'multiselect',
};

function mapFieldType(
  rawType: string,
  options: QuestionOption[],
): Question['type'] {
  const mapped = FIELD_TYPE_MAP[rawType];
  if (mapped) {
    return mapped;
  }
  // Unknown field types that carry options must stay 'select' so answer
  // resolution keeps its option-matching protection; only option-less
  // unknowns degrade to free text.
  return options.length > 0 ? 'select' : 'text';
}

function toOptions(values: GreenhouseFieldValue[] | null | undefined) {
  return (values ?? []).map(
    (value): QuestionOption => ({ label: value.label, value: value.value }),
  );
}

function toQuestions(raw: GreenhouseQuestion): Question[] {
  // input_hidden fields (e.g. longitude/latitude on location questions) are
  // machine-populated and never human-facing — skip them entirely.
  const visibleFields = raw.fields.filter(
    (field) => field.type !== 'input_hidden',
  );
  if (visibleFields.length === 0) {
    if (raw.fields.length > 0) {
      console.debug(
        `[sower] greenhouse: omitting hidden-only question ${JSON.stringify(
          raw.label,
        )} (fields: ${raw.fields.map((field) => field.name).join(', ')})`,
      );
    }
    return [];
  }
  // The first visible field is the question itself; additional visible fields
  // (e.g. resume_text alongside resume) are optional alternate ways to answer.
  return visibleFields.map((field, index): Question => {
    const isAlternate = index > 0;
    const options = toOptions(field.values);
    const question: Question = {
      id: field.name,
      label: isAlternate
        ? `${raw.label} (alternate: ${field.name})`
        : raw.label,
      type: mapFieldType(field.type, options),
      required: isAlternate ? false : raw.required === true,
    };
    if (options.length > 0) {
      question.options = options;
    }
    return question;
  });
}

function toDemographicQuestion(raw: GreenhouseDemographicQuestion): Question {
  const options = (raw.answer_options ?? []).map(
    (option): QuestionOption => ({ label: option.label, value: option.id }),
  );
  const type = mapFieldType(raw.type, options);
  const question: Question = {
    // Mirror greenhouse's own field-name convention: multi-selects get a
    // trailing '[]' (compare question_67165646[] in regular questions).
    id: `demographic_question_${raw.id}${type === 'multiselect' ? '[]' : ''}`,
    label: raw.label,
    type,
    required: raw.required === true,
  };
  if (options.length > 0) {
    question.options = options;
  }
  return question;
}

export class GreenhouseAdapter implements PlatformAdapter {
  readonly platform = 'greenhouse' as const;

  async discover(
    ref: PlatformRef,
    url: string,
    opts?: { recorder?: Recorder },
  ): Promise<JobSpec> {
    const { tenant, externalId } = ref;
    if (!tenant || !externalId) {
      throw new Error(
        `greenhouse discover requires a board tenant and job id, got tenant=${JSON.stringify(
          tenant,
        )} externalId=${JSON.stringify(externalId)} for url ${url}`,
      );
    }

    const endpoint = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(
      tenant,
    )}/jobs/${encodeURIComponent(externalId)}?questions=true&content=true`;
    const response = await recordedFetch(opts?.recorder, 'discover', endpoint, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(
        `greenhouse job fetch failed with status ${response.status} for ${endpoint}`,
      );
    }
    const payload = (await response.json()) as GreenhouseJobPayload;

    const rawQuestions = [
      ...(payload.questions ?? []),
      ...(payload.location_questions ?? []),
      ...(payload.compliance ?? []).flatMap((block) => block.questions ?? []),
    ];
    const questions: Question[] = [];
    for (const raw of rawQuestions) {
      questions.push(...toQuestions(raw));
    }
    for (const raw of payload.demographic_questions?.questions ?? []) {
      questions.push(toDemographicQuestion(raw));
    }

    const spec: JobSpec = {
      platform: 'greenhouse',
      tenant,
      externalId,
      title: payload.title,
      applyUrl: payload.absolute_url,
      questions,
    };
    const company = payload.company_name ?? spec.company ?? tenant;
    if (company) {
      spec.company = company;
    }
    // `location.name` is the posting's display location; the offices list is
    // the board taxonomy and only fills in when no display location exists.
    const officeNames = (payload.offices ?? [])
      .map((office) => office.name)
      .filter((name): name is string => Boolean(name));
    const location = payload.location?.name || officeNames.join(' · ');
    if (location) {
      spec.location = location;
    }
    const departmentNames = (payload.departments ?? [])
      .map((department) => department.name)
      .filter((name): name is string => Boolean(name));
    if (departmentNames.length > 0) {
      spec.department = departmentNames.join(' · ');
    }
    // The board's explicit application_deadline (null on most postings, e.g.
    // the fixture) — PARSED, never inferred; unparseable values are ignored.
    if (payload.application_deadline) {
      const deadline = deadlineFromIsoDate(payload.application_deadline);
      if (deadline) {
        spec.deadline = deadline;
      }
    }
    // The boards API exposes no employment type — employmentType stays unset.
    // Greenhouse `content` is HTML-entity-encoded HTML (needs ?content=true).
    if (payload.content) {
      spec.descriptionHtml = payload.content;
      spec.description = htmlEntityEncodedToPlainText(payload.content);
    }
    return spec;
  }

  buildSubmitPayload(
    _spec: JobSpec,
    answers: ResolvedAnswer[],
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (const answer of answers) {
      if (answer.value === null) {
        continue;
      }
      payload[answer.questionId] = answer.value;
    }
    return payload;
  }

  /**
   * SAFETY: constructs and records the submission payload REPRESENTATION
   * only. This method performs ZERO network I/O — it never calls fetch (or
   * any other HTTP client) and must stay that way. The single recorded
   * ApiCallRecord is explicitly flagged { dryRun: true }.
   */
  async dryRunSubmit(
    spec: JobSpec,
    answers: ResolvedAnswer[],
    files: SubmitFile[],
    opts?: { recorder?: Recorder },
  ): Promise<{ dryRun: true; payload: Record<string, unknown> }> {
    const payload = this.buildSubmitPayload(spec, answers);
    for (const file of files) {
      // Multipart file parts are represented by metadata only — contents
      // never leave the vault during a dry run.
      payload[file.questionId] = {
        kind: 'file',
        filename: file.filename,
        storagePath: file.storagePath,
      };
    }
    await safeRecord(opts?.recorder, {
      phase: 'submit_dryrun',
      method: 'POST',
      url: spec.applyUrl,
      requestBody: payload,
      dryRun: true,
      durationMs: 0,
    });
    return { dryRun: true, payload };
  }

  /**
   * DOUBLE-GATED real submit. Delegates to realSubmit, which throws unless
   * BOTH SOWER_SUBMIT_ENABLED === 'true' AND an explicit
   * SOWER_SUBMIT_TARGET_URL are set; only then does it POST a multipart body
   * to that target. It NEVER falls back to spec.applyUrl, so an accidental
   * real-employer submission is structurally impossible.
   */
  async submit(
    spec: JobSpec,
    answers: ResolvedAnswer[],
    files: SubmitFile[] = [],
    opts?: SubmitOptions,
  ): Promise<SubmitResult> {
    const payload = this.buildSubmitPayload(spec, answers);
    return realSubmit(this.platform, spec, payload, files, opts);
  }
}
