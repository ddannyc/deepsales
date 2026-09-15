CREATE TYPE "public"."ai_runtime_status" AS ENUM('UNPUBLISHED', 'USABLE', 'UNHEALTHY');--> statement-breakpoint
CREATE TABLE "ai_member_config" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"response_language" text DEFAULT '' NOT NULL,
	"knowledge_base_id" uuid,
	"handoff_on_customer_request" boolean DEFAULT true NOT NULL,
	"handoff_on_no_knowledge" boolean DEFAULT true NOT NULL,
	"handoff_on_negative_sentiment" boolean DEFAULT true NOT NULL,
	"handoff_on_unable_to_answer" boolean DEFAULT true NOT NULL,
	"handoff_keywords" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"published_snapshot" jsonb,
	"published_at" timestamp with time zone,
	"runtime_status" "ai_runtime_status" DEFAULT 'UNPUBLISHED' NOT NULL,
	"runtime_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_member_config" ADD CONSTRAINT "ai_member_config_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_member_config" ADD CONSTRAINT "ai_member_config_knowledge_base_id_knowledge_base_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_base"("id") ON DELETE set null ON UPDATE no action;