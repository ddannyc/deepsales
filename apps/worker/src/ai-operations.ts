import {
  AiMemberError,
  AiUsageError,
  addAiFeedback,
  aiOperationForMessage,
  createAiTest,
  finishAiOperation,
  getAiAnalytics,
  getAiBudget,
  getAiDiagnostics,
  listAiConfigVersions,
  listAiDiagnostics,
  recordAiTestResult,
  restoreAiConfigVersion,
  saveAiBudget,
  type Database,
  KnowledgeError,
} from '@deepsales/db'
import { Hono } from 'hono'
import { z } from 'zod'
import { createAuth } from './auth'
import {
  aiMemberRuntimeSnapshotSchema,
  AIOutputError,
  createAlibabaEmbeddingProvider,
  createAlibabaLlmProvider,
  enforceGrounding,
  applyHandoffPolicy,
} from './ai'
import { meteredAiFetch } from './ai-usage'
import { retrieveKnowledgeChunks } from './knowledge'
import type { Bindings } from './bindings'

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
      const body = ['POST', 'PATCH'].includes(c.req.method)
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
            })
            .strict()
            .parse(body)
          const test = await createAiTest(db, { ...memberInput, ...input })
          if (!test.created)
            return c.json(await getAiDiagnostics(db, { ...identity, id: test.operation.id }))
          try {
            const snapshot = aiMemberRuntimeSnapshotSchema.parse(test.operation.snapshot)
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
              history: [],
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
              output: result,
              chunkIds: chunks.map(({ id }) => id),
            })
          } catch (error) {
            await finishAiOperation(db, {
              operationId: input.id,
              state: 'FAILED',
              failureCode:
                error instanceof AiUsageError
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
