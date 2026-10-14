ALTER TABLE "ai_tool_action" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_tool_action" ADD COLUMN "retry_at" timestamp with time zone;--> statement-breakpoint
UPDATE "ai_tool_action" SET "attempt_count" = 1
WHERE "run_id" IS NOT NULL AND NOT "simulated" AND "started_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_tool_action" ADD CONSTRAINT "ai_tool_action_attempt_count" CHECK ("ai_tool_action"."attempt_count" between 0 and 3);
