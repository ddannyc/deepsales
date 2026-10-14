import {
  AI_VARIABLES,
  AiMemberError,
  AiUsageError,
  addAiFeedback,
  aiOperationForMessage,
  BUILTIN_AI_TOOLS,
  cancelAiTestBatch,
  claimAiTestBatchItem,
  clearAiTestSession,
  completePersonaOperation,
  createAiTest,
  createAiTestBatch,
  createAiTestSession,
  createPersonaOperation,
  type Database,
  deleteAiFollowUpRule,
  deleteAiHandoffRule,
  deleteAiPropertyRule,
  deleteAiQuestionSet,
  deleteAiTagRule,
  failAiBatchItem,
  finishAiOperation,
  getAiAnalytics,
  getAiBudget,
  getAiDiagnostics,
  getAiMemberConfig,
  getAiSetupStatus,
  KnowledgeError,
  listAiConfigVersions,
  listAiDiagnostics,
  listAiFollowUpRules,
  listAiHandoffRules,
  listAiPropertyRules,
  listAiQuestionSets,
  listAiTagRules,
  listAiTestBatches,
  previewAiFollowUpAudience,
  readAiTestBatch,
  readAiTestSession,
  recordAiBatchResult,
  recordAiTestResult,
  restoreAiConfigVersion,
  saveAiBudget,
  saveAiFollowUpRule,
  saveAiHandoffRule,
  saveAiPropertyRule,
  saveAiQuestionSet,
  saveAiTagRule,
} from '@deepsales/db'
import { Hono } from 'hono'
import { externalToolRoute } from './external-tool-routes'
import { ExternalToolError } from './external-tools'
import { readAiExternalCatalog } from '@deepsales/db'
import { z } from 'zod'
import {
  AI_PERSONA_SAFETY_SUFFIX,
  AIOutputError,
  AIProviderError,
  aiHandoffConditionSchema,
  aiStopRulesSchema,
  createAlibabaLlmProvider,
  isLlmProviderConfigurationUsable,
} from './ai'
import { executeAiTest } from './ai-test'
import { meteredAiFetch } from './ai-usage'
import { createAuth } from './auth'
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
        const external = await externalToolRoute(c, db, memberInput, action, segments, body)
        if (external) return external
        if (action === 'variables' && c.req.method === 'GET') {
          await getAiMemberConfig(db, memberInput)
          return c.json({
            variables: AI_VARIABLES,
            tools: [
              ...BUILTIN_AI_TOOLS,
              ...(await readAiExternalCatalog(db, memberInput)).map((row) => ({
                id: `external:${row.tool.id}`,
                label: row.tool.name,
                description: row.tool.description,
              })),
            ],
            positions: ['instructions'],
            missing: null,
          })
        }
        if (action === 'property-rules') {
          if (c.req.method === 'GET')
            return c.json({ rules: await listAiPropertyRules(db, memberInput) })
          if (c.req.method === 'DELETE') {
            const input = z
              .object({ id: uuid, revision: z.number().int().positive() })
              .strict()
              .parse(body)
            await deleteAiPropertyRule(db, { ...memberInput, ...input })
            return c.json({ ok: true })
          }
          if (c.req.method === 'POST') {
            const input = z
              .object({
                id: uuid,
                definitionId: uuid,
                instructions: z.string().trim().min(1).max(2000),
                enabled: z.boolean(),
                revision: z.number().int().positive().optional(),
              })
              .strict()
              .parse(body)
            return c.json({ rule: await saveAiPropertyRule(db, { ...memberInput, ...input }) }, 201)
          }
        }
        if (action === 'follow-ups') {
          if (segments[2] === 'preview' && c.req.method === 'POST') {
            const input = z.object({ groups: aiStopRulesSchema.shape.groups }).strict().parse(body)
            return c.json(await previewAiFollowUpAudience(db, { ...memberInput, ...input }))
          }

          if (c.req.method === 'GET') return c.json(await listAiFollowUpRules(db, memberInput))
          if (c.req.method === 'DELETE') {
            const input = z
              .object({ id: uuid, revision: z.number().int().positive() })
              .strict()
              .parse(body)
            await deleteAiFollowUpRule(db, { ...memberInput, ...input })
            return c.json({ ok: true })
          }
          if (c.req.method === 'POST') {
            const input = z
              .object({
                id: uuid,
                revision: z.number().int().positive().optional(),
                name: z.string().trim().min(1).max(100),
                enabled: z.boolean(),
                timer: z.enum(['LAST_AI_REPLY', 'AI_ASSIGNMENT']),
                delaySeconds: z.number().int().min(1).max(2592000),
                instructions: z.string().max(4000),
                groups: aiStopRulesSchema.shape.groups,
              })
              .strict()
              .parse(body)
            return c.json({ rule: await saveAiFollowUpRule(db, { ...memberInput, ...input }) }, 201)
          }
        }
        if (action === 'tag-rules') {
          if (c.req.method === 'GET')
            return c.json({ rules: await listAiTagRules(db, memberInput) })
          if (c.req.method === 'DELETE') {
            const input = z
              .object({ id: uuid, revision: z.number().int().positive() })
              .strict()
              .parse(body)
            await deleteAiTagRule(db, { ...memberInput, ...input })
            return c.json({ ok: true })
          }
          if (c.req.method === 'POST') {
            const input = z
              .object({
                id: uuid,
                definitionId: uuid,
                instructions: z.string().trim().min(1).max(2000),
                enabled: z.boolean(),
                revision: z.number().int().positive().optional(),
              })
              .strict()
              .parse(body)
            return c.json({ rule: await saveAiTagRule(db, { ...memberInput, ...input }) }, 201)
          }
        }
        if (action === 'question-sets') {
          if (c.req.method === 'GET')
            return c.json({ sets: await listAiQuestionSets(db, memberInput) })
          if (c.req.method === 'DELETE') {
            const input = z
              .object({ id: uuid, revision: z.number().int().positive() })
              .strict()
              .parse(body)
            await deleteAiQuestionSet(db, { ...memberInput, ...input })
            return c.json({ ok: true })
          }
          if (c.req.method === 'POST') {
            const input = z
              .object({
                id: uuid,
                name: z.string().trim().min(1).max(100),
                questions: z.array(z.string().trim().min(1).max(8000)).min(1).max(100),
                revision: z.number().int().positive().optional(),
              })
              .strict()
              .parse(body)
            return c.json({ set: await saveAiQuestionSet(db, { ...memberInput, ...input }) }, 201)
          }
        }
        if (action === 'batches') {
          if (c.req.method === 'POST' && segments[3] === 'cancel') {
            await cancelAiTestBatch(db, { ...memberInput, id: uuid.parse(segments[2]) })
            return c.json(
              await readAiTestBatch(db, { ...memberInput, id: uuid.parse(segments[2]) }),
            )
          }
          if (c.req.method === 'POST' && segments[3] === 'execute') {
            const limit = await c.env.AUTH_RATE_LIMITER.limit({ key: `ai-test:${session.user.id}` })
            if (!limit.success) return c.json({ error: { code: 'RATE_LIMITED' } }, 429)
            const input = z
              .object({ itemId: uuid, attempt: z.number().int().min(0).max(3) })
              .strict()
              .parse(body)
            const batchInput = { ...memberInput, id: uuid.parse(segments[2]), ...input }
            let attempt = input.attempt
            let started = false
            try {
              const claimed = await claimAiTestBatchItem(db, batchInput)
              if (claimed) {
                started = true
                attempt = claimed.attempt
                await executeAiTest(
                  db,
                  c.env,
                  withDb,
                  claimed.operation,
                  (result) => recordAiBatchResult(db, { ...batchInput, attempt }, result),
                  session.user.id,
                  `BATCH:${attempt}`,
                )
              }
            } catch (error) {
              if (!started && !(error instanceof AiUsageError && error.code === 'QUOTA_EXHAUSTED'))
                throw error
              const code =
                error instanceof AiUsageError || error instanceof AiMemberError
                  ? error.code
                  : error instanceof AIOutputError
                    ? 'INVALID_OUTPUT'
                    : 'AI_PROVIDER_ERROR'
              if (started)
                await finishAiOperation(db, {
                  operationId: input.itemId,
                  state: 'FAILED',
                  failureCode: code,
                })
              await failAiBatchItem(db, { ...batchInput, attempt, code })
              if (error instanceof AiMemberError && ['FORBIDDEN', 'NOT_FOUND'].includes(error.code))
                throw error
            }
            return c.json(await readAiTestBatch(db, batchInput))
          }
          if (c.req.method === 'GET')
            return c.json(
              segments[2]
                ? await readAiTestBatch(db, { ...memberInput, id: uuid.parse(segments[2]) })
                : { batches: await listAiTestBatches(db, memberInput) },
            )
          if (c.req.method === 'POST' && !segments[2]) {
            const input = z
              .object({
                id: uuid,
                questionSetId: uuid,
                source: z.enum(['DRAFT', 'PUBLISHED', 'VERSION']),
                versionId: uuid.optional(),
              })
              .strict()
              .parse(body)
            return c.json({ batch: await createAiTestBatch(db, { ...memberInput, ...input }) }, 201)
          }
        }
        if (action === 'setup' && c.req.method === 'GET')
          return c.json({
            ...(await getAiSetupStatus(db, memberInput)),
            providerReady: isLlmProviderConfigurationUsable({
              apiKey: c.env.AI_API_KEY,
              baseUrl: c.env.AI_BASE_URL,
              provider: c.env.LLM_PROVIDER,
              model: c.env.LLM_MODEL,
            }),
          })
        if (action === 'persona' && c.req.method === 'POST') {
          const limit = await c.env.AUTH_RATE_LIMITER.limit({
            key: `ai-persona:${session.user.id}`,
          })
          if (!limit.success) return c.json({ error: { code: 'RATE_LIMITED' } }, 429)
          const input = z
            .object({
              id: uuid,
              mode: z.enum(['GENERATE', 'OPTIMIZE']),
              brief: z.string().trim().min(1).max(2000),
              sourceInstructions: z.string().max(20000),
            })
            .strict()
            .parse(body)
          const operation = await createPersonaOperation(db, { ...memberInput, ...input })
          if (operation.state === 'COMPLETED')
            return c.json({
              candidate: {
                id: operation.id,
                sourceInstructions: input.sourceInstructions,
                instructions: (operation.output as { instructions: string }).instructions,
              },
            })
          if (operation.state === 'FAILED' || operation.state === 'CANCELLED')
            return c.json({ error: { code: 'PERSONA_UNAVAILABLE' } }, 502)
          try {
            const llm = createAlibabaLlmProvider(
              {
                provider: c.env.LLM_PROVIDER,
                apiKey: c.env.AI_API_KEY,
                baseUrl: c.env.AI_BASE_URL,
                model: c.env.LLM_MODEL,
              },
              meteredAiFetch((work) => withDb(c.env, work), {
                id: operation.id,
                workspaceId,
                memberId: memberInput.memberId,
                kind: 'PERSONA',
                text: operation.input ?? undefined,
              }),
            )
            const decision = await llm.generateResponse({
              purpose: 'PERSONA',
              instructions: '',
              responseLanguage: 'Chinese',
              messages: [
                {
                  id: operation.id,
                  text: JSON.stringify({
                    mode: input.mode,
                    brief: input.brief,
                    sourceInstructions: input.sourceInstructions,
                  }),
                },
              ],
              history: [],
              knowledgeChunks: [],
            })
            if (
              decision.decision !== 'ANSWER' ||
              decision.containsBusinessFacts ||
              decision.usedChunkIds.length ||
              decision.mediaAssetId ||
              decision.handoffRuleId ||
              decision.languageSelection
            )
              throw new AIOutputError()
            const instructions = `${decision.response}${AI_PERSONA_SAFETY_SUFFIX}`
            return c.json({
              candidate: await completePersonaOperation(db, {
                ...memberInput,
                id: operation.id,
                instructions,
              }),
            })
          } catch (error) {
            if (error instanceof AiUsageError)
              return c.json({ error: { code: error.code, retryAfterMs: error.retryAfterMs } }, 409)
            if (!(error instanceof AIProviderError && error.retryable))
              await finishAiOperation(db, {
                operationId: operation.id,
                state: 'FAILED',
                failureCode: error instanceof AIOutputError ? 'INVALID_OUTPUT' : 'PERSONA_FAILED',
              })
            if (error instanceof AiMemberError) throw error
            return c.json({ error: { code: 'PERSONA_UNAVAILABLE' } }, 502)
          }
        }
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
            await executeAiTest(
              db,
              c.env,
              withDb,
              test.operation,
              (result) => recordAiTestResult(db, result),
              session.user.id,
            )
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
        if (error instanceof ExternalToolError) return c.json({ error: { code: error.code } }, 400)
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
