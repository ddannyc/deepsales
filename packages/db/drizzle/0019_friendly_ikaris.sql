CREATE TABLE "inbox_saved_view" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"filters" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_saved_view_scope" CHECK ("inbox_saved_view"."scope" in ('PERSONAL', 'PUBLIC')),
	CONSTRAINT "inbox_saved_view_name" CHECK (length(btrim("inbox_saved_view"."name")) between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "inbox_saved_view" ADD CONSTRAINT "inbox_saved_view_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_saved_view" ADD CONSTRAINT "inbox_saved_view_owner_member_id_member_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_saved_view_workspace_idx" ON "inbox_saved_view" USING btree ("workspace_id","owner_member_id");