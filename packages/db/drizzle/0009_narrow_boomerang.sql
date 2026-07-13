CREATE TABLE "agent_heartbeats" (
	"name" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now(),
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "workday_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant" text NOT NULL,
	"host" text NOT NULL,
	"login_url" text NOT NULL,
	"status" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now(),
	"captured_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "workday_sessions_tenant_unique" UNIQUE("tenant")
);
