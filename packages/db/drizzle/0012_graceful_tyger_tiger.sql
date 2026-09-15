CREATE TYPE "public"."ai_response_cancellation_reason" AS ENUM('OWNERSHIP_CHANGED', 'NEW_CUSTOMER_MESSAGE');--> statement-breakpoint
CREATE TYPE "public"."ai_response_run_state" AS ENUM('QUEUED', 'GENERATING', 'COMPLETED', 'HANDOFF', 'CANCELLED', 'FAILED');--> statement-breakpoint
CREATE TABLE "ai_response_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"state" "ai_response_run_state" DEFAULT 'QUEUED' NOT NULL,
	"input_first_message_id" uuid NOT NULL,
	"input_last_message_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"retrieved_chunk_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"cancellation_reason" "ai_response_cancellation_reason",
	"failure_code" text,
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_response_run" ADD CONSTRAINT "ai_response_run_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_response_run" ADD CONSTRAINT "ai_response_run_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_response_run" ADD CONSTRAINT "ai_response_run_input_first_message_id_message_id_fk" FOREIGN KEY ("input_first_message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_response_run" ADD CONSTRAINT "ai_response_run_input_last_message_id_message_id_fk" FOREIGN KEY ("input_last_message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_response_run_conversation_idx" ON "ai_response_run" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "ai_response_run_schedule_idx" ON "ai_response_run" USING btree ("state","scheduled_for","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_response_run_one_active_conversation_idx" ON "ai_response_run" USING btree ("conversation_id") WHERE "ai_response_run"."state" in ('QUEUED', 'GENERATING');