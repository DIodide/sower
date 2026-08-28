CREATE TABLE "fill_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"live_view_url" text,
	"report" jsonb,
	"error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "fill_jobs" ADD CONSTRAINT "fill_jobs_task_id_application_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."application_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fill_jobs_status_requested_at_idx" ON "fill_jobs" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "fill_jobs_task_id_requested_at_idx" ON "fill_jobs" USING btree ("task_id","requested_at");