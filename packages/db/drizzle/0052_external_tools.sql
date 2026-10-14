CREATE TABLE "ai_external_plugin" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"name" text NOT NULL,
	"origin" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"auth" text NOT NULL,
	"encrypted_credential" text,
	"credential_iv" text,
	"credential_key_version" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_external_plugin_valid" CHECK ("ai_external_plugin"."revision" > 0 and "ai_external_plugin"."auth" in ('NONE','BEARER') and (("ai_external_plugin"."encrypted_credential" is null and "ai_external_plugin"."credential_iv" is null and "ai_external_plugin"."credential_key_version" is null) or ("ai_external_plugin"."encrypted_credential" is not null and "ai_external_plugin"."credential_iv" is not null and "ai_external_plugin"."credential_key_version" is not null)))
);
--> statement-breakpoint
CREATE TABLE "ai_external_tool" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plugin_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"effect" text NOT NULL,
	"inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fixed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output" jsonb NOT NULL,
	"object_scope" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_external_tool_valid" CHECK ("ai_external_tool"."revision" > 0 and "ai_external_tool"."effect" in ('READ','WRITE') and "ai_external_tool"."method" in ('GET','POST','PUT','PATCH','DELETE'))
);
--> statement-breakpoint
ALTER TABLE "ai_external_plugin" ADD CONSTRAINT "ai_external_plugin_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_external_plugin" ADD CONSTRAINT "ai_external_plugin_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_external_plugin" ADD CONSTRAINT "ai_external_plugin_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_external_tool" ADD CONSTRAINT "ai_external_tool_plugin_id_ai_external_plugin_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."ai_external_plugin"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_external_plugin_member_idx" ON "ai_external_plugin" USING btree ("workspace_id","member_id");--> statement-breakpoint
CREATE INDEX "ai_external_tool_plugin_idx" ON "ai_external_tool" USING btree ("plugin_id");