import {
  type AiHandoffCondition,
  type AiTestContext,
  type aiOperation,
  type Database,
  KnowledgeError,
  matchesAiCondition,
  type recordAiTestResult,
} from '@deepsales/db'
import {
  aiMemberRuntimeSnapshotSchema,
  applyHandoffPolicy,
  createAlibabaEmbeddingProvider,
  createAlibabaLlmProvider,
  enforceGrounding,
  matchedHandoffRuleId,
} from './ai'
import { meteredAiFetch } from './ai-usage'
import type { Bindings } from './bindings'
import { retrieveKnowledgeChunks } from './knowledge'

export async function executeAiTest(
  db: Database,
  env: Bindings,
  withDb: <T>(env: Bindings, work: (db: Database) => Promise<T>) => Promise<T>,
  operation: typeof aiOperation.$inferSelect,
  saveResult: (result: Parameters<typeof recordAiTestResult>[1]) => Promise<void>,
  stage: string = 'LLM',
) {
  const input = { id: operation.id, text: operation.input ?? '' }
  const workspaceId = operation.workspaceId
  const snapshot = aiMemberRuntimeSnapshotSchema.parse(operation.snapshot)
  const testContext = (operation.output as { testContext?: AiTestContext } | null)?.testContext
  const propertyRules =
    (
      operation.output as {
        propertyRules?: import('@deepsales/db').AiPropertyCollection['rules']
      } | null
    )?.propertyRules ?? []
  const history = (testContext?.history ?? []).map((item) => ({
    ...item,
    createdAt: new Date(item.createdAt),
  }))
  const context = (
    operation.output as {
      handoffContext: {
        rules: { id: string; revision: number; condition: AiHandoffCondition }[]
        facts: {
          properties: { definitionId: string; value: string | number }[]
          tags: string[]
        }
      }
    }
  ).handoffContext
  const facts = {
    properties: context.facts.properties.map((p) => ({
      id: p.definitionId,
      value: p.value,
    })),
    tags: context.facts.tags.map((id) => ({ id })),
    replies: 0,
  }
  const deterministic = context.rules.find(
    (r) => r.condition.kind !== 'SEMANTIC' && matchesAiCondition(r.condition, facts),
  )
  if (deterministic) {
    await saveResult({
      id: input.id,
      chunkIds: [],
      output: {
        kind: 'HANDOFF',
        decision: {
          decision: 'HANDOFF',
          handoffReason: 'KEYWORD',
          handoffRuleId: deterministic.id,
          response: '模拟转人工；不会分配或发送。',
        },
        handoffContext: context,
      },
    })
    return
  }
  const fetcher = meteredAiFetch(
    (work) => withDb(env, work),
    {
      id: input.id,
      workspaceId,
      memberId: operation.memberId ?? undefined,
      kind: 'TEST',
      configVersionId: operation.configVersionId,
    },
    stage,
  )
  const embedding = createAlibabaEmbeddingProvider(
    {
      provider: env.EMBEDDING_PROVIDER,
      apiKey: env.AI_API_KEY,
      baseUrl: env.AI_BASE_URL,
      model: env.EMBEDDING_MODEL,
      dimensions: env.EMBEDDING_DIMENSIONS,
    },
    fetcher,
  )
  const semanticRules = context.rules.flatMap((r) =>
    r.condition.kind === 'SEMANTIC' ? [{ id: r.id, text: r.condition.text }] : [],
  )
  if (semanticRules.length) {
    const classifier = createAlibabaLlmProvider(
      {
        provider: env.LLM_PROVIDER,
        apiKey: env.AI_API_KEY,
        baseUrl: env.AI_BASE_URL,
        model: env.LLM_MODEL,
      },
      meteredAiFetch(
        (work) => withDb(env, work),
        {
          id: input.id,
          workspaceId,
          memberId: operation.memberId ?? undefined,
          kind: 'TEST',
          configVersionId: operation.configVersionId,
        },
        `CUSTOM_HANDOFF:${stage}`,
      ),
    )
    const decision = await classifier.generateResponse({
      instructions:
        'Only classify the listed handoff conditions. If none matches return ANSWER with response "No condition matched.". Do not answer questions or hand off for other reasons.',
      responseLanguage: snapshot.responseLanguage,
      timeZone: snapshot.timeZone,
      messages: [{ id: input.id, text: input.text }],
      history,
      simulatedCustomer: testContext?.customer,
      knowledgeChunks: [],
      handoffRules: semanticRules,
    })
    if (matchedHandoffRuleId(decision, semanticRules)) {
      await saveResult({
        id: input.id,
        chunkIds: [],
        output: {
          kind: 'HANDOFF',
          decision: { ...decision, response: '模拟转人工；不会分配或发送。' },
          handoffContext: context,
        },
      })
      return
    }
  }
  let chunks: Awaited<ReturnType<typeof retrieveKnowledgeChunks>> = []
  try {
    chunks = await retrieveKnowledgeChunks(db, embedding, env, {
      workspaceId,
      knowledgeBaseId: snapshot.knowledgeBaseId,
      query: input.text,
    })
  } catch (error) {
    if (!(error instanceof KnowledgeError && ['NOT_FOUND', 'INVALID_REQUEST'].includes(error.code)))
      throw error
  }
  const llm = createAlibabaLlmProvider(
    {
      provider: env.LLM_PROVIDER,
      apiKey: env.AI_API_KEY,
      baseUrl: env.AI_BASE_URL,
      model: env.LLM_MODEL,
    },
    fetcher,
  )
  const decision = await llm.generateResponse({
    automaticLanguageEnabled: snapshot.automaticLanguageEnabled,
    timeZone: snapshot.timeZone,
    naturalToneEnabled: snapshot.naturalToneEnabled,
    instructions: snapshot.instructions,
    responseLanguage: snapshot.responseLanguage,
    messages: [{ id: input.id, text: input.text }],
    history,
    simulatedCustomer: testContext?.customer,
    propertyRules,
    tagRules:
      (operation.output as { tagRules?: import('@deepsales/db').AiTagCollection['rules'] } | null)
        ?.tagRules ?? [],
    establishedLanguage: snapshot.automaticLanguageEnabled
      ? testContext?.customer.language || undefined
      : undefined,
    knowledgeChunks: chunks,
  })
  const replyConfig = {
    ...snapshot,
    responseLanguage: snapshot.automaticLanguageEnabled
      ? (decision.languageSelection?.language ?? snapshot.responseLanguage)
      : snapshot.responseLanguage,
  }
  const result = applyHandoffPolicy(
    enforceGrounding(
      decision,
      chunks.map(({ id }) => id),
      replyConfig,
      chunks,
    ).decision,
    replyConfig,
  )
  await saveResult({
    id: input.id,
    output: { ...result, handoffContext: context },
    chunkIds: chunks.map(({ id }) => id),
  })
}
