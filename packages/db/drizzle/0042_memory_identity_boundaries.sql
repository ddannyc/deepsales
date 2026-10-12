ALTER TABLE "channel_identity" ADD COLUMN "memory_boundary_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_identity" ADD COLUMN "memory_boundary_at" timestamp with time zone DEFAULT '1970-01-01'::timestamptz NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_customer_memory_communication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity_row record; memory_row record;
BEGIN
  IF NOT ((NEW.direction = 'INBOUND' AND NEW.sender_type = 'CUSTOMER') OR
          (NEW.direction = 'OUTBOUND' AND NEW.sender_type = 'MEMBER' AND NEW.delivery_state = 'SENT')) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.delivery_state IS NOT DISTINCT FROM NEW.delivery_state THEN RETURN NEW; END IF;
  SELECT i.id, i.customer_id, i.workspace_id, i.memory_boundary_at INTO identity_row
    FROM conversation c JOIN channel_identity i ON i.id = c.channel_identity_id
    WHERE c.id = NEW.conversation_id FOR SHARE OF i;
  INSERT INTO customer_memory (customer_id, workspace_id) VALUES (identity_row.customer_id, identity_row.workspace_id)
    ON CONFLICT (customer_id) DO NOTHING;
  SELECT * INTO memory_row FROM customer_memory WHERE customer_id = identity_row.customer_id FOR UPDATE;
  IF NEW.created_at <= greatest(memory_row.cleared_at, identity_row.memory_boundary_at) OR EXISTS (SELECT 1 FROM customer_memory_communication WHERE message_id = NEW.id) THEN RETURN NEW; END IF;
  INSERT INTO customer_memory_communication (message_id, identity_id) VALUES (NEW.id, identity_row.id);
  UPDATE ai_operation SET state = 'CANCELLED', failure_code = 'MEMORY_INPUT_CHANGED', updated_at = now()
    WHERE id = memory_row.pending_operation_id AND state IN ('RESERVED', 'STARTED');
  UPDATE customer_memory SET revision = revision + 1, latest_activity_at = clock_timestamp(),
    pending_operation_id = NULL, updated_at = clock_timestamp() WHERE customer_id = identity_row.customer_id;
  RETURN NEW;
END;
$$;
