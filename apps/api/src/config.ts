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
  })
  .transform((env) => ({
    ...env,
    /** Derived: Discord features are enabled iff a bot token is configured. */
    DISCORD_ENABLED: (env.DISCORD_BOT_TOKEN ?? '') !== '',
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
