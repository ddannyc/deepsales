CREATE TYPE "public"."facebook_connection_status" AS ENUM('ACTIVE', 'ACTION_REQUIRED', 'DISABLED');--> statement-breakpoint
CREATE TABLE "facebook_channel_config" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"encrypted_page_access_token" text NOT NULL,
	"token_iv" text NOT NULL,
	"token_key_version" text DEFAULT 'v1' NOT NULL,
	"connection_status" "facebook_connection_status" DEFAULT 'ACTIVE' NOT NULL,
	"subscribed_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_subcode" integer,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facebook_channel_config_page_id_unique" UNIQUE("page_id")
);
--> statement-breakpoint
CREATE TABLE "facebook_oauth_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"initiated_by_user_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"encrypted_user_access_token" text,
	"user_token_iv" text,
	"user_token_key_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facebook_oauth_state_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
ALTER TABLE "facebook_channel_config" ADD CONSTRAINT "facebook_channel_config_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facebook_oauth_state" ADD CONSTRAINT "facebook_oauth_state_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facebook_oauth_state" ADD CONSTRAINT "facebook_oauth_state_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "facebook_oauth_state_workspace_id_idx" ON "facebook_oauth_state" USING btree ("workspace_id");
