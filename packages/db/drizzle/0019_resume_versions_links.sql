CREATE TABLE "resume_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resume_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_links_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "resume_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resume_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"tex_source" text NOT NULL,
	"pdf_storage_path" text,
	"run_id" uuid,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resume_links" ADD CONSTRAINT "resume_links_resume_id_resumes_id_fk" FOREIGN KEY ("resume_id") REFERENCES "public"."resumes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_resume_id_resumes_id_fk" FOREIGN KEY ("resume_id") REFERENCES "public"."resumes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_run_id_resume_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."resume_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resume_links_resume_id_idx" ON "resume_links" USING btree ("resume_id");--> statement-breakpoint
CREATE INDEX "resume_versions_resume_id_created_at_idx" ON "resume_versions" USING btree ("resume_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "resume_versions_resume_id_commit_sha_uq" ON "resume_versions" USING btree ("resume_id","commit_sha");