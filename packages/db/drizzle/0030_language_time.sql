ALTER TABLE "ai_member_config" ADD COLUMN "automatic_language_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_member_config" ADD COLUMN "time_zone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "ai_reply_language" text;