CREATE TABLE "reply_suggestion" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"requester_member_id" uuid NOT NULL,
	"ai_member_id" uuid NOT NULL,
	"input_message_id" uuid NOT NULL,
	"context_message_ids" uuid[] NOT NULL,
	"snapshot" jsonb NOT NULL,
	"config_version_id" uuid,
	"suggested_text" text,
	"chunk_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"sent_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_operation" DROP CONSTRAINT "ai_operation_kind_valid";--> statement-breakpoint
ALTER TABLE "reply_suggestion" ADD CONSTRAINT "reply_suggestion_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_suggestion" ADD CONSTRAINT "reply_suggestion_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_suggestion" ADD CONSTRAINT "reply_suggestion_requester_member_id_member_id_fk" FOREIGN KEY ("requester_member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_suggestion" ADD CONSTRAINT "reply_suggestion_ai_member_id_member_id_fk" FOREIGN KEY ("ai_member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_suggestion" ADD CONSTRAINT "reply_suggestion_input_message_id_message_id_fk" FOREIGN KEY ("input_message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_suggestion" ADD CONSTRAINT "reply_suggestion_config_version_id_ai_config_version_id_fk" FOREIGN KEY ("config_version_id") REFERENCES "public"."ai_config_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_suggestion" ADD CONSTRAINT "reply_suggestion_sent_message_id_message_id_fk" FOREIGN KEY ("sent_message_id") REFERENCES "public"."message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reply_suggestion_conversation_idx" ON "reply_suggestion" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "ai_operation" ADD CONSTRAINT "ai_operation_kind_valid" CHECK ("ai_operation"."kind" in ('LIVE_REPLY', 'TEST', 'KNOWLEDGE_INDEX', 'TRANSLATION', 'SUGGESTION'));