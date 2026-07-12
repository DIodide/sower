CREATE TABLE "api_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"phase" text NOT NULL,
	"method" text NOT NULL,
	"url" text NOT NULL,
	"request_headers" jsonb,
	"request_body" jsonb,
	"response_status" integer,
	"response_headers" jsonb,
	"response_body" jsonb,
	"duration_ms" integer,
	"dry_run" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"filename" text NOT NULL,
	"storage_path" text NOT NULL,
	"content_type" text,
	"size_bytes" integer,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "api_calls" ADD CONSTRAINT "api_calls_task_id_application_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."application_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_calls_task_id_idx" ON "api_calls" USING btree ("task_id");