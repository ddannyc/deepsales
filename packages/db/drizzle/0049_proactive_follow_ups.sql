CREATE TABLE "ai_follow_up_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rule_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"rule_revision" integer NOT NULL,
	"anchor_id" uuid NOT NULL,
	"anchor_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_follow_up_rule" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"timer" text NOT NULL,
	"delay_seconds" integer NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_follow_up_rule_valid" CHECK ("ai_follow_up_rule"."revision" > 0 and "ai_follow_up_rule"."delay_seconds" between 1 and 2592000 and "ai_follow_up_rule"."timer" in ('LAST_AI_REPLY','AI_ASSIGNMENT'))
);
--> statement-breakpoint
ALTER TABLE "ai_operation" DROP CONSTRAINT "ai_operation_kind_valid";--> statement-breakpoint
ALTER TABLE "ai_follow_up_event" ADD CONSTRAINT "ai_follow_up_event_id_ai_response_run_id_fk" FOREIGN KEY ("id") REFERENCES "public"."ai_response_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_follow_up_event" ADD CONSTRAINT "ai_follow_up_event_rule_id_ai_follow_up_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."ai_follow_up_rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_follow_up_event" ADD CONSTRAINT "ai_follow_up_event_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_follow_up_rule" ADD CONSTRAINT "ai_follow_up_rule_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_follow_up_rule" ADD CONSTRAINT "ai_follow_up_rule_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_follow_up_event_once_idx" ON "ai_follow_up_event" USING btree ("rule_id","conversation_id");--> statement-breakpoint
CREATE INDEX "ai_follow_up_rule_member_idx" ON "ai_follow_up_rule" USING btree ("member_id","enabled");--> statement-breakpoint
ALTER TABLE "ai_operation" ADD CONSTRAINT "ai_operation_kind_valid" CHECK ("ai_operation"."kind" in ('LIVE_REPLY', 'TEST', 'KNOWLEDGE_INDEX', 'TRANSLATION', 'SUGGESTION', 'PERSONA', 'CUSTOMER_MEMORY', 'FOLLOW_UP'));