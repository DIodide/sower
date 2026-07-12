import type {
  JobSpec,
  PlatformRef,
  Question,
  QuestionOption,
  ResolvedAnswer,
} from '@sower/core';
import type { PlatformAdapter, SubmitFile } from '../contract.js';
import { type Recorder, recordedFetch } from '../recorder.js';
import {
  buildAnswerPayload,
  guardedDryRunOnlySubmit,
  recordDryRunSubmit,
} from '../submit-common.js';

/**
 * Shapes from the documented Ashby posting API:
 * GET https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true
 *
 * As observed live (ramp/notion/openai/linear boards, 2026-07), this public
 * endpoint does NOT expose the per-posting application form. When the form is
 * absent, discover returns questions: [] (TRUTHFULNESS: we never fabricate
 * form fields) and the task parks NEEDS_INPUT downstream. The applicationForm
 * mapping below is best-effort for payloads that do carry a form.
 */
interface AshbyJobPosting {
  id: string;
  title: string;
  location?: string | null;
  department?: string | null;
  team?: string | null;
  employmentType?: string | null;
  isListed?: boolean;
  isRemote?: boolean;
  jobUrl?: string | null;
  applyUrl?: string | null;
  /** Rendered HTML description from the posting API. */
  descriptionHtml?: string | null;
  /** Plain-text description from the posting API. */
  descriptionPlain?: string | null;
  /** Not present on the public posting API today; mapped when present. */
  applicationForm?: unknown;
}

interface AshbyJobBoardPayload {
  jobs?: AshbyJobPosting[] | null;
  apiVersion?: number | string;
}

/** Ashby field type -> Question type. Unknowns degrade via options presence. */
const ASHBY_FIELD_TYPE_MAP: Record<string, Question['type']> = {
  String: 'text',
  Email: 'text',
  Phone: 'text',
  Number: 'text',
  Date: 'text',
  Location: 'text',
  SocialLink: 'text',
  LongText: 'textarea',
  RichText: 'textarea',
  File: 'file',
  ValueSelect: 'select',
  MultiValueSelect: 'multiselect',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toAshbyOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const options: QuestionOption[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const label = asString(entry.label) ?? asString(entry.title);
    const value =
      typeof entry.value === 'string' || typeof entry.value === 'number'
        ? entry.value
        : label;
    // Options whose label cannot be determined are dropped rather than
    // invented (TRUTHFULNESS rule: selects must match a real option exactly).
    if (label !== null && value !== null) {
      options.push({ label, value });
    }
  }
  return options;
}

function mapAshbyFieldType(
  rawType: string | null,
  options: QuestionOption[],
): Question['type'] {
  const mapped = rawType ? ASHBY_FIELD_TYPE_MAP[rawType] : undefined;
  if (mapped) {
    return mapped;
  }
  // Mirror the greenhouse adapter: unknown types WITH options must stay
  // 'select' so answer resolution keeps its option-matching protection;
  // only option-less unknowns degrade to free text.
  return options.length > 0 ? 'select' : 'text';
}

/**
 * Map one applicationForm field entry to a Question, or null when the entry
 * lacks a determinable id/label (we skip rather than fabricate).
 */
function toAshbyQuestion(entry: unknown): Question | null {
  if (!isRecord(entry)) {
    return null;
  }
  // Entries usually nest the field description under `field`; tolerate flat
  // entries too ({ ...field, isRequired }).
  const field = isRecord(entry.field) ? entry.field : entry;
  const id = asString(field.path) ?? asString(field.id);
  const label =
    asString(field.title) ?? asString(field.humanReadablePath) ?? id;
  if (id === null || label === null) {
    console.debug(
      `[sower] ashby: skipping unmappable applicationForm entry: ${JSON.stringify(
        entry,
      ).slice(0, 200)}`,
    );
    return null;
  }
  const rawType = asString(field.type);
  let options = toAshbyOptions(field.selectableValues);
  let type: Question['type'];
  if (rawType === 'Boolean') {
    // A Boolean field's domain is exactly {true, false} — representing it as
    // a two-option select is faithful (not fabrication) and keeps the
    // option-matching protection.
    type = 'select';
    if (options.length === 0) {
      options = [
        { label: 'Yes', value: 'true' },
        { label: 'No', value: 'false' },
      ];
    }
  } else {
    type = mapAshbyFieldType(rawType, options);
  }
  const required =
    entry.isRequired === true ||
    field.isRequired === true ||
    field.isNullable === false;
  const question: Question = { id, label, type, required };
  if (options.length > 0) {
    question.options = options;
  }
  return question;
}

/**
 * Best-effort applicationForm walk. Supported layouts:
 * - { sections: [{ fieldEntries: [...] }] }  (Ashby application form shape)
 * - { fieldEntries: [...] } / { fields: [...] } / bare array
 * Anything unrecognized yields [] — never invented questions.
 */
export function mapAshbyApplicationForm(form: unknown): Question[] {
  let entries: unknown[] = [];
  if (Array.isArray(form)) {
    entries = form;
  } else if (isRecord(form)) {
    if (Array.isArray(form.sections)) {
      for (const section of form.sections) {
        if (isRecord(section) && Array.isArray(section.fieldEntries)) {
          entries.push(...section.fieldEntries);
        }
      }
    } else if (Array.isArray(form.fieldEntries)) {
      entries = form.fieldEntries;
    } else if (Array.isArray(form.fields)) {
      entries = form.fields;
    }
  }
  const questions: Question[] = [];
  for (const entry of entries) {
    const question = toAshbyQuestion(entry);
    if (question) {
      questions.push(question);
    }
  }
  return questions;
}

/**
 * The public Ashby job board (jobs.ashbyhq.com) renders each posting's
 * application form from this GraphQL endpoint — the same request the browser
 * makes, no API key. `field` is a JSON scalar carrying {path,title,type,
 * selectableValues,...}; mapAshbyApplicationForm already understands the
 * {sections:[{fieldEntries:[{field,isRequired}]}]} shape. Returns undefined on
 * any failure (never fabricates questions).
 */
const ASHBY_FORM_QUERY =
  'query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { applicationForm { sections { title fieldEntries { field isRequired } } } } }';

export async function fetchAshbyApplicationForm(
  tenant: string,
  postingId: string,
  recorder?: Recorder,
): Promise<unknown> {
  const response = await recordedFetch(
    recorder,
    'discover_form',
    'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationName: 'ApiJobPosting',
        variables: {
          organizationHostedJobsPageName: tenant,
          jobPostingId: postingId,
        },
        query: ASHBY_FORM_QUERY,
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    return undefined;
  }
  const payload = (await response.json()) as {
    data?: { jobPosting?: { applicationForm?: unknown } | null } | null;
  };
  return payload.data?.jobPosting?.applicationForm ?? undefined;
}

export class AshbyAdapter implements PlatformAdapter {
  readonly platform = 'ashby' as const;

  async discover(
    ref: PlatformRef,
    url: string,
    opts?: { recorder?: Recorder },
  ): Promise<JobSpec> {
    const { tenant, externalId } = ref;
    if (!tenant || !externalId) {
      throw new Error(
        `ashby discover requires a job-board tenant and posting id, got tenant=${JSON.stringify(
          tenant,
        )} externalId=${JSON.stringify(externalId)} for url ${url}`,
      );
    }

    const endpoint = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(
      tenant,
    )}?includeCompensation=true`;
    const response = await recordedFetch(opts?.recorder, 'discover', endpoint, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(
        `ashby job board fetch failed with status ${response.status} for ${endpoint}`,
      );
    }
    const payload = (await response.json()) as AshbyJobBoardPayload;
    const jobs = payload.jobs ?? [];
    const posting = jobs.find((job) => job.id === externalId);
    if (!posting) {
      throw new Error(
        `ashby posting ${externalId} not found on job board ${tenant} (${jobs.length} listed postings)`,
      );
    }

    let questions: Question[] = [];
    if (posting.applicationForm !== undefined) {
      questions = mapAshbyApplicationForm(posting.applicationForm);
    }
    if (questions.length === 0) {
      // The posting-api metadata endpoint omits the form; fetch it from the
      // public job-board GraphQL (same request the hosted board makes).
      const form = await fetchAshbyApplicationForm(
        tenant,
        externalId,
        opts?.recorder,
      );
      if (form !== undefined) {
        questions = mapAshbyApplicationForm(form);
      }
    }
    if (questions.length === 0) {
      // Both sources yielded no form — return zero questions rather than
      // fabricating any (truthfulness); the task parks NEEDS_INPUT downstream.
      console.info(
        `[sower] ashby: no application form available for ${tenant}/${externalId}; returning 0 questions`,
      );
    }

    const spec: JobSpec = {
      platform: 'ashby',
      tenant,
      externalId,
      title: posting.title,
      // The job-board payload carries no display company name; the tenant
      // slug is the only truthful value available.
      company: tenant,
      applyUrl: posting.applyUrl || posting.jobUrl || url,
      questions,
    };
    const location = posting.location;
    if (location) {
      spec.location = location;
    }
    if (posting.descriptionHtml) {
      spec.descriptionHtml = posting.descriptionHtml;
    }
    if (posting.descriptionPlain) {
      spec.description = posting.descriptionPlain;
    }
    return spec;
  }

  buildSubmitPayload(
    _spec: JobSpec,
    answers: ResolvedAnswer[],
  ): Record<string, unknown> {
    return buildAnswerPayload(answers);
  }

  /**
   * SAFETY: constructs and records the submission payload REPRESENTATION
   * only. ZERO network I/O — never calls fetch (or any other HTTP client).
   */
  async dryRunSubmit(
    spec: JobSpec,
    answers: ResolvedAnswer[],
    files: SubmitFile[],
    opts?: { recorder?: Recorder },
  ): Promise<{ dryRun: true; payload: Record<string, unknown> }> {
    const payload = this.buildSubmitPayload(spec, answers);
    return recordDryRunSubmit(spec, payload, files, opts?.recorder);
  }

  /**
   * GUARDRAIL: throws unless SOWER_SUBMIT_ENABLED === 'true'; even then it
   * only logs the dry-run payload. No HTTP request is ever made here.
   */
  async submit(
    spec: JobSpec,
    answers: ResolvedAnswer[],
  ): Promise<{ dryRun: boolean }> {
    return guardedDryRunOnlySubmit(
      this.platform,
      spec,
      this.buildSubmitPayload(spec, answers),
    );
  }
}
