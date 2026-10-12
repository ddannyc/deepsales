CREATE TABLE "ai_question_set" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"questions" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "ai_question_set_size_valid" CHECK (jsonb_array_length("ai_question_set"."questions") between 1 and 100),
	CONSTRAINT "ai_question_set_revision_valid" CHECK ("ai_question_set"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "ai_test_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"question_set_id" uuid,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"config_version_id" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_test_batch_source_valid" CHECK ("ai_test_batch"."source" in ('DRAFT', 'PUBLISHED', 'VERSION'))
);
--> statement-breakpoint
CREATE TABLE "ai_test_batch_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"failure_code" text,
	CONSTRAINT "ai_test_batch_item_position_valid" CHECK ("ai_test_batch_item"."position" between 0 and 99),
	CONSTRAINT "ai_test_batch_item_attempt_valid" CHECK ("ai_test_batch_item"."attempt" between 0 and 3),
	CONSTRAINT "ai_test_batch_item_state_valid" CHECK ("ai_test_batch_item"."state" in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'UNKNOWN', 'CANCELLED'))
);
--> statement-breakpoint
ALTER TABLE "ai_question_set" ADD CONSTRAINT "ai_question_set_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_question_set" ADD CONSTRAINT "ai_question_set_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_test_batch" ADD CONSTRAINT "ai_test_batch_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_test_batch" ADD CONSTRAINT "ai_test_batch_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_test_batch" ADD CONSTRAINT "ai_test_batch_question_set_id_ai_question_set_id_fk" FOREIGN KEY ("question_set_id") REFERENCES "public"."ai_question_set"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_test_batch" ADD CONSTRAINT "ai_test_batch_config_version_id_ai_config_version_id_fk" FOREIGN KEY ("config_version_id") REFERENCES "public"."ai_config_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_test_batch_item" ADD CONSTRAINT "ai_test_batch_item_batch_id_ai_test_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."ai_test_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_question_set_workspace_idx" ON "ai_question_set" USING btree ("workspace_id","member_id");--> statement-breakpoint
CREATE INDEX "ai_test_batch_workspace_idx" ON "ai_test_batch" USING btree ("workspace_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_test_batch_item_position_unique" ON "ai_test_batch_item" USING btree ("batch_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_test_batch_item_running_unique" ON "ai_test_batch_item" USING btree ("batch_id") WHERE "ai_test_batch_item"."state" = 'RUNNING';