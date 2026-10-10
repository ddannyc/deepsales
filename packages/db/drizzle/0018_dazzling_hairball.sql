CREATE TABLE "conversation_member_read" (
	"conversation_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"last_read_message_id" uuid NOT NULL,
	CONSTRAINT "conversation_member_read_member_id_conversation_id_pk" PRIMARY KEY("member_id","conversation_id")
);
--> statement-breakpoint
CREATE TABLE "facebook_message_receipt" (
	"channel_identity_id" uuid NOT NULL,
	"external_message_id" text NOT NULL,
	"provider_sent_at" timestamp with time zone,
	"delivered" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facebook_message_receipt_channel_identity_id_external_message_id_pk" PRIMARY KEY("channel_identity_id","external_message_id")
);
--> statement-breakpoint
CREATE TABLE "facebook_receipt_watermark" (
	"channel_identity_id" uuid PRIMARY KEY NOT NULL,
	"delivered_through" timestamp with time zone,
	"read_through" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message_member_read" (
	"message_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_member_read_member_id_message_id_pk" PRIMARY KEY("member_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_member_read" ADD CONSTRAINT "conversation_member_read_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_member_read" ADD CONSTRAINT "conversation_member_read_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_member_read" ADD CONSTRAINT "conversation_member_read_last_read_message_id_message_id_fk" FOREIGN KEY ("last_read_message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facebook_message_receipt" ADD CONSTRAINT "facebook_message_receipt_channel_identity_id_channel_identity_id_fk" FOREIGN KEY ("channel_identity_id") REFERENCES "public"."channel_identity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facebook_receipt_watermark" ADD CONSTRAINT "facebook_receipt_watermark_channel_identity_id_channel_identity_id_fk" FOREIGN KEY ("channel_identity_id") REFERENCES "public"."channel_identity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_member_read" ADD CONSTRAINT "message_member_read_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_member_read" ADD CONSTRAINT "message_member_read_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;