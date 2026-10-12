CREATE TABLE "customer_memory" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"cursor" bigint DEFAULT 0 NOT NULL,
	"cleared_at" timestamp with time zone DEFAULT '1970-01-01'::timestamptz NOT NULL,
	"latest_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_channel_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"pending_operation_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_memory_summary_size" CHECK (char_length("customer_memory"."summary") <= 1000),
	CONSTRAINT "customer_memory_revision_valid" CHECK ("customer_memory"."revision" >= 0 and "customer_memory"."cursor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "customer_memory_communication" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_memory_communication_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
ALTER TABLE "ai_operation" DROP CONSTRAINT "ai_operation_kind_valid";--> statement-breakpoint
ALTER TABLE "ai_member_config" ADD COLUMN "memory_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_response_run" ADD COLUMN "customer_memory_input" jsonb;--> statement-breakpoint
ALTER TABLE "customer_memory" ADD CONSTRAINT "customer_memory_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_memory" ADD CONSTRAINT "customer_memory_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_memory_communication" ADD CONSTRAINT "customer_memory_communication_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_memory_communication" ADD CONSTRAINT "customer_memory_communication_identity_id_channel_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."channel_identity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_memory_due_idx" ON "customer_memory" USING btree ("latest_activity_at");--> statement-breakpoint
CREATE INDEX "customer_memory_communication_identity_idx" ON "customer_memory_communication" USING btree ("identity_id","sequence");--> statement-breakpoint
ALTER TABLE "ai_operation" ADD CONSTRAINT "ai_operation_kind_valid" CHECK ("ai_operation"."kind" in ('LIVE_REPLY', 'TEST', 'KNOWLEDGE_INDEX', 'TRANSLATION', 'SUGGESTION', 'PERSONA', 'CUSTOMER_MEMORY'));
--> statement-breakpoint
INSERT INTO customer_memory_communication (message_id, identity_id, occurred_at)
SELECT m.id, c.channel_identity_id, coalesce(m.delivery_completed_at, m.created_at)
FROM message m JOIN conversation c ON c.id = m.conversation_id
WHERE (m.direction = 'INBOUND' AND m.sender_type = 'CUSTOMER')
   OR (m.direction = 'OUTBOUND' AND m.sender_type = 'MEMBER' AND m.delivery_state = 'SENT')
ORDER BY coalesce(m.delivery_completed_at, m.created_at), m.id;
--> statement-breakpoint
INSERT INTO customer_memory (customer_id, workspace_id, latest_activity_at)
SELECT i.customer_id, i.workspace_id, max(e.occurred_at)
FROM customer_memory_communication e JOIN channel_identity i ON i.id = e.identity_id
GROUP BY i.customer_id, i.workspace_id;
--> statement-breakpoint
CREATE FUNCTION record_customer_memory_communication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity_row record; memory_row record;
BEGIN
  IF NOT ((NEW.direction = 'INBOUND' AND NEW.sender_type = 'CUSTOMER') OR
          (NEW.direction = 'OUTBOUND' AND NEW.sender_type = 'MEMBER' AND NEW.delivery_state = 'SENT')) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.delivery_state IS NOT DISTINCT FROM NEW.delivery_state THEN RETURN NEW; END IF;
  SELECT i.id, i.customer_id, i.workspace_id INTO identity_row
    FROM conversation c JOIN channel_identity i ON i.id = c.channel_identity_id
    WHERE c.id = NEW.conversation_id FOR SHARE OF i;
  INSERT INTO customer_memory (customer_id, workspace_id) VALUES (identity_row.customer_id, identity_row.workspace_id)
    ON CONFLICT (customer_id) DO NOTHING;
  SELECT * INTO memory_row FROM customer_memory WHERE customer_id = identity_row.customer_id FOR UPDATE;
  IF NEW.created_at <= memory_row.cleared_at OR EXISTS (SELECT 1 FROM customer_memory_communication WHERE message_id = NEW.id) THEN RETURN NEW; END IF;
  INSERT INTO customer_memory_communication (message_id, identity_id) VALUES (NEW.id, identity_row.id);
  UPDATE ai_operation SET state = 'CANCELLED', failure_code = 'MEMORY_INPUT_CHANGED', updated_at = now()
    WHERE id = memory_row.pending_operation_id AND state IN ('RESERVED', 'STARTED');
  UPDATE customer_memory SET revision = revision + 1, latest_activity_at = clock_timestamp(),
    pending_operation_id = NULL, updated_at = clock_timestamp() WHERE customer_id = identity_row.customer_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER message_customer_memory_communication
AFTER INSERT OR UPDATE OF delivery_state ON message
FOR EACH ROW EXECUTE FUNCTION record_customer_memory_communication();
