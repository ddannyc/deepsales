CREATE TABLE "conversation_internal_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_member_id" uuid,
	"author_name" text NOT NULL,
	"client_key" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_internal_note_text" CHECK (length(btrim("conversation_internal_note"."text")) between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "conversation_internal_note" ADD CONSTRAINT "conversation_internal_note_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_internal_note" ADD CONSTRAINT "conversation_internal_note_author_member_id_member_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_internal_note_retry_idx" ON "conversation_internal_note" USING btree ("conversation_id","author_member_id","client_key");--> statement-breakpoint
CREATE INDEX "conversation_internal_note_history_idx" ON "conversation_internal_note" USING btree ("conversation_id","created_at","id");