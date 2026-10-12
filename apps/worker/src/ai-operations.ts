import {
  type AiHandoffCondition,
  AiMemberError,
  type AiTestContext,
  AiUsageError,
  addAiFeedback,
  aiOperationForMessage,
  clearAiTestSession,
  createAiTest,
  createAiTestSession,
  type Database,
  deleteAiHandoffRule,
  finishAiOperation,
  getAiAnalytics,
  getAiBudget,
  getAiDiagnostics,
  KnowledgeError,
  listAiConfigVersions,
  listAiDiagnostics,
  listAiHandoffRules,
  matchesAiCondition,
  readAiTestSession,
  recordAiTestResult,
  restoreAiConfigVersion,
  saveAiBudget,
  saveAiHandoffRule,
} from '@deepsales/db'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  AIOutputError,
  aiHandoffConditionSchema,
  aiMemberRuntimeSnapshotSchema,
  applyHandoffPolicy,
  createAlibabaEmbeddingProvider,
  createAlibabaLlmProvider,
  enforceGrounding,
  matchedHandoffRuleId,
} from './ai'
import { meteredAiFetch } from './ai-usage'
import { createAuth } from './auth'
import type { Bindings } from './bindings'
import { retrieveKnowledgeChunks } from './knowledge'

export function aiOperationsRoutes(
  withDb: <T>(env: Bindings, work: (db: Database) => Promise<T>) => Promise<T>,
) {
  const routes = new Hono<{ Bindings: Bindings }>()
  const uuid = z.string().uuid()
  routes.all('/api/workspaces/:workspaceId/ai-operations/*', async (c) => {
    if (!c.env.HYPERDRIVE || !c.env.BETTER_AUTH_SECRET)
      return c.json({ error: { code: 'NOT_READY' } }, 503)
    return withDb(c.env, async (db) => {
      const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
      if (!session) return c.json({ error: { code: 'UNAUTHORIZED' } }, 401)
      const workspaceId = c.req.param('workspaceId')
      if (!uuid.safeParse(workspaceId).success)
        return c.json({ error: { code: 'INVALID_REQUEST' } }, 400)
      const identity = { workspaceId, actingUserId: session.user.id }
      const segments = c.req.path.split('/ai-operations/')[1]?.split('/') ?? []
      const [resource, action] = segments
      const body = ['POST', 'PATCH', 'DELETE'].includes(c.req.method)
        ? await c.req.json().catch(() => null)
        : null
      try {
        if (resource === 'budget' && c.req.method === 'GET')
          return c.json(await getAiBudget(db, identity))
        if (resource === 'budget' && c.req.method === 'PATCH') {
          const input = z
            .object({ monthlyLimit: z.number().int().min(0).max(2_000_000_000).nullable() })
            .strict()
            .parse(body)
          return c.json(await saveAiBudget(db, { ...identity, ...input }))
        }
        if (resource === 'analytics' && c.req.method === 'GET') {
          const query = z
            .object({
              from: z.string().datetime(),
              to: z.string().datetime(),
              timezone: z.string().max(100),
              memberId: uuid.optional(),
              versionId: uuid.optional(),
            })
            .parse(c.req.query())
          return c.json(
            await getAiAnalytics(db, {
              ...identity,
              ...query,
              from: new Date(query.from),
              to: new Date(query.to),
            }),
          )
        }
        if (resource === 'message' && uuid.safeParse(action).success && c.req.method === 'GET')
          return c.json(
            await aiOperationForMessage(db, { ...identity, messageId: uuid.parse(action) }),
          )
        if (!uuid.safeParse(resource).success) return c.json({ error: { code: 'NOT_FOUND' } }, 404)
        const memberInput = { ...identity, memberId: uuid.parse(resource) }
        if (action === 'sessions') {
          const sessionId = segments[2]
          if (c.req.method === 'POST' && !sessionId) {
            const input = z
              .object({
                id: uuid,
                source: z.enum(['DRAFT', 'PUBLISHED', 'VERSION']),
                versionId: uuid.optional(),
                customer: z
                  .object({
                    properties: z
                      .array(
                        z
                          .object({
                            definitionId: uuid,
                            value: z.union([z.string().max(2000), z.number().finite()]),
                          })
                          .strict(),
                      )
                      .max(20),
                    tags: z.array(uuid).max(20),
                    source: z.string().max(1000),
                    language: z.string().max(100),
                    memory: z.string().max(1000),
                  })
                  .strict(),
              })
              .strict()
              .parse(body)
            return c.json(
              { session: await createAiTestSession(db, { ...memberInput, ...input }) },
              201,
            )
          }
          const sessionInput = { ...memberInput, sessionId: uuid.parse(sessionId) }
          if (c.req.method === 'GET') return c.json(await readAiTestSession(db, sessionInput))
          if (c.req.method === 'POST' && segments[3] === 'clear') {
            const input = z.object({ generation: z.number().int().positive() }).strict().parse(body)
            return c.json(await clearAiTestSession(db, { ...sessionInput, ...input }))
          }
        }
        if (action === 'handoff-rules') {
          if (c.req.method === 'GET')
            return c.json({ rules: await listAiHandoffRules(db, memberInput) })
          if (c.req.method === 'DELETE') {
            const input = z.object({ revision: z.number().int().positive() }).strict().parse(body)
            await deleteAiHandoffRule(db, { ...memberInput, id: uuid.parse(segments[2]), ...input })
            return c.json({ ok: true })
          }
          if (c.req.method === 'POST' || c.req.method === 'PATCH') {
            const input = z
              .object({
                name: z.string().trim().min(1).max(100),
                enabled: z.boolean(),
                condition: aiHandoffConditionSchema,
                revision: z.number().int().positive().optional(),
              })
              .strict()
              .parse(body)
            return c.json(
              {
                rule: await saveAiHandoffRule(db, {
                  ...memberInput,
                  ...input,
                  id: c.req.method === 'PATCH' ? uuid.parse(segments[2]) : undefined,
                }),
              },
              c.req.method === 'POST' ? 201 : 200,
            )
          }
        }
        if (action === 'versions' && c.req.method === 'GET')
          return c.json({ versions: await listAiConfigVersions(db, memberInput) })
        if (action === 'restore' && c.req.method === 'POST') {
          const input = z.object({ versionId: uuid }).strict().parse(body)
          return c.json({ config: await restoreAiConfigVersion(db, { ...memberInput, ...input }) })
        }
        if (action === 'runs' && c.req.method === 'GET') {
          const rawCursor = c.req.query('cursor')
          let value: unknown
          try {
            value = rawCursor ? JSON.parse(rawCursor) : undefined
          } catch {
            throw new AiMemberError('INVALID_REQUEST')
          }
          const cursor = z
            .object({ createdAt: z.string().datetime(), id: uuid })
            .strict()
            .optional()
            .parse(value)
          return c.json(
            await listAiDiagnostics(db, {
              ...memberInput,
              cursor,
            }),
          )
        }
        if (action === 'diagnostics' && c.req.method === 'GET')
          return c.json(await getAiDiagnostics(db, { ...identity, id: uuid.parse(resource) }))
        if (action === 'feedback' && c.req.method === 'POST') {
          const input = z
            .object({
              category: z.enum(['KNOWLEDGE', 'MODEL', 'OTHER']),
              note: z.string().max(2_000),
            })
            .strict()
            .parse(body)
          return c.json(
            await addAiFeedback(db, { ...identity, id: uuid.parse(resource), ...input }),
          )
        }
        if (action === 'test' && c.req.method === 'POST') {
          const limit = await c.env.AUTH_RATE_LIMITER.limit({ key: `ai-test:${session.user.id}` })
          if (!limit.success) return c.json({ error: { code: 'RATE_LIMITED' } }, 429)
          const input = z
            .object({
              id: uuid,
              source: z.enum(['DRAFT', 'PUBLISHED', 'VERSION']),
              versionId: uuid.optional(),
              text: z.string().min(1).max(8_000),
              sessionId: uuid.optional(),
              generation: z.number().int().positive().optional(),
              simulatedHandoffFacts: z
                .object({
                  properties: z
                    .array(
                      z
                        .object({
                          definitionId: uuid,
                          value: z.union([z.string().max(2000), z.number().finite()]),
                        })
                        .strict(),
                    )
                    .max(20),
                  tags: z.array(uuid).max(20),
                })
                .strict()
                .optional(),
            })
            .strict()
            .parse(body)
          const test = await createAiTest(db, { ...memberInput, ...input })
          if (!test.created)
            return c.json(await getAiDiagnostics(db, { ...identity, id: test.operation.id }))
          try {
            const snapshot = aiMemberRuntimeSnapshotSchema.parse(test.operation.snapshot)
            const testContext = (test.operation.output as { testContext?: AiTestContext } | null)
              ?.testContext
            const history = (testContext?.history ?? []).map((item) => ({
              ...item,
              createdAt: new Date(item.createdAt),
            }))
            const context = (
              test.operation.output as {
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
              await recordAiTestResult(db, {
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
              return c.json(await getAiDiagnostics(db, { ...identity, id: test.operation.id }))
            }
            const fetcher = meteredAiFetch((work) => withDb(c.env, work), {
              id: input.id,
              workspaceId,
              memberId: uuid.parse(resource),
              kind: 'TEST',
              configVersionId: test.operation.configVersionId,
            })
            const embedding = createAlibabaEmbeddingProvider(
              {
                provider: c.env.EMBEDDING_PROVIDER,
                apiKey: c.env.AI_API_KEY,
                baseUrl: c.env.AI_BASE_URL,
                model: c.env.EMBEDDING_MODEL,
                dimensions: c.env.EMBEDDING_DIMENSIONS,
              },
              fetcher,
            )
            const semanticRules = context.rules.flatMap((r) =>
              r.condition.kind === 'SEMANTIC' ? [{ id: r.id, text: r.condition.text }] : [],
            )
            if (semanticRules.length) {
              const classifier = createAlibabaLlmProvider(
                {
                  provider: c.env.LLM_PROVIDER,
                  apiKey: c.env.AI_API_KEY,
                  baseUrl: c.env.AI_BASE_URL,
                  model: c.env.LLM_MODEL,
                },
                meteredAiFetch(
                  (work) => withDb(c.env, work),
                  {
                    id: input.id,
                    workspaceId,
                    memberId: uuid.parse(resource),
                    kind: 'TEST',
                    configVersionId: test.operation.configVersionId,
                  },
                  'CUSTOM_HANDOFF:TEST',
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
                await recordAiTestResult(db, {
                  id: input.id,
                  chunkIds: [],
                  output: {
                    kind: 'HANDOFF',
                    decision: { ...decision, response: '模拟转人工；不会分配或发送。' },
                    handoffContext: context,
                  },
                })
                return c.json(await getAiDiagnostics(db, { ...identity, id: test.operation.id }))
              }
            }
            let chunks: Awaited<ReturnType<typeof retrieveKnowledgeChunks>> = []
            try {
              chunks = await retrieveKnowledgeChunks(db, embedding, c.env, {
                workspaceId,
                knowledgeBaseId: snapshot.knowledgeBaseId,
                query: input.text,
              })
            } catch (error) {
              if (
                !(
                  error instanceof KnowledgeError &&
                  ['NOT_FOUND', 'INVALID_REQUEST'].includes(error.code)
                )
              )
                throw error
            }
            const llm = createAlibabaLlmProvider(
              {
                provider: c.env.LLM_PROVIDER,
                apiKey: c.env.AI_API_KEY,
                baseUrl: c.env.AI_BASE_URL,
                model: c.env.LLM_MODEL,
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
            await recordAiTestResult(db, {
              id: input.id,
              output: { ...result, handoffContext: context },
              chunkIds: chunks.map(({ id }) => id),
            })
          } catch (error) {
            await finishAiOperation(db, {
              operationId: input.id,
              state: 'FAILED',
              failureCode:
                error instanceof AiUsageError
                  ? error.code
                  : error instanceof AiMemberError
                    ? error.code
                    : error instanceof KnowledgeError
                      ? 'KNOWLEDGE_UNAVAILABLE'
                      : error instanceof AIOutputError
                        ? 'INVALID_OUTPUT'
                        : 'AI_PROVIDER_ERROR',
            })
          }
          return c.json(await getAiDiagnostics(db, { ...identity, id: input.id }))
        }
        return c.json({ error: { code: 'NOT_FOUND' } }, 404)
      } catch (error) {
        if (error instanceof AiUsageError) return c.json({ error: { code: error.code } }, 409)
        if (error instanceof z.ZodError) return c.json({ error: { code: 'INVALID_REQUEST' } }, 400)
        if (error instanceof AiMemberError)
          return c.json(
            { error: { code: error.code } },
            error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : 400,
          )
        throw error
      }
    })
  })
  return routes
}
