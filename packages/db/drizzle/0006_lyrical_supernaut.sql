CREATE TYPE "public"."assignment_reason" AS ENUM('AUTO_ROUTE', 'TAKEOVER', 'MANUAL_TRANSFER', 'MANUAL_UNASSIGN', 'AI_HANDOFF', 'MEMBER_DISABLED', 'CLOSE');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."message_delivery_state" AS ENUM('PENDING', 'SENT', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('INBOUND', 'OUTBOUND');--> statement-breakpoint
CREATE TYPE "public"."message_sender_type" AS ENUM('CUSTOMER', 'MEMBER', 'EXTERNAL');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('TEXT', 'ATTACHMENT');--> statement-breakpoint
CREATE TYPE "public"."queue_reason" AS ENUM('NEW_CONVERSATION', 'AI_HANDOFF', 'MANUAL_UNASSIGN', 'MEMBER_DISABLED');--> statement-breakpoint
CREATE TYPE "public"."routing_constraint" AS ENUM('ANY_MEMBER', 'HUMAN_ONLY');--> statement-breakpoint
CREATE TABLE "channel_identity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"external_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_identity_channel_id_external_user_id_unique" UNIQUE("channel_id","external_user_id")
);
--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_identity_id" uuid NOT NULL,
	"status" "conversation_status" DEFAULT 'OPEN' NOT NULL,
	"assignee_member_id" uuid,
	"queue_reason" "queue_reason",
	"routing_constraint" "routing_constraint" DEFAULT 'ANY_MEMBER' NOT NULL,
	"routing_queued_at" timestamp with time zone,
	"latest_message_at" timestamp with time zone,
	"last_customer_message_at" timestamp with time zone,
	"last_outbound_message_at" timestamp with time zone,
	"last_customer_message_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_lifecycle_fields" CHECK ((
        ("conversation"."status" = 'OPEN' and "conversation"."closed_at" is null and "conversation"."closed_by_member_id" is null and
          (("conversation"."assignee_member_id" is not null and "conversation"."queue_reason" is null and "conversation"."routing_queued_at" is null) or
           ("conversation"."assignee_member_id" is null and "conversation"."queue_reason" is not null and "conversation"."routing_queued_at" is not null)))
        or
        ("conversation"."status" = 'CLOSED' and "conversation"."assignee_member_id" is null and "conversation"."queue_reason" is null and
          "conversation"."routing_queued_at" is null and "conversation"."routing_constraint" = 'ANY_MEMBER' and
          "conversation"."closed_at" is not null and "conversation"."closed_by_member_id" is not null)
      ))
);
--> statement-breakpoint
CREATE TABLE "conversation_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"from_member_id" uuid,
	"to_member_id" uuid,
	"reason" "assignment_reason" NOT NULL,
	"acting_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facebook_messaging_window" (
	"channel_identity_id" uuid PRIMARY KEY NOT NULL,
	"last_customer_message_at" timestamp with time zone NOT NULL,
	"eligible_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facebook_webhook_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingress_id" text NOT NULL,
	"page_id" text NOT NULL,
	"external_message_id" text,
	"event_fragment" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "facebook_webhook_receipt_ingress_id_unique" UNIQUE("ingress_id")
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"sender_type" "message_sender_type" NOT NULL,
	"sender_member_id" uuid,
	"message_type" "message_type" DEFAULT 'TEXT' NOT NULL,
	"text" text,
	"external_message_id" text,
	"provider_sent_at" timestamp with time zone,
	"delivery_state" "message_delivery_state",
	"delivery_started_at" timestamp with time zone,
	"delivery_completed_at" timestamp with time zone,
	"failure_code" text,
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_sender_member_consistency" CHECK (("message"."sender_type" = 'MEMBER') = ("message"."sender_member_id" is not null)),
	CONSTRAINT "message_delivery_consistency" CHECK (("message"."direction" = 'OUTBOUND') = ("message"."delivery_state" is not null)),
	CONSTRAINT "message_text_required" CHECK ("message"."message_type" <> 'TEXT' or "message"."text" is not null)
);
--> statement-breakpoint
ALTER TABLE "channel_identity" ADD CONSTRAINT "channel_identity_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identity" ADD CONSTRAINT "channel_identity_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identity" ADD CONSTRAINT "channel_identity_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_channel_identity_id_channel_identity_id_fk" FOREIGN KEY ("channel_identity_id") REFERENCES "public"."channel_identity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_assignee_member_id_member_id_fk" FOREIGN KEY ("assignee_member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_closed_by_member_id_member_id_fk" FOREIGN KEY ("closed_by_member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_assignment" ADD CONSTRAINT "conversation_assignment_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_assignment" ADD CONSTRAINT "conversation_assignment_from_member_id_member_id_fk" FOREIGN KEY ("from_member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_assignment" ADD CONSTRAINT "conversation_assignment_to_member_id_member_id_fk" FOREIGN KEY ("to_member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_assignment" ADD CONSTRAINT "conversation_assignment_acting_member_id_member_id_fk" FOREIGN KEY ("acting_member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facebook_messaging_window" ADD CONSTRAINT "facebook_messaging_window_channel_identity_id_channel_identity_id_fk" FOREIGN KEY ("channel_identity_id") REFERENCES "public"."channel_identity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_sender_member_id_member_id_fk" FOREIGN KEY ("sender_member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_identity_workspace_id_idx" ON "channel_identity" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "conversation_workspace_updated_idx" ON "conversation" USING btree ("workspace_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "conversation_identity_status_idx" ON "conversation" USING btree ("channel_identity_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_one_open_identity_idx" ON "conversation" USING btree ("channel_identity_id") WHERE "conversation"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "conversation_assignment_conversation_idx" ON "conversation_assignment" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "customer_workspace_id_idx" ON "customer" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "facebook_webhook_receipt_received_idx" ON "facebook_webhook_receipt" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "message_conversation_created_idx" ON "message" USING btree ("conversation_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_channel_external_id_idx" ON "message" USING btree ("channel_id","external_message_id") WHERE "message"."external_message_id" is not null;