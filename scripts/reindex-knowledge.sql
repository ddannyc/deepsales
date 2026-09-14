-- Reindex/maintenance only: run after an approved backup and during a maintenance window.
-- Source text and R2 storage_key are intentionally preserved.
BEGIN;

DELETE FROM knowledge_chunk;

UPDATE knowledge_base
SET embedding_provider = NULL,
    embedding_model = NULL,
    embedding_dimensions = NULL,
    updated_at = now();

UPDATE knowledge_document
SET status = 'UPLOADED',
    processing_started_at = NULL,
    content_sha256 = NULL,
    failure_code = NULL,
    failure_message = NULL,
    updated_at = now()
WHERE source_text IS NOT NULL OR storage_key IS NOT NULL;

COMMIT;
