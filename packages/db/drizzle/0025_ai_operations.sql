CREATE TABLE "ai_config_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_member_config" ADD COLUMN "published_version_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_config_version" ADD CONSTRAINT "ai_config_version_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_member_config" ADD CONSTRAINT "ai_member_config_published_version_id_ai_config_version_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."ai_config_version"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "ai_budget" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"monthly_limit" integer
);
--> statement-breakpoint
CREATE TABLE "ai_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid,
	"operation_id" uuid,
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_operation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"member_id" uuid,
	"config_version_id" uuid,
	"kind" text NOT NULL,
	"state" text DEFAULT 'RESERVED' NOT NULL,
	"period" text NOT NULL,
	"charged" boolean DEFAULT false NOT NULL,
	"input" text,
	"output" jsonb,
	"snapshot" jsonb,
	"chunk_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_provider_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"state" text DEFAULT 'STARTED' NOT NULL,
	"http_status" integer,
	"response" jsonb,
	"retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai_response_run" ADD COLUMN "config_version_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_response_run" ADD COLUMN "config_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "ai_response_run" ADD COLUMN "output_message_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_budget" ADD CONSTRAINT "ai_budget_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_run_id_ai_response_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_response_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_operation_id_ai_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."ai_operation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_operation" ADD CONSTRAINT "ai_operation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_operation" ADD CONSTRAINT "ai_operation_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_operation" ADD CONSTRAINT "ai_operation_config_version_id_ai_config_version_id_fk" FOREIGN KEY ("config_version_id") REFERENCES "public"."ai_config_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_provider_attempt" ADD CONSTRAINT "ai_provider_attempt_operation_id_ai_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."ai_operation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_operation_workspace_period_idx" ON "ai_operation" USING btree ("workspace_id","period");--> statement-breakpoint
CREATE INDEX "ai_provider_attempt_operation_idx" ON "ai_provider_attempt" USING btree ("operation_id");--> statement-breakpoint
ALTER TABLE "ai_response_run" ADD CONSTRAINT "ai_response_run_config_version_id_ai_config_version_id_fk" FOREIGN KEY ("config_version_id") REFERENCES "public"."ai_config_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_response_run" ADD CONSTRAINT "ai_response_run_output_message_id_message_id_fk" FOREIGN KEY ("output_message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
INSERT INTO ai_config_version (member_id, snapshot, published_at) SELECT member_id, published_snapshot, published_at FROM ai_member_config WHERE published_snapshot IS NOT NULL AND published_version_id IS NULL;
--> statement-breakpoint
UPDATE ai_member_config c SET published_version_id = v.id FROM ai_config_version v WHERE v.member_id = c.member_id AND c.published_version_id IS NULL;

--> statement-breakpoint
ALTER TABLE "ai_operation" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "ai_budget" ADD CONSTRAINT "ai_budget_limit_nonnegative" CHECK ("ai_budget"."monthly_limit" >= 0);--> statement-breakpoint
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_one_source" CHECK (num_nonnulls("ai_feedback"."run_id", "ai_feedback"."operation_id") = 1);--> statement-breakpoint
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_category_valid" CHECK ("ai_feedback"."category" in ('KNOWLEDGE', 'MODEL', 'OTHER'));--> statement-breakpoint
ALTER TABLE "ai_operation" ADD CONSTRAINT "ai_operation_kind_valid" CHECK ("ai_operation"."kind" in ('LIVE_REPLY', 'TEST', 'KNOWLEDGE_INDEX'));--> statement-breakpoint
ALTER TABLE "ai_operation" ADD CONSTRAINT "ai_operation_state_valid" CHECK ("ai_operation"."state" in ('RESERVED', 'STARTED', 'COMPLETED', 'FAILED', 'UNKNOWN', 'CANCELLED'));--> statement-breakpoint
ALTER TABLE "ai_provider_attempt" ADD CONSTRAINT "ai_provider_attempt_state_valid" CHECK ("ai_provider_attempt"."state" in ('STARTED', 'SUCCESS', 'FAILED', 'UNKNOWN'));
--> statement-breakpoint
ALTER TABLE "ai_member_config" DROP CONSTRAINT "ai_member_config_published_version_id_ai_config_version_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_operation" DROP CONSTRAINT "ai_operation_config_version_id_ai_config_version_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_response_run" DROP CONSTRAINT "ai_response_run_config_version_id_ai_config_version_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_member_config" ADD CONSTRAINT "ai_member_config_published_version_id_ai_config_version_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."ai_config_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_operation" ADD CONSTRAINT "ai_operation_config_version_id_ai_config_version_id_fk" FOREIGN KEY ("config_version_id") REFERENCES "public"."ai_config_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_response_run" ADD CONSTRAINT "ai_response_run_config_version_id_ai_config_version_id_fk" FOREIGN KEY ("config_version_id") REFERENCES "public"."ai_config_version"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_response_run" ADD COLUMN "context_message_ids" uuid[];
--> statement-breakpoint
CREATE FUNCTION reject_ai_config_version_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Published AI configuration versions are immutable'; END; $$;
--> statement-breakpoint
CREATE TRIGGER ai_config_version_immutable BEFORE UPDATE ON ai_config_version FOR EACH ROW EXECUTE FUNCTION reject_ai_config_version_update();
