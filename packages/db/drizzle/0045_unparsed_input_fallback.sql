ALTER TYPE "public"."ai_response_run_state" ADD VALUE 'SKIPPED' BEFORE 'CANCELLED';--> statement-breakpoint
ALTER TABLE "ai_member_config" ADD COLUMN "unparsed_fallback_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_member_config" ADD COLUMN "unparsed_fallback_texts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_response_run" ADD COLUMN "unparsed_fallback_text" text;