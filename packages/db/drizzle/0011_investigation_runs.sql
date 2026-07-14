CREATE TABLE "investigation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"result" jsonb,
	"transcript" jsonb,
	"found_job_id" uuid,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "investigation_runs" ADD CONSTRAINT "investigation_runs_task_id_application_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."application_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_runs" ADD CONSTRAINT "investigation_runs_found_job_id_jobs_id_fk" FOREIGN KEY ("found_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "investigation_runs_task_id_idx" ON "investigation_runs" USING btree ("task_id");