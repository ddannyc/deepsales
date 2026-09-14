ALTER TABLE "knowledge_base" ADD COLUMN "embedding_provider" text;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "embedding_dimensions" integer;