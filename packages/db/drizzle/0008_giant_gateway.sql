CREATE TYPE "public"."attachment_storage_state" AS ENUM('PENDING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."message_attachment_kind" AS ENUM('IMAGE', 'FILE', 'AUDIO', 'VIDEO');--> statement-breakpoint
CREATE TABLE "facebook_attachment_source" (
	"attachment_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_source_url" text NOT NULL,
	"url_iv" text NOT NULL,
	"token_key_version" text DEFAULT 'v1' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"kind" "message_attachment_kind" NOT NULL,
	"filename" text,
	"mime_type" text,
	"byte_size" integer,
	"storage_key" text,
	"storage_state" "attachment_storage_state" DEFAULT 'PENDING' NOT NULL,
	"processing_started_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_attachment_byte_size" CHECK ("message_attachment"."byte_size" is null or "message_attachment"."byte_size" >= 0)
);
--> statement-breakpoint
ALTER TABLE "facebook_attachment_source" ADD CONSTRAINT "facebook_attachment_source_attachment_id_message_attachment_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."message_attachment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "facebook_attachment_source_expires_idx" ON "facebook_attachment_source" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "message_attachment_message_idx" ON "message_attachment" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_attachment_processing_idx" ON "message_attachment" USING btree ("storage_state","processing_started_at","updated_at");