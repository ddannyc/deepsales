import {
  DEFAULT_KNOWLEDGE_RETRIEVAL_MAX_DISTANCE,
  searchKnowledgeChunks,
  type Database,
} from '@deepsales/db'
import { z } from 'zod'
import type { Bindings } from './bindings'
import { AIEmbeddingError, createAIClient } from './ai'

export const knowledgeDocumentJobSchema = z.object({
  v: z.literal(1),
  type: z.literal('knowledge.document'),
  documentId: z.string().uuid(),
})

export async function retrieveKnowledgeChunks(
  db: Database,
  env: Pick<
    Bindings,
    'OPENAI_API_KEY' | 'OPENAI_EMBEDDING_MODEL' | 'OPENAI_BASE_URL' | 'AI_RETRIEVAL_MAX_DISTANCE'
  >,
  input: { workspaceId: string; knowledgeBaseId: string; query: string },
) {
  if (!env.OPENAI_API_KEY) throw new AIEmbeddingError()
  const [embedding] = await createAIClient({
    apiKey: env.OPENAI_API_KEY,
    embeddingModel: env.OPENAI_EMBEDDING_MODEL,
    baseUrl: env.OPENAI_BASE_URL,
  }).embed([input.query])
  if (!embedding) throw new AIEmbeddingError()

  return searchKnowledgeChunks(db, {
    workspaceId: input.workspaceId,
    knowledgeBaseId: input.knowledgeBaseId,
    embedding,
    maxDistance: env.AI_RETRIEVAL_MAX_DISTANCE
      ? Number(env.AI_RETRIEVAL_MAX_DISTANCE)
      : DEFAULT_KNOWLEDGE_RETRIEVAL_MAX_DISTANCE,
    limit: 6,
  })
}
