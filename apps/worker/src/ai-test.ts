import {
  aiSelectedSkillInstructions,
  recordAiSkillSelection,
  type AiHandoffCondition,
  type AiTestContext,
  AiUsageError,
  type aiOperation,
  claimAiTestSearchAction,
  type Database,
  finishAiTestSearchAction,
  KnowledgeError,
  matchesAiCondition,
  type recordAiTestResult,
} from '@deepsales/db'
import {
  AIOutputError,
  type AiResponseInput,
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
  actingUserId: string,
  stage: string = 'LLM',
) {
  const input = { id: operation.id, text: operation.input ?? '' }
  const workspaceId = operation.workspaceId
  const snapshot = aiMemberRuntimeSnapshotSchema.parse(operation.snapshot)
  const testContext = (operation.output as { testContext?: AiTestContext } | null)?.testContext
  const variableInput = (
    operation.output as { variableInput?: import('@deepsales/db').AiVariableInput } | null
  )?.variableInput
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
  let responseInstructions = snapshot.instructions
  if (snapshot.skills.length) {
    const matcher = createAlibabaLlmProvider(
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
        `SKILL_MATCH:${stage}`,
      ),
    )
    const match = await matcher.generateResponse({
      instructions: '',
      toolsDisabled: true,
      responseLanguage: snapshot.responseLanguage,
      timeZone: snapshot.timeZone,
      variableInput,
      skillConditions: snapshot.skills.map(({ id, condition }) => ({ id, condition })),
      messages: [{ id: input.id, text: input.text }],
      history,
      knowledgeChunks: [],
      simulatedCustomer: testContext?.customer,
    })
    const selected = await withDb(env, (database) =>
      recordAiSkillSelection(database, {
        workspaceId,
        memberId: operation.memberId as string,
        operationId: operation.id,
        actingUserId,
        matchedSkillIds: match.matchedSkillIds ?? [],
      }),
    )
    if (selected.kind === 'BLOCKED') return
    responseInstructions = aiSelectedSkillInstructions(snapshot, selected.selection.id)
  }
  let chunks: AiResponseInput['knowledgeChunks'] = []
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
  const responseInput: AiResponseInput = {
    automaticLanguageEnabled: snapshot.automaticLanguageEnabled,
    timeZone: snapshot.timeZone,
    naturalToneEnabled: snapshot.naturalToneEnabled,
    instructions: responseInstructions,
    responseLanguage: snapshot.responseLanguage,
    messages: [{ id: input.id, text: input.text }],
    history,
    simulatedCustomer: testContext?.customer,
    propertyRules,
    variableInput,
    now: variableInput ? new Date(variableInput.capturedAt) : operation.createdAt,
    tagRules:
      (operation.output as { tagRules?: import('@deepsales/db').AiTagCollection['rules'] } | null)
        ?.tagRules ?? [],
    establishedLanguage: snapshot.automaticLanguageEnabled
      ? testContext?.customer.language || undefined
      : undefined,
    knowledgeChunks: chunks,
  }
  let decision = await llm.generateResponse(responseInput)
  const replyConfig = {
    ...snapshot,
    responseLanguage: snapshot.automaticLanguageEnabled
      ? (decision.languageSelection?.language ?? snapshot.responseLanguage)
      : snapshot.responseLanguage,
  }
  const mediaCall = decision.toolCalls?.find((call) => call.tool === 'send_media')
  if (mediaCall && decision.mediaAssetId && decision.mediaAssetId !== mediaCall.arguments.assetId)
    throw new AIOutputError()
  let result = applyHandoffPolicy(
    enforceGrounding(
      mediaCall ? { ...decision, mediaAssetId: mediaCall.arguments.assetId } : decision,
      chunks.map(({ id }) => id),
      replyConfig,
      chunks,
    ).decision,
    replyConfig,
  )
  const calls = 'toolCalls' in result.decision ? (result.decision.toolCalls ?? []) : []
  const terminal = calls.at(-1)?.tool
  const actions: NonNullable<Parameters<typeof recordAiTestResult>[1]['actions']> = []
  const searches: {
    ordinal: number
    call: Extract<NonNullable<typeof decision.toolCalls>[number], { tool: 'search' }>
    chunks: AiResponseInput['knowledgeChunks']
  }[] = []
  for (const [ordinal, call] of calls.entries()) {
    if (call.tool !== 'search') {
      actions.push({ call })
      continue
    }
    if (!operation.memberId) throw new AIOutputError()
    const actionInput = {
      workspaceId,
      memberId: operation.memberId,
      actingUserId,
      id: operation.id,
      ordinal,
      call,
    }
    const claimed = await claimAiTestSearchAction(db, actionInput)
    if (!claimed) return
    const toolFetch = meteredAiFetch(
      (work) => withDb(env, work),
      {
        id: operation.id,
        workspaceId,
        memberId: operation.memberId ?? undefined,
        kind: 'TEST',
        configVersionId: operation.configVersionId,
      },
      `${stage}:TOOL:${ordinal}`,
    )
    const provider = createAlibabaEmbeddingProvider(
      {
        provider: env.EMBEDDING_PROVIDER,
        apiKey: env.AI_API_KEY,
        baseUrl: env.AI_BASE_URL,
        model: env.EMBEDDING_MODEL,
        dimensions: env.EMBEDDING_DIMENSIONS,
      },
      toolFetch,
    )
    let found = claimed.chunks
    try {
      if (!found) {
        const retrieved = await retrieveKnowledgeChunks(db, provider, env, {
          workspaceId,
          knowledgeBaseId: snapshot.knowledgeBaseId,
          query: call.arguments.query,
        })
        found = await finishAiTestSearchAction(db, {
          ...actionInput,
          chunkIds: retrieved.map((chunk) => chunk.id),
        })
      }
    } catch (error) {
      await finishAiTestSearchAction(db, {
        ...actionInput,
        failure:
          error instanceof AiUsageError && error.code === 'OPERATION_PAUSED' ? 'UNKNOWN' : 'FAILED',
      })
      throw error
    }
    if (!found) return
    searches.push({ ordinal, call, chunks: found })
    actions.push({ call, chunkIds: found.map((chunk) => chunk.id) })
    chunks = [
      ...found,
      ...chunks.filter((chunk) => !found.some((result) => result.id === chunk.id)),
    ].slice(0, 6)
  }
  if (
    calls.some((call) => call.tool === 'search') &&
    !['skip', 'handoff', 'send_media'].includes(terminal ?? '')
  ) {
    const finalFetch = meteredAiFetch(
      (work) => withDb(env, work),
      {
        id: operation.id,
        workspaceId,
        memberId: operation.memberId ?? undefined,
        kind: 'TEST',
        configVersionId: operation.configVersionId,
      },
      `${stage}:TOOLS_REPLY`,
    )
    decision = await createAlibabaLlmProvider(
      {
        provider: env.LLM_PROVIDER,
        apiKey: env.AI_API_KEY,
        baseUrl: env.AI_BASE_URL,
        model: env.LLM_MODEL,
      },
      finalFetch,
    ).generateResponse({
      ...responseInput,
      knowledgeChunks: chunks,
      toolsDisabled: true,
      toolResults: calls.map((call) => ({ tool: call.tool, state: 'SUCCEEDED' })),
    })
    for (const search of searches) {
      if (!operation.memberId) throw new AIOutputError()
      const current = await finishAiTestSearchAction(db, {
        workspaceId,
        memberId: operation.memberId,
        actingUserId,
        id: operation.id,
        ordinal: search.ordinal,
        call: search.call,
      })
      if (!current) return
      if (JSON.stringify(current) !== JSON.stringify(search.chunks)) throw new AIOutputError()
    }
    result = applyHandoffPolicy(
      enforceGrounding(
        decision,
        chunks.map((chunk) => chunk.id),
        replyConfig,
        chunks,
      ).decision,
      replyConfig,
    )
  }
  if (terminal === 'handoff')
    result = {
      kind: 'HANDOFF',
      decision: {
        ...decision,
        decision: 'HANDOFF',
        handoffReason: 'UNABLE_TO_ANSWER',
        response: '模拟转人工；不会分配或发送。',
      },
    }
  await saveResult({
    id: input.id,
    output: {
      ...result,
      ...(terminal === 'skip' ? { kind: 'SKIPPED' } : {}),
      handoffContext: context,
    },
    actions,
    chunkIds: chunks.map(({ id }) => id),
  })
}
