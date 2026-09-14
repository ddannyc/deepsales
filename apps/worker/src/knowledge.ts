import {
  DEFAULT_KNOWLEDGE_RETRIEVAL_MAX_DISTANCE,
  assertKnowledgeBaseEmbeddingCompatibility,
  searchKnowledgeChunks,
  type Database,
} from '@deepsales/db'
import { z } from 'zod'
import type { Bindings } from './bindings'
import type { EmbeddingProvider } from './ai'
import { AIEmbeddingError } from './ai'

export const knowledgeDocumentJobSchema = z.object({
  v: z.literal(1),
  type: z.literal('knowledge.document'),
  documentId: z.string().uuid(),
})

export async function retrieveKnowledgeChunks(
  db: Database,
  embeddingProvider: EmbeddingProvider,
  env: Pick<Bindings, 'AI_RETRIEVAL_MAX_DISTANCE'>,
  input: { workspaceId: string; knowledgeBaseId: string; query: string },
) {
  await assertKnowledgeBaseEmbeddingCompatibility(db, {
    workspaceId: input.workspaceId,
    knowledgeBaseId: input.knowledgeBaseId,
    embeddingMetadata: embeddingProvider.metadata,
  })
  const [embedding] = await embeddingProvider.embed([input.query])
  if (!embedding) throw new AIEmbeddingError()

  return searchKnowledgeChunks(db, {
    workspaceId: input.workspaceId,
    knowledgeBaseId: input.knowledgeBaseId,
    embedding,
    embeddingMetadata: embeddingProvider.metadata,
    maxDistance: env.AI_RETRIEVAL_MAX_DISTANCE
      ? Number(env.AI_RETRIEVAL_MAX_DISTANCE)
      : DEFAULT_KNOWLEDGE_RETRIEVAL_MAX_DISTANCE,
    limit: 6,
  })
}
