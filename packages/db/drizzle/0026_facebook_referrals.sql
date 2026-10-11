CREATE TABLE "facebook_referral" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_identity_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"external_message_id" text,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"ref" text,
	"ad_id" text,
	"referer_uri" text,
	"ad_title" text,
	"image_url" text,
	"provider_sent_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"event_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "facebook_referral" ADD CONSTRAINT "facebook_referral_channel_identity_id_channel_identity_id_fk" FOREIGN KEY ("channel_identity_id") REFERENCES "public"."channel_identity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "facebook_referral_identity_event_key" ON "facebook_referral" USING btree ("channel_identity_id","event_key");--> statement-breakpoint
CREATE INDEX "facebook_referral_timeline_idx" ON "facebook_referral" USING btree ("channel_identity_id","event_at","id");