import {
  AiUsageError,
  type CampaignContent,
  changeCampaignState,
  type Database,
  dispatchCampaignMessages,
  dueCampaigns,
  finishAiOperation,
  InboxError,
  listCampaignAudience,
  listCampaigns,
  pendingCampaignTranslations,
  readCampaign,
  saveCampaign,
  startCampaignRun,
  stopCampaignRecipient,
  storeCampaignTranslation,
  TRANSLATION_LANGUAGES,
} from '@deepsales/db'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { AIOutputError, createAlibabaLlmProvider } from './ai'
import { meteredAiFetch } from './ai-usage'
import { createAuth } from './auth'
import type { Bindings } from './bindings'
import { nextCampaignOccurrence, resolveCampaignTime } from './campaign-schedule'

type WithDb = <T>(env: Bindings, work: (db: Database) => Promise<T>) => Promise<T>
const uuid = z.string().uuid()
const content = z
  .array(
    z
      .object({
        id: uuid,
        text: z.string().trim().min(1).max(2000).optional(),
        assetId: uuid.optional(),
      })
      .strict()
      .refine((b) => Boolean(b.text) !== Boolean(b.assetId)),
  )
  .min(1)
  .max(20)
  .refine((blocks) => new Set(blocks.map((b) => b.id)).size === blocks.length)
const calendar = z
  .object({
    localTime: z.string().max(16),
    timeZone: z.string().max(100),
    repeat: z.enum(['NONE', 'DAILY', 'WEEKLY']),
    until: z.string().datetime().optional(),
    maxRuns: z.number().int().min(1).max(1000).optional(),
  })
  .strict()
const inputSchema = z
  .object({
    id: uuid,
    name: z.string().trim().min(1).max(100),
    channelId: uuid,
    identityIds: z.array(uuid).min(1).max(1000),
    content: content.optional(),
    text: z.string().trim().min(1).max(2000).optional(),
    selectionMode: z.enum(['ALL', 'RANDOM']).optional(),
    targetLanguage: z.enum(TRANSLATION_LANGUAGES).nullable().optional(),
    calendar: calendar.nullable().optional(),
    intervalSeconds: z.number().int().min(1).max(86400).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.content) !== Boolean(v.text))
