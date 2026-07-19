ALTER TABLE "application_tasks" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "application_tasks" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;