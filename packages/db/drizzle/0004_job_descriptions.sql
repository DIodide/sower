CREATE TABLE "job_descriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "job_descriptions" ADD CONSTRAINT "job_descriptions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_descriptions_job_id_idx" ON "job_descriptions" USING btree ("job_id");