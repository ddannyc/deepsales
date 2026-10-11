ALTER TABLE "knowledge_document" ADD COLUMN "question" text;--> statement-breakpoint
ALTER TABLE "knowledge_document" ADD COLUMN "answer" text;--> statement-breakpoint
ALTER TABLE "knowledge_document" ADD COLUMN "question_key" text;--> statement-breakpoint
ALTER TABLE "knowledge_document" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_document" ADD COLUMN "index_operation_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
UPDATE "knowledge_document" SET "index_operation_id" = "id";--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_question_base_key" ON "knowledge_document" USING btree ("knowledge_base_id","question_key");--> statement-breakpoint
ALTER TABLE "knowledge_document" ADD CONSTRAINT "knowledge_question_consistency" CHECK (("knowledge_document"."question" is null and "knowledge_document"."answer" is null and "knowledge_document"."question_key" is null) or ("knowledge_document"."question" is not null and "knowledge_document"."answer" is not null and "knowledge_document"."question_key" is not null and "knowledge_document"."source_type" = 'TEXT'));--> statement-breakpoint
ALTER TABLE "knowledge_document" ADD CONSTRAINT "knowledge_revision_positive" CHECK ("knowledge_document"."revision" > 0);
