ALTER TABLE "ai_member_config" ADD COLUMN "ad_learning_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_member_config" ADD COLUMN "ad_mappings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_response_run" ADD COLUMN "advertising_context" jsonb;