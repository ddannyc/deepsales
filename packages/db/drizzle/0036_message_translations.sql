CREATE TABLE "message_translation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"requester_member_id" uuid NOT NULL,
	"source_message_id" uuid,
	"source_version" uuid NOT NULL,
	"source_text" text NOT NULL,
	"target_language" text NOT NULL,
	"translated_text" text,
	"sent_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_operation" DROP CONSTRAINT "ai_operation_kind_valid";--> statement-breakpoint
ALTER TABLE "message_translation" ADD CONSTRAINT "message_translation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_translation" ADD CONSTRAINT "message_translation_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_translation" ADD CONSTRAINT "message_translation_requester_member_id_member_id_fk" FOREIGN KEY ("requester_member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_translation" ADD CONSTRAINT "message_translation_source_message_id_message_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_translation" ADD CONSTRAINT "message_translation_sent_message_id_message_id_fk" FOREIGN KEY ("sent_message_id") REFERENCES "public"."message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_translation_source_language_idx" ON "message_translation" USING btree ("requester_member_id","source_message_id","target_language");--> statement-breakpoint
CREATE INDEX "message_translation_conversation_idx" ON "message_translation" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "ai_operation" ADD CONSTRAINT "ai_operation_kind_valid" CHECK ("ai_operation"."kind" in ('LIVE_REPLY', 'TEST', 'KNOWLEDGE_INDEX', 'TRANSLATION'));