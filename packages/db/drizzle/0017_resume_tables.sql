CREATE TABLE "resume_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resume_id" uuid,
	"kind" text NOT NULL,
	"prompt" text,
	"status" text DEFAULT 'running' NOT NULL,
	"transcript" jsonb,
	"commit_sha" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "resumes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"tex_path" text NOT NULL,
	"tex_source" text,
	"pdf_storage_path" text,
	"document_id" uuid,
	"last_commit_sha" text,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "resumes_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "resume_runs" ADD CONSTRAINT "resume_runs_resume_id_resumes_id_fk" FOREIGN KEY ("resume_id") REFERENCES "public"."resumes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resume_runs_resume_id_idx" ON "resume_runs" USING btree ("resume_id");