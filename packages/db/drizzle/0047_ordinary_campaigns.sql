CREATE TABLE "campaign" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"creator_member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"identity_ids" uuid[] NOT NULL,
	"content" jsonb NOT NULL,
	"selection_mode" text DEFAULT 'ALL' NOT NULL,
	"target_language" text,
	"calendar" jsonb,
	"interval_seconds" integer DEFAULT 1 NOT NULL,
	"next_run_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_status_check" CHECK ("campaign"."status" in ('DRAFT','ACTIVE','PAUSED','CANCELLED','COMPLETED')),
	CONSTRAINT "campaign_interval_check" CHECK ("campaign"."interval_seconds" between 1 and 86400),
	CONSTRAINT "campaign_selection_check" CHECK ("campaign"."selection_mode" in ('ALL','RANDOM'))
);
--> statement-breakpoint
CREATE TABLE "campaign_recipient" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"channel_identity_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"state" text DEFAULT 'WAITING' NOT NULL,
	"reason" text,
	"content" jsonb NOT NULL,
	"translated_content" jsonb,
	"translation_operation_id" uuid NOT NULL,
	"message_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_recipient_state_check" CHECK ("campaign_recipient"."state" in ('WAITING','SUCCESS','FAILED','SKIPPED','UNKNOWN'))
);
--> statement-breakpoint
CREATE TABLE "campaign_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_creator_member_id_member_id_fk" FOREIGN KEY ("creator_member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipient" ADD CONSTRAINT "campaign_recipient_run_id_campaign_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."campaign_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipient" ADD CONSTRAINT "campaign_recipient_channel_identity_id_channel_identity_id_fk" FOREIGN KEY ("channel_identity_id") REFERENCES "public"."channel_identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_run" ADD CONSTRAINT "campaign_run_campaign_id_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaign"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_due_idx" ON "campaign" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipient_identity_idx" ON "campaign_recipient" USING btree ("run_id","channel_identity_id");--> statement-breakpoint
CREATE INDEX "campaign_recipient_pending_idx" ON "campaign_recipient" USING btree ("state","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_run_occurrence_idx" ON "campaign_run" USING btree ("campaign_id","scheduled_at");