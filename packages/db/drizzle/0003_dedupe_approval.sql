-- jobs.dedupe_key is nullable on purpose: rows ingested before this migration
-- have no key yet. Backfill: recompute per job via computeDedupeKey
-- (@sower/sources) — platform:tenant:external_id when both are present,
-- platform:jid:external_id when only external_id is present, else
-- canonical_url — e.g. after deploy run a one-off script over jobs WHERE
-- dedupe_key IS NULL. The UNIQUE constraint permits multiple NULLs, so the
-- backfill can happen lazily without blocking ingest dedupe for new rows.
ALTER TABLE "application_tasks" ADD COLUMN "approval_channel_id" text;--> statement-breakpoint
ALTER TABLE "application_tasks" ADD COLUMN "approval_message_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_dedupe_key_unique" UNIQUE("dedupe_key");