CREATE TABLE "ai_test_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"config_version_id" uuid,
	"generation" integer DEFAULT 1 NOT NULL,
	"customer" jsonb NOT NULL,
	"operation_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_test_session_source_valid" CHECK ("ai_test_session"."source" in ('DRAFT', 'PUBLISHED', 'VERSION')),
	CONSTRAINT "ai_test_session_generation_valid" CHECK ("ai_test_session"."generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "ai_test_session" ADD CONSTRAINT "ai_test_session_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_test_session" ADD CONSTRAINT "ai_test_session_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_test_session" ADD CONSTRAINT "ai_test_session_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_test_session" ADD CONSTRAINT "ai_test_session_config_version_id_ai_config_version_id_fk" FOREIGN KEY ("config_version_id") REFERENCES "public"."ai_config_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_test_session_workspace_idx" ON "ai_test_session" USING btree ("workspace_id","member_id");