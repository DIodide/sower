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
  | 'DUPLICATE';

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
  | 'RETRY';

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
}

export interface ResolvedAnswer {
  questionId: string;
  source: 'profile' | 'bank' | 'default';
  value: string | string[] | null;
}

export interface ResolutionResult {
  resolved: ResolvedAnswer[];
  missing: Question[];
  /** Count of missing questions with required === true. */
  requiredMissingCount?: number;
  /** Count of missing questions with required === false. */
  optionalMissingCount?: number;
}

export interface PlatformRef {
  platform: Platform;
  tenant: string | null;
  externalId: string | null;
}
