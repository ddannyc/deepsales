CREATE TABLE "registration_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_by_user_id" uuid,
	"accepted_at" timestamp with time zone,
	"workspace_created_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_invitation_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "registration_invitation_accepted_by_user_id_unique" UNIQUE("accepted_by_user_id")
);
--> statement-breakpoint
ALTER TABLE "registration_invitation" ADD CONSTRAINT "registration_invitation_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;