CREATE TABLE "conversation_member_mute" (
	"conversation_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	CONSTRAINT "conversation_member_mute_member_id_conversation_id_pk" PRIMARY KEY("member_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_member_mute" ADD CONSTRAINT "conversation_member_mute_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_member_mute" ADD CONSTRAINT "conversation_member_mute_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;