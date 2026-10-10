CREATE TYPE "public"."customer_fact_level" AS ENUM('CUSTOMER', 'CONVERSATION');--> statement-breakpoint
CREATE TYPE "public"."customer_property_type" AS ENUM('TEXT', 'NUMBER', 'OPTION');--> statement-breakpoint
CREATE TABLE "customer_property_definition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"level" "customer_fact_level" NOT NULL,
	"type" "customer_property_type" NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_length" integer DEFAULT 2000 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "customer_property_definition_length" CHECK ("customer_property_definition"."max_length" between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "customer_property_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"value_id" uuid NOT NULL,
	"definition_name" text NOT NULL,
	"value" jsonb,
	"revision" integer NOT NULL,
	"allow_automatic_update" boolean NOT NULL,
	"source_member_id" uuid,
	"source_name" text DEFAULT 'Former member' NOT NULL,
	"source_channel_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_property_value" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"definition_id" uuid NOT NULL,
	"customer_id" uuid,
	"conversation_id" uuid,
	"value" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"allow_automatic_update" boolean DEFAULT false NOT NULL,
	"source_member_id" uuid,
	"source_channel_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_property_value_target" CHECK (("customer_property_value"."customer_id" is not null) <> ("customer_property_value"."conversation_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "customer_tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag_id" uuid NOT NULL,
	"customer_id" uuid,
	"conversation_id" uuid,
	"source_member_id" uuid,
	"source_channel_id" uuid NOT NULL,
	CONSTRAINT "customer_tag_target" CHECK (("customer_tag"."customer_id" is not null) <> ("customer_tag"."conversation_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "customer_tag_definition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"level" "customer_fact_level" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "preferred_language" text;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "owner_member_id" uuid;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "profile_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "profile_source_channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_property_definition" ADD CONSTRAINT "customer_property_definition_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_property_history" ADD CONSTRAINT "customer_property_history_value_id_customer_property_value_id_fk" FOREIGN KEY ("value_id") REFERENCES "public"."customer_property_value"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_property_history" ADD CONSTRAINT "customer_property_history_source_member_id_member_id_fk" FOREIGN KEY ("source_member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_property_history" ADD CONSTRAINT "customer_property_history_source_channel_id_channel_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."channel"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_property_value" ADD CONSTRAINT "customer_property_value_definition_id_customer_property_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."customer_property_definition"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_property_value" ADD CONSTRAINT "customer_property_value_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_property_value" ADD CONSTRAINT "customer_property_value_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_property_value" ADD CONSTRAINT "customer_property_value_source_member_id_member_id_fk" FOREIGN KEY ("source_member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_property_value" ADD CONSTRAINT "customer_property_value_source_channel_id_channel_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."channel"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tag" ADD CONSTRAINT "customer_tag_tag_id_customer_tag_definition_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."customer_tag_definition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tag" ADD CONSTRAINT "customer_tag_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tag" ADD CONSTRAINT "customer_tag_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tag" ADD CONSTRAINT "customer_tag_source_member_id_member_id_fk" FOREIGN KEY ("source_member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tag" ADD CONSTRAINT "customer_tag_source_channel_id_channel_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."channel"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tag_definition" ADD CONSTRAINT "customer_tag_definition_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_property_definition_name_idx" ON "customer_property_definition" USING btree ("workspace_id","level",lower("name")) WHERE "customer_property_definition"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "customer_property_history_value_idx" ON "customer_property_history" USING btree ("value_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_property_value_customer_idx" ON "customer_property_value" USING btree ("definition_id","customer_id") WHERE "customer_property_value"."customer_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_property_value_conversation_idx" ON "customer_property_value" USING btree ("definition_id","conversation_id") WHERE "customer_property_value"."conversation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_tag_customer_idx" ON "customer_tag" USING btree ("tag_id","customer_id") WHERE "customer_tag"."customer_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_tag_conversation_idx" ON "customer_tag" USING btree ("tag_id","conversation_id") WHERE "customer_tag"."conversation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_tag_definition_name_idx" ON "customer_tag_definition" USING btree ("workspace_id","level",lower("name"));--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_owner_member_id_member_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
UPDATE customer c SET profile_source_channel_ids = s.channels FROM (
  SELECT customer_id, jsonb_agg(DISTINCT channel_id) AS channels FROM channel_identity GROUP BY customer_id
) s WHERE c.id = s.customer_id AND (c.display_name IS NOT NULL OR c.avatar_url IS NOT NULL);
