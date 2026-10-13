ALTER TYPE "public"."ai_response_cancellation_reason" ADD VALUE 'PROPERTY_COLLECTION_CHANGED';--> statement-breakpoint
CREATE TABLE "ai_property_rule" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"instructions" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_response_run" ADD COLUMN "property_collection" jsonb;--> statement-breakpoint
ALTER TABLE "ai_property_rule" ADD CONSTRAINT "ai_property_rule_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_property_rule" ADD CONSTRAINT "ai_property_rule_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_property_rule" ADD CONSTRAINT "ai_property_rule_definition_id_customer_property_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."customer_property_definition"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_property_rule_member_definition_idx" ON "ai_property_rule" USING btree ("member_id","definition_id");