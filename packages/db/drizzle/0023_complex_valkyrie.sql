CREATE TABLE "facebook_media_upload" (
	"attachment_id" uuid PRIMARY KEY NOT NULL,
	"provider_attachment_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "client_key" uuid;--> statement-breakpoint
ALTER TABLE "message_attachment" ADD COLUMN "asset_id" uuid;--> statement-breakpoint
ALTER TABLE "facebook_media_upload" ADD CONSTRAINT "facebook_media_upload_attachment_id_message_attachment_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."message_attachment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_asset_id_media_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_asset"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_human_retry_idx" ON "message" USING btree ("conversation_id","sender_member_id","client_key");