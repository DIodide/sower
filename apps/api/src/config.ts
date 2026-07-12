import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  INGEST_API_KEY: z.string().min(1),
  QUEUE_DRIVER: z.enum(['inline', 'cloud-tasks']).default('inline'),
  GCP_PROJECT_ID: z.string().optional(),
  GCP_REGION: z.string().optional(),
  TASKS_QUEUE: z.string().default('apply-queue'),
  TASKS_TARGET_BASE_URL: z.string().optional(),
  PROFILE_PATH: z.string().default('./config/profile.sample.yaml'),
  SIMPLIFY_TERMS: z.string().default('Summer 2027'),
  SIMPLIFY_MAX_PER_RUN: z.coerce.number().int().positive().default(10),
  SOWER_SUBMIT_ENABLED: z.string().default('false'),
  SOWER_ENV: z.string().default('development'),
});

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