const filterSchema = z
  .object({
    view: z
      .enum(['my', 'waiting-human', 'ai-handling', 'unassigned', 'all-open', 'closed', 'team'])
      .default('all-open'),
    query: z.string().max(200).optional(),
    memberIds: z.array(uuid).max(50).optional(),
    tagIds: z.array(uuid).max(50).optional(),
    createdFrom: z.string().datetime().optional(),
    createdTo: z.string().datetime().optional(),
    properties: z
      .array(
        z
          .object({
            definitionId: uuid,
            value: z.union([z.string().max(2000), z.number().finite()]),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict()

export function campaignRoutes(withDb: WithDb) {
  const routes = new Hono<{ Bindings: Bindings }>()
  const handler = async (c: Context<{ Bindings: Bindings }>) => {
    if (!c.env.HYPERDRIVE || !c.env.BETTER_AUTH_SECRET)
      return c.json({ error: { code: 'NOT_READY' } }, 503)
    return withDb(c.env, async (db) => {
      const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
      if (!session) return c.json({ error: { code: 'UNAUTHORIZED' } }, 401)
      if (!uuid.safeParse(c.req.param('workspaceId')).success)
        return c.json({ error: { code: 'INVALID_REQUEST' } }, 400)
      const identity = {
        workspaceId: c.req.param('workspaceId') as string,
        userId: session.user.id,
      }
      const [id, action] = (c.req.path.split('/campaigns')[1] ?? '').split('/').filter(Boolean)
      try {
        if (id === 'audience' && c.req.method === 'GET') {
          const channelId = uuid.parse(c.req.query('channelId'))
          const filters = filterSchema.parse(JSON.parse(c.req.query('filters') ?? '{}'))
          const after = c.req.query('cursor')
            ? z
                .object({ id: uuid, updatedAt: z.string().datetime() })
                .strict()
                .parse(JSON.parse(c.req.query('cursor') ?? ''))
            : undefined
          return c.json(await listCampaignAudience(db, { ...identity, channelId, filters, after }))
        }
        if (!id && c.req.method === 'GET') return c.json(await listCampaigns(db, identity))
        if (!id && c.req.method === 'POST') {
          const limited = await c.env.AUTH_RATE_LIMITER.limit({
            key: `campaign:${session.user.id}`,
          })
          if (!limited.success) return c.json({ error: { code: 'RATE_LIMITED' } }, 429)
          const input = inputSchema.parse(await c.req.json())
          if (input.calendar) {
            const start = resolveCampaignTime(input.calendar.localTime, input.calendar.timeZone)
            if (
              start <= new Date() ||
              (input.calendar.until && new Date(input.calendar.until) <= start)
            )
              throw new InboxError('INVALID_REQUEST', 'Schedule must be in the future')
          }
          return c.json(
            await saveCampaign(db, {
              ...identity,
              ...input,
              content: input.content ?? [{ id: input.id, text: input.text }],
            }),
            201,
          )
        }
        if (!uuid.safeParse(id).success) return c.json({ error: { code: 'NOT_FOUND' } }, 404)
        if (!action && c.req.method === 'GET')
          return c.json(await readCampaign(db, { ...identity, id }))
        if (c.req.method === 'POST' && ['execute', 'pause', 'resume', 'cancel'].includes(action)) {
          z.object({})
            .strict()
            .parse(await c.req.json())
          const current = await readCampaign(db, { ...identity, id })
          let firstRunAt: Date | undefined
          if (current.campaign.calendar && action === 'execute') {
            firstRunAt = resolveCampaignTime(
              current.campaign.calendar.localTime,
              current.campaign.calendar.timeZone,
            )
            if (firstRunAt <= new Date())
              throw new InboxError('INVALID_REQUEST', 'Schedule is in the past')
          }
          const result = await changeCampaignState(db, {
            ...identity,
            id,
            action: action as 'execute' | 'pause' | 'resume' | 'cancel',
            firstRunAt,
          })
          if (action === 'execute' || action === 'resume') await pumpCampaigns(c.env, withDb)
          return c.json(result)
        }
        return c.json({ error: { code: 'NOT_FOUND' } }, 404)
      } catch (error) {
        if (error instanceof InboxError)
          return c.json(
            { error: { code: error.code, message: error.message } },
            error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : 400,
          )
        if (
          error instanceof z.ZodError ||
          error instanceof SyntaxError ||
          (error instanceof Error &&
            ['INVALID_TIME', 'AMBIGUOUS_OR_MISSING_TIME', 'INVALID_SCHEDULE'].includes(
              error.message,
            )) ||
          error instanceof RangeError
        )
          return c.json({ error: { code: 'INVALID_REQUEST' } }, 400)
        throw error
      }
    })
  }
  routes.all('/api/workspaces/:workspaceId/campaigns', handler)
  routes.all('/api/workspaces/:workspaceId/campaigns/*', handler)
  return routes
}

export async function pumpCampaigns(env: Bindings, withDb: WithDb) {
  const now = new Date()
  const due = await withDb(env, (db) => dueCampaigns(db, now))
  for (const plan of due) {
    if (!plan.nextRunAt) continue
    const scheduledAt = plan.nextRunAt
    const next = plan.calendar ? nextCampaignOccurrence(plan.calendar, now) : null
    await withDb(env, (db) =>
      startCampaignRun(db, {
        id: plan.id,
        scheduledAt,
        nextRunAt:
          next && plan.calendar?.until && next > new Date(plan.calendar.until) ? null : next,
        now,
        skip: Boolean(
          plan.calendar?.repeat !== 'NONE' &&
            plan.calendar &&
            now.getTime() - scheduledAt.getTime() > 300_000,
        ),
      }),
    )
  }
  const translations = await withDb(env, (db) => pendingCampaignTranslations(db))
  for (const { recipient, plan } of translations) {
    try {
      const translated: CampaignContent = []
      for (const [index, block] of recipient.content.entries()) {
        if (!block.text) {
          translated.push(block)
          continue
        }
        const llm = createAlibabaLlmProvider(
          {
            provider: env.LLM_PROVIDER,
            apiKey: env.AI_API_KEY,
            baseUrl: env.AI_BASE_URL,
            model: env.LLM_MODEL,
          },
          meteredAiFetch(
            (work) => withDb(env, work),
            {
              id: recipient.translationOperationId,
              workspaceId: plan.workspaceId,
              memberId: plan.creatorMemberId,
              kind: 'TRANSLATION',
              text: JSON.stringify(recipient.content),
            },
            `CAMPAIGN:${index}`,
          ),
        )
        const result = await llm.generateResponse({
          purpose: 'TRANSLATION',
          instructions: '',
          responseLanguage: plan.targetLanguage ?? '',
          messages: [{ id: block.id, text: block.text }],
          history: [],
          knowledgeChunks: [],
        })
        if (
          result.decision !== 'ANSWER' ||
          result.handoffReason ||
          result.containsBusinessFacts ||
          result.usedChunkIds.length ||
          result.mediaAssetId ||
          result.handoffRuleId
        )
          throw new AIOutputError()
        translated.push({ ...block, text: result.response })
      }
      await withDb(env, (db) =>
        storeCampaignTranslation(db, { recipientId: recipient.id, content: translated }),
      )
      await withDb(env, (db) =>
        finishAiOperation(db, {
          operationId: recipient.translationOperationId,
          state: 'COMPLETED',
        }),
      )
    } catch (error) {
      if (error instanceof AiUsageError && ['OPERATION_PAUSED', 'RETRY_LATER'].includes(error.code))
        continue
      await withDb(env, (db) =>
        stopCampaignRecipient(
          db,
          recipient.id,
          error instanceof AiUsageError ? error.code : 'TRANSLATION_FAILED',
        ),
      )
      await withDb(env, (db) =>
        finishAiOperation(db, {
          operationId: recipient.translationOperationId,
          state: 'FAILED',
          failureCode: 'CAMPAIGN_TRANSLATION_FAILED',
        }),
      )
    }
  }
  const ids = await withDb(env, (db) => dispatchCampaignMessages(db))
  for (const messageId of ids)
    if (env.OUTBOUND_QUEUE)
      await env.OUTBOUND_QUEUE.send({ v: 1, type: 'facebook.outbound', messageId })
}
