CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"tenant" text NOT NULL,
	"email_alias" text,
	"secret_ref" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_label" text NOT NULL,
	"normalized_label" text NOT NULL,
	"value" jsonb NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "application_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"state" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"job_spec" jsonb,
	"resolution" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"company" text,
	"title" text,
	"platform" text NOT NULL,
	"tenant" text,
	"external_id" text,
	"terms" jsonb,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "jobs_canonical_url_unique" UNIQUE("canonical_url")
);
--> statement-breakpoint
ALTER TABLE "application_tasks" ADD CONSTRAINT "application_tasks_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_task_id_application_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."application_tasks"("id") ON DELETE no action ON UPDATE no action;