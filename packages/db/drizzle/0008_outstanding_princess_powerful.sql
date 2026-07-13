CREATE TABLE "ingestion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"terms" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"scanned" integer NOT NULL,
	"matched" integer NOT NULL,
	"ingested" integer NOT NULL,
	"duplicates" integer NOT NULL,
	"skipped" integer NOT NULL,
	"by_platform" jsonb NOT NULL,
	"duration_ms" integer NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"error" text
);
