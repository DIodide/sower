export type Platform = 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'unknown';

export type TaskState =
  | 'INGESTED'
  | 'PARSED'
  | 'QUEUED'
  | 'PREPARING'
  | 'NEEDS_INPUT'
  | 'REVIEW'
  | 'AWAITING_OTP'
  | 'FILLING'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FAILED'
  | 'DUPLICATE'
  | 'DISCARDED';

export type TaskEvent =
  | 'PARSE_OK'
  | 'PARSE_DUPLICATE'
  | 'ENQUEUE'
  | 'PARK'
  | 'PROCESS_START'
  | 'RESOLVED_ALL'
  | 'RESOLVED_PARTIAL'
  | 'APPROVED'
  | 'FILLED'
  | 'NEED_OTP'
  | 'SUBMIT_OK'
  | 'CONFIRM'
  | 'FAIL'
  | 'RETRY'
  | 'DISCARD';

export interface QuestionOption {
  label: string;
  value: string | number;
}

export interface Question {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'file' | 'select' | 'multiselect';
  required: boolean;
  options?: QuestionOption[];
  /**
   * True when this question only applies based on a prior answer (a branch /
   * conditional sub-question, e.g. Workday's "if yes, …" follow-ups). It is not
   * required up front and the UI surfaces it as depending on another answer.
   */
  conditional?: boolean;
  /**
   * Optional human hint shown under the label — e.g. which parent answer
   * reveals a conditional question. Display-only; never submitted.
   */
  help?: string;
}

export interface JobSpec {
  platform: Platform;
  tenant: string;
  externalId: string;
  title: string;
  company?: string;
  location?: string;
  applyUrl: string;
  questions: Question[];
  /** Plain-text job description (tags/entities stripped). Back-compat optional. */
  description?: string;
  /** Raw HTML (or entity-encoded HTML) job description as returned by the source. */
  descriptionHtml?: string;
  /**
   * How the application form is reached. Absent/'public' means the questions
   * are fully discoverable at the network tier (greenhouse/ashby/lever), so a
   * spec with no missing required answers is genuinely ready for REVIEW.
   * 'account-required' means the questions live behind an authenticated,
   * per-tenant candidate account + browser session (workday): `questions` is
   * empty at discover time, so the task must NOT be treated as
   * ready-to-submit — it parks for the account/browser tier instead.
   */
  formAccess?: 'public' | 'account-required';
  /**
   * Adapter-specific metadata preserved for later tiers (persisted with the
   * spec). Workday stashes the cxs `site`/`externalPath`/`questionnaireId`
   * here so the browser tier can resume without re-deriving them.
   */
  meta?: Record<string, unknown>;
  /**
   * True when the questions were machine-extracted by the Tier-2 form
   * discovery agent from an UNSUPPORTED job page (no platform adapter). The
   * dashboard badges the spec "verify before use"; such a task stays
   * NEEDS_INPUT and is never auto-submitted.
   */
  discoveredByAgent?: boolean;
  /**
   * True once a human verified an agent-discovered form on the dashboard
   * (POST /tasks/:id/verify-form). Only meaningful alongside
   * `discoveredByAgent`; the #ingest reply renders it as "form verified".
   */
  formVerified?: boolean;
}

export interface ResolvedAnswer {
  questionId: string;
  /**
   * Where the answer came from:
   * - 'profile': the user's profile (including profile.custom)
   * - 'bank': the answers bank (previously saved user answers)
   * - 'default': a platform default
   * - 'user': explicit user input via the dashboard
   * - 'document': a stored document; value is its storage path
   */
  source: 'profile' | 'bank' | 'default' | 'user' | 'document';
  value: string | string[] | null;
}

export interface ResolutionResult {
  resolved: ResolvedAnswer[];
  missing: Question[];
  /** Count of missing questions with required === true. */
  requiredMissingCount?: number;
  /** Count of missing questions with required === false. */
  optionalMissingCount?: number;
  /**
   * Human-readable reason the task is parked, when the parking is not simply
   * "some required answers are missing" — e.g. a Workday job whose form is
   * behind an account/browser tier that hasn't run yet. Surfaced on the
   * dashboard so a NEEDS_INPUT task explains itself.
   */
  note?: string;
}

export interface PlatformRef {
  platform: Platform;
  tenant: string | null;
  externalId: string | null;
}
