CREATE TABLE "ai_tool_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"run_id" uuid,
	"ordinal" integer NOT NULL,
	"tool" text NOT NULL,
	"definition_revision" integer DEFAULT 1 NOT NULL,
	"arguments" jsonb NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"result" jsonb,
	"failure_code" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_tool_action_ordinal" CHECK ("ai_tool_action"."ordinal" between 0 and 2),
	CONSTRAINT "ai_tool_action_state" CHECK ("ai_tool_action"."state" in ('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED','UNKNOWN')),
	CONSTRAINT "ai_tool_action_scope" CHECK ("ai_tool_action"."run_id" is not null or "ai_tool_action"."simulated")
);
--> statement-breakpoint
ALTER TABLE "ai_tool_action" ADD CONSTRAINT "ai_tool_action_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_action" ADD CONSTRAINT "ai_tool_action_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_action" ADD CONSTRAINT "ai_tool_action_operation_id_ai_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."ai_operation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_action" ADD CONSTRAINT "ai_tool_action_run_id_ai_response_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_response_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_tool_action_operation_ordinal_idx" ON "ai_tool_action" USING btree ("operation_id","ordinal");