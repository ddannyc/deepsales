CREATE TABLE "facebook_delivery_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"http_status" integer,
	"code" integer,
	"subcode" integer,
	"type" text,
	"message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "facebook_delivery_attempt_message_id_attempt_number_unique" UNIQUE("message_id","attempt_number"),
	CONSTRAINT "facebook_delivery_attempt_number" CHECK ("facebook_delivery_attempt"."attempt_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "facebook_delivery_attempt" ADD CONSTRAINT "facebook_delivery_attempt_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "facebook_delivery_attempt_message_idx" ON "facebook_delivery_attempt" USING btree ("message_id");