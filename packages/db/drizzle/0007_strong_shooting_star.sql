ALTER TABLE "accounts" ADD COLUMN "site" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "status" text DEFAULT 'provisioned' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "application_tasks" ADD COLUMN "pending_otp" text;--> statement-breakpoint
ALTER TABLE "application_tasks" ADD COLUMN "otp_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "application_tasks" ADD COLUMN "otp_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "application_tasks" ADD COLUMN "otp_channel_id" text;--> statement-breakpoint
ALTER TABLE "application_tasks" ADD COLUMN "otp_message_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_platform_tenant_uq" ON "accounts" USING btree ("platform","tenant");