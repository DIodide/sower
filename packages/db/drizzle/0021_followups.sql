CREATE TABLE "followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"state" text DEFAULT 'RECEIVED' NOT NULL,
	"url" text,
	"notes" text,
	"due_date" timestamp with time zone,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"calendar_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "followups" ADD CONSTRAINT "followups_task_id_application_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."application_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "followups_task_id_created_at_idx" ON "followups" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "followups_source_ref_uq" ON "followups" USING btree ("source_ref") WHERE "followups"."source_ref" IS NOT NULL;