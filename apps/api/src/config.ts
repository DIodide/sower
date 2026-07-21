import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ANSWER_BANK_PATH } from '@sower/answers';
import { z } from 'zod';

// Resolved from this file's location, not process.cwd(): pnpm runs the api with
// cwd=apps/api while the container/repo keeps config/ at the monorepo root.
const DEFAULT_PROFILE_PATH = fileURLToPath(
  new URL('../../../config/profile.sample.yaml', import.meta.url),
);

/**
 * Discord non-secrets, safe to commit as defaults (env vars override; keep in
 * sync with @sower/notify). The bot token IS a secret: it is only ever read
 * from the DISCORD_BOT_TOKEN env var (Secret Manager in production) and must
 * never be committed or logged.
 */
export const DEFAULT_DISCORD_PUBLIC_KEY =
  'c461bfe425fa9fb69b7ae93f440e957ab93b472be6525502a7374b0f01813f5c';
export const DEFAULT_DISCORD_APP_ID = '1525747560684322956';

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8080),
    DATABASE_URL: z.string().min(1),
    INGEST_API_KEY: z.string().min(1),
    QUEUE_DRIVER: z.enum(['inline', 'cloud-tasks']).default('inline'),
    GCP_PROJECT_ID: z.string().optional(),
    GCP_REGION: z.string().optional(),
    TASKS_QUEUE: z.string().default('apply-queue'),
    TASKS_TARGET_BASE_URL: z.string().optional(),
    /**
     * DEV FALLBACK only: the profile now lives in the DB (profiles row,
     * edited via the dashboard's Answers → Profile) and getProfile reads
     * DB-first. This YAML path is consulted only when NO row exists (handy
     * locally with the gitignored config/profile.yaml); a missing/broken
     * file yields the empty profile instead of an error.
     */
    PROFILE_PATH: z.string().default(DEFAULT_PROFILE_PATH),
    /**
     * Curated answer bank (alias dedup + range strategies). Defaults to the
     * committed PII-free sample; point at a gitignored
     * config/answer-bank.yaml to customize. Loaded once at startup; if the
     * file is missing or invalid the API runs without a bank (existing
     * behavior preserved).
     */
    ANSWER_BANK_PATH: z.string().default(DEFAULT_ANSWER_BANK_PATH),
    SIMPLIFY_TERMS: z.string().default('Summer 2027'),
    SIMPLIFY_MAX_PER_RUN: z.coerce.number().int().positive().default(10),
    /**
     * Max Tier-2 form-discovery investigations the hourly listings-source
     * poll may fire per run — this run's fresh unknown-platform parks first,
     * then (with any remaining budget) the oldest never-investigated parked
     * backlog from the same sources. Throttles the browser-agent burst when a
     * source drops dozens of unsupported listings at once; 0 disables the
     * drip (parked tasks stay reachable via the queue's manual "Run browser
     * agent" button either way).
     */
    SOURCE_INVESTIGATE_PER_RUN: z.coerce.number().int().min(0).default(5),
    SOWER_SUBMIT_ENABLED: z.string().default('false'),
    SOWER_ENV: z.string().default('development'),
    /** SECRET (Secret Manager). Absent => Discord notifications disabled. */
    DISCORD_BOT_TOKEN: z.string().optional(),
    DISCORD_PUBLIC_KEY: z.string().default(DEFAULT_DISCORD_PUBLIC_KEY),
    DISCORD_APP_ID: z.string().default(DEFAULT_DISCORD_APP_ID),
    /** Optional JSON object mapping platform -> Discord channel id. */
    DISCORD_CHANNEL_MAP: z
      .string()
      .optional()
      .refine(
        (value) => {
          if (value === undefined) {
            return true;
          }
          try {
            const parsed: unknown = JSON.parse(value);
            return (
              parsed !== null &&
              typeof parsed === 'object' &&
              !Array.isArray(parsed)
            );
          } catch {
            return false;
          }
        },
        { message: 'must be a JSON object of platform -> channel id' },
      ),
    /** Channel the Discord ingest poll reads job links from (opt-in). */
    DISCORD_INGEST_CHANNEL_ID: z.string().optional(),
    /**
     * Channel deadline alerts post to (#alerts). Like the ingest channel,
     * unset keeps the feature fully dormant: POST /alerts/deadlines is a
     * no-op until infra wires the id.
     */
    DISCORD_ALERTS_CHANNEL_ID: z.string().optional(),
    /**
     * Discord user id to <@id>-mention on deadline alerts (the human being
     * pinged). Optional — when unset the alert posts without a mention.
     */
    DISCORD_ALERT_MENTION_USER_ID: z.string().optional(),
    /**
     * Public base URL of the sower-dashboard Cloud Run service (e.g.
     * https://sower-dashboard-....run.app). Used to render task links in
     * Discord ingest replies; when unset the replies degrade gracefully to
     * plain-text task ids (never crash).
     */
    DASHBOARD_BASE_URL: z.string().optional(),
    /** Cloud Run Job that runs Tier-2 screenshot investigation. */
    INVESTIGATOR_JOB_NAME: z.string().default('sower-investigator'),
    /**
     * Opt-in flag ('true' enables) for Tier-2 screenshot investigation.
     * Raw env string here; derived to a boolean in the transform below so
     * the feature stays fully dormant until infra flips it.
     */
    SCREENSHOT_INVESTIGATION_ENABLED: z.string().optional(),
    /** Cloud Run Job that runs the resume editor (sync/write/agent). */
    RESUME_EDITOR_JOB_NAME: z.string().default('sower-resume-editor'),
    /**
     * Opt-in flag ('true' enables) for the resume editor. Raw env string
     * here; derived to a boolean in the transform below so the feature stays
     * fully dormant until infra wires the Job + secrets and flips it.
     */
    RESUME_EDITOR_ENABLED: z.string().optional(),
    /**
     * Base URL of the IAM-gated compile-preview Cloud Run service (the
     * resume-editor image running with RESUME_COMPILE_SERVER=1). Doubles as
     * the OIDC audience for its identity tokens. Optional — unset, POST
     * /resumes/:id/compile-preview answers 503.
     */
    COMPILE_SERVICE_URL: z.string().optional(),
    /**
     * Public base URL of THIS api service (e.g. https://sower-api-....run.app),
     * used to render resume share-link URLs (/r/<token>). Optional: when
     * unset, link URLs are derived from the incoming request's host — which
     * is right whenever the caller reaches the api by its public name.
     */
    PUBLIC_API_BASE_URL: z.string().optional(),
    /**
     * Google OAuth client shared with the Gmail inbox reader (@sower/inbox
     * reads the same two env vars directly). Both SECRETS (Secret Manager in
     * production); optional — absent, calendar sync stays fully dormant.
     */
    GMAIL_CLIENT_ID: z.string().optional(),
    GMAIL_CLIENT_SECRET: z.string().optional(),
    /**
     * SECRET (Secret Manager): the Gmail reader's long-lived OAuth refresh
     * token (@sower/inbox reads the same var directly for OTP mail).
     * Optional — absent, the follow-up inbox poll stays fully dormant
     * (POST /inbox/followups/poll answers {enabled:false}).
     */
    GMAIL_REFRESH_TOKEN: z.string().optional(),
    /**
     * SECRET (Secret Manager `google-calendar-refresh-token`): long-lived
     * OAuth refresh token granting calendar.events on the user's Google
     * Calendar. Optional — absent, calendar sync stays fully dormant (see
     * the derived CALENDAR_SYNC_ENABLED below).
     */
    GOOGLE_CALENDAR_REFRESH_TOKEN: z.string().optional(),
  })
  .transform((env) => ({
    ...env,
    /** Derived: Discord features are enabled iff a bot token is configured. */
    DISCORD_ENABLED: (env.DISCORD_BOT_TOKEN ?? '') !== '',
    /** Derived: screenshot investigation fires only when explicitly enabled. */
    SCREENSHOT_INVESTIGATION_ENABLED:
      (env.SCREENSHOT_INVESTIGATION_ENABLED ?? '') === 'true',
    /** Derived: resume-editor runs fire only when explicitly enabled. */
    RESUME_EDITOR_ENABLED: (env.RESUME_EDITOR_ENABLED ?? '') === 'true',
    /**
     * Derived: Google Calendar deadline sync runs only when the full OAuth
     * triple is configured (client id + secret + calendar refresh token).
     * Anything missing keeps every sync a silent no-op.
     */
    CALENDAR_SYNC_ENABLED:
      (env.GMAIL_CLIENT_ID ?? '') !== '' &&
      (env.GMAIL_CLIENT_SECRET ?? '') !== '' &&
      (env.GOOGLE_CALENDAR_REFRESH_TOKEN ?? '') !== '',
  }));

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}
