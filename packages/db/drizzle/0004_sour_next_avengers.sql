ALTER TABLE "workspace_invitation" ADD COLUMN "available" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_invitation" ADD COLUMN "auto_assignment_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_invitation" ADD COLUMN "max_active_conversations" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_invitation" ADD COLUMN "channel_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_invitation" ADD CONSTRAINT "workspace_invitation_capacity" CHECK ("workspace_invitation"."max_active_conversations" >= 0);