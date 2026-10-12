import {
  AiUsageError,
  type CustomerMemoryInput,
  completeCustomerMemoryUpdate,
  type Database,
  finishAiOperation,
  prepareCustomerMemoryUpdate,
} from '@deepsales/db'
import { z } from 'zod'
import { AIProviderError, createAlibabaLlmProvider } from './ai'
import { meteredAiFetch } from './ai-usage'
import type { Bindings } from './bindings'

export const customerMemoryJobSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('customer.memory'),
    customerId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
  })
  .strict()
const memoryInputSchema = z.object({
  customerId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  throughCursor: z.number().int().nonnegative(),
  sourceChannelIds: z.array(z.string().uuid()),
  previousSummary: z.string().max(2000),
  messages: z
    .array(
      z.object({
        id: z.string().uuid(),
        text: z.string().max(16000),
        origin: z.string(),
        truncated: z.boolean(),
      }),
    )
    .min(1)
    .max(50),
}) satisfies z.ZodType<CustomerMemoryInput>

export async function processCustomerMemoryJob(
  env: Bindings,
  customerId: string,
  revision: number,
  withDb: <T>(env: Bindings, work: (db: Database) => Promise<T>) => Promise<T>,
) {
  const operation = await withDb(env, (db) => prepareCustomerMemoryUpdate(db, customerId, revision))
  if (!operation?.input || !operation.memberId) return
  try {
    const input = memoryInputSchema.parse(JSON.parse(operation.input))
    const llm = createAlibabaLlmProvider(
      {
        provider: env.LLM_PROVIDER,
        apiKey: env.AI_API_KEY,
        baseUrl: env.AI_BASE_URL,
        model: env.LLM_MODEL,
      },
      meteredAiFetch((work) => withDb(env, work), {
        id: operation.id,
        workspaceId: operation.workspaceId,
        memberId: operation.memberId,
        kind: 'CUSTOMER_MEMORY',
        text: operation.input,
        configVersionId: operation.configVersionId,
      }),
    )
    const decision = await llm.generateResponse({
      purpose: 'MEMORY',
      instructions: '',
      responseLanguage: 'English',
      history: [],
      knowledgeChunks: [],
      messages: [
        {
          id: operation.id,
          text: JSON.stringify({
            previousSummary: input.previousSummary,
            messages: input.messages,
          }),
        },
      ],
    })
    await withDb(env, (db) => completeCustomerMemoryUpdate(db, operation.id, decision.response))
  } catch (error) {
    if (error instanceof AiUsageError && error.code === 'OPERATION_PAUSED') return
    if (error instanceof AiUsageError && error.code === 'RETRY_LATER') throw error
    if (error instanceof AIProviderError && error.retryable) throw error
    await withDb(env, (db) =>
      finishAiOperation(db, {
        operationId: operation.id,
        state: 'FAILED',
        failureCode: 'MEMORY_GENERATION_FAILED',
      }),
    )
  }
}
