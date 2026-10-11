import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aiOperation,
  bootstrapWorkspace,
  createDatabase,
  createKnowledgeBase,
  knowledgeChunk,
  knowledgeDocument,
  member,
  saveAiBudget,
  workspaceUserAccess,
} from '@deepsales/db'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AlibabaEmbeddingProvider } from './ai'
import { createAuth } from './auth'
import type { Bindings } from './bindings'
import { app, handleDocumentsBatch } from './index'
import { retrieveKnowledgeChunks } from './knowledge'

const connectionString = process.env.DATABASE_URL
const pool = new Pool({ connectionString })
const db = createDatabase(pool)
type Document = { id: string; question: string; answer: string; revision: number; status: string }

describe.skipIf(!connectionString)(
  'structured knowledge through authorized routes and indexing',
  () => {
    beforeAll(() =>
      migrate(db, {
        migrationsFolder: resolve(
          dirname(fileURLToPath(import.meta.url)),
          '../../../packages/db/drizzle',
        ),
      }),
    )
    afterAll(() => pool.end())
    afterEach(() => vi.unstubAllGlobals())

    it('imports complete question/answer sources once and retrieves them through the existing vector pipeline', async () => {
      const f = await fixture()
      const item = {
        id: crypto.randomUUID(),
        question: 'How do I clean the lamp?',
        answer: 'Disconnect power and use a dry cloth.',
      }
      const imported = await f.call('/documents/questions', 'POST', {
        items: [item, { ...item, id: crypto.randomUUID() }],
      })
      expect(imported.status).toBe(201)
      const { documents } = (await imported.json()) as { documents: Document[] }
      expect(new Set(documents.map((d) => d.id)).size).toBe(1)
      expect(documents[0]).toMatchObject({
        question: item.question,
        answer: item.answer,
        revision: 1,
        status: 'UPLOADED',
      })
      expect((await f.call('/documents/questions', 'POST', { items: [item] })).status).toBe(201)
      const fetcher = vi.fn(async () =>
        Response.json({ data: [{ index: 0, embedding: vector() }] }),
      )
      vi.stubGlobal('fetch', fetcher)
      await consume(documents[0].id, f.env)
      await consume(documents[0].id, f.env)
      expect(fetcher).toHaveBeenCalledOnce()
      const hits = await retrieveKnowledgeChunks(
        db,
        new AlibabaEmbeddingProvider({ apiKey: 'test-key', baseUrl: 'http://ai.test/v1' }, fetcher),
        {},
        {
          workspaceId: f.workspaceId,
          knowledgeBaseId: f.baseId,
          query: item.question,
        },
      )
      expect(hits).toHaveLength(1)
      expect(hits[0]).toMatchObject({
        knowledgeDocumentId: documents[0].id,
        text: 'Question: How do I clean the lamp?\nAnswer: Disconnect power and use a dry cloth.',
      })
      const incompatible = {
        metadata: { provider: 'other', model: 'other-model', dimensions: 1536 },
        embed: vi.fn(async () => [vector()]),
      }
      await expect(
        retrieveKnowledgeChunks(
          db,
          incompatible,
          {},
          {
            workspaceId: f.workspaceId,
            knowledgeBaseId: f.baseId,
            query: item.question,
          },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(incompatible.embed).not.toHaveBeenCalled()
      expect(
        await db
          .select()
          .from(knowledgeDocument)
          .where(eq(knowledgeDocument.knowledgeBaseId, f.baseId)),
      ).toHaveLength(1)
      expect(
        await db.select().from(aiOperation).where(eq(aiOperation.workspaceId, f.workspaceId)),
      ).toHaveLength(1)
    })
    it('shows indexing failures and recovers on a new revision after the budget is restored', async () => {
      const f = await fixture()
      await saveAiBudget(db, {
        workspaceId: f.workspaceId,
        actingUserId: f.userId,
        monthlyLimit: 0,
      })
      const item = {
        id: crypto.randomUUID(),
        question: 'How do I clean the lamp?',
        answer: 'Use a dry cloth.',
      }
      expect((await f.call('/documents/questions', 'POST', { items: [item] })).status).toBe(201)
      const fetcher = vi.fn(async () =>
        Response.json({ data: [{ index: 0, embedding: vector() }] }),
      )
      vi.stubGlobal('fetch', fetcher)
      await consume(item.id, f.env)
      const failed = (await (await f.call('/documents')).json()) as { documents: Document[] }
      expect(failed.documents[0]).toMatchObject({
        status: 'FAILED',
        failureCode: 'QUOTA_EXHAUSTED',
      })
      expect(fetcher).not.toHaveBeenCalled()
      await saveAiBudget(db, {
        workspaceId: f.workspaceId,
        actingUserId: f.userId,
        monthlyLimit: null,
      })
      expect(
        (
          await f.call(`/documents/questions/${item.id}`, 'PATCH', {
            question: item.question,
            answer: item.answer,
            expectedRevision: 1,
          })
        ).status,
      ).toBe(200)
      await consume(item.id, f.env)
      const recovered = (await (await f.call('/documents')).json()) as { documents: Document[] }
      expect(recovered.documents[0]).toMatchObject({
        revision: 2,
        status: 'READY',
        failureCode: null,
      })
      expect(fetcher).toHaveBeenCalledOnce()
    })

    it('removes old answers immediately and refuses late indexing results after an edit or deletion', async () => {
      const f = await fixture()
      const item = {
        id: crypto.randomUUID(),
        question: 'How do I clean the lamp?',
        answer: 'Use a dry cloth.',
      }
      expect((await f.call('/documents/questions', 'POST', { items: [item] })).status).toBe(201)
      const fetcher = vi.fn(async () =>
        Response.json({ data: [{ index: 0, embedding: vector() }] }),
      )
      vi.stubGlobal('fetch', fetcher)
      await consume(item.id, f.env)
      const updated = await f.call(`/documents/questions/${item.id}`, 'PATCH', {
        question: item.question,
        answer: 'Use a soft dry cloth.',
        expectedRevision: 1,
      })
      expect(updated.status).toBe(200)
      expect(
        await db
          .select()
          .from(knowledgeChunk)
          .where(eq(knowledgeChunk.knowledgeDocumentId, item.id)),
      ).toHaveLength(0)
      let release: () => void = () => {}
      let started: () => void = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const pending = new Promise<void>((resolve) => {
        started = resolve
      })
      fetcher.mockImplementationOnce(async () => {
        started()
        await held
        return Response.json({ data: [{ index: 0, embedding: vector() }] })
      })
      const oldJob = consume(item.id, f.env)
      await pending
      try {
        expect(
          (
            await f.call(`/documents/questions/${item.id}`, 'PATCH', {
              question: item.question,
              answer: 'Disconnect power before cleaning.',
              expectedRevision: 2,
            })
          ).status,
        ).toBe(200)
      } finally {
        release()
      }
      await oldJob
      const listed = (await (await f.call('/documents')).json()) as { documents: Document[] }
      expect(listed.documents[0]).toMatchObject({ revision: 3, status: 'UPLOADED' })
      await consume(item.id, f.env)
      const chunks = await db
        .select()
        .from(knowledgeChunk)
        .where(eq(knowledgeChunk.knowledgeDocumentId, item.id))
      expect(chunks).toHaveLength(1)
      expect(chunks[0].text).toBe(
        'Question: How do I clean the lamp?\nAnswer: Disconnect power before cleaning.',
      )
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(
        await db.select().from(aiOperation).where(eq(aiOperation.workspaceId, f.workspaceId)),
      ).toHaveLength(3)
      expect((await f.call(`/documents/${item.id}`, 'DELETE')).status).toBe(204)
      await consume(item.id, f.env)
      expect(
        await db
          .select()
          .from(knowledgeChunk)
          .where(eq(knowledgeChunk.knowledgeDocumentId, item.id)),
      ).toHaveLength(0)
    })
    it('rejects ambiguous imports, lost edits and unauthorized mutations without partial writes', async () => {
      const f = await fixture()
      const item = {
        id: crypto.randomUUID(),
        question: 'Which cloth can I use?',
        answer: 'A dry cloth.',
      }
      expect(
        (
          await f.call('/documents/questions', 'POST', {
            items: [item, { ...item, id: crypto.randomUUID(), answer: 'A wet cloth.' }],
          })
        ).status,
      ).toBe(409)
      expect(
        ((await (await f.call('/documents')).json()) as { documents: Document[] }).documents,
      ).toHaveLength(0)
      expect((await f.call('/documents/questions', 'POST', { items: [item] })).status).toBe(201)
      const updates = await Promise.all(
        ['Use a soft cloth.', 'Disconnect power first.'].map((answer) =>
          f.call(`/documents/questions/${item.id}`, 'PATCH', {
            question: item.question,
            answer,
            expectedRevision: 1,
          }),
        ),
      )
      expect(updates.map((r) => r.status).sort()).toEqual([200, 409])
      const winner = (await updates.find((r) => r.status === 200)?.json()) as { document: Document }
      expect(
        (
          await f.call(`/documents/questions/${item.id}`, 'PATCH', {
            question: item.question,
            answer: winner.document.answer,
            expectedRevision: 1,
          })
        ).status,
      ).toBe(200)
      const other = await fixture()
      expect(
        (
          await other.call(`/documents/questions/${item.id}`, 'PATCH', {
            question: item.question,
            answer: item.answer,
            expectedRevision: 1,
          })
        ).status,
      ).toBe(404)
      await db
        .update(workspaceUserAccess)
        .set({ role: 'AGENT' })
        .where(eq(workspaceUserAccess.userId, f.userId))
      expect(
        (
          await f.call('/documents/questions', 'POST', {
            items: [{ ...item, id: crypto.randomUUID() }],
          })
        ).status,
      ).toBe(403)
      await db
        .update(workspaceUserAccess)
        .set({ role: 'OWNER' })
        .where(eq(workspaceUserAccess.userId, f.userId))
      await db
        .update(member)
        .set({ status: 'DISABLED' })
        .where(eq(member.workspaceId, f.workspaceId))
      expect(
        (
          await f.call('/documents/questions', 'POST', {
            items: [{ ...item, id: crypto.randomUUID() }],
          })
        ).status,
      ).toBe(403)
      expect((await f.call('/documents')).status).toBe(403)
    })
  },
)

async function consume(documentId: string, env: Bindings) {
  const item = {
    body: { v: 1, type: 'knowledge.document', documentId },
    ack: vi.fn(),
    retry: vi.fn(),
  }
  await handleDocumentsBatch({ messages: [item] } as unknown as MessageBatch<unknown>, env)
  expect(item.ack).toHaveBeenCalledOnce()
  expect(item.retry).not.toHaveBeenCalled()
}

function vector() {
  return [1, ...Array.from({ length: 1535 }, () => 0)]
}

async function fixture() {
  const jobs: unknown[] = []
  const env = {
    APP_URL: 'http://localhost:8787',
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    BETTER_AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters',
    HYPERDRIVE: { connectionString },
    AI_API_KEY: 'test-key',
    AI_BASE_URL: 'http://ai.test/v1',
    EMBEDDING_PROVIDER: 'alibaba',
    EMBEDDING_MODEL: 'qwen3.7-text-embedding',
    EMBEDDING_DIMENSIONS: '1536',
    DOCUMENTS_QUEUE: {
      send: async (job: unknown) => {
        jobs.push(job)
      },
    },
  } as unknown as Bindings
  const email = `${crypto.randomUUID()}@example.com`
  const password = 'correct-horse-battery-staple'
  const created = await createAuth(db, env).api.signUpEmail({
    body: { email, password, name: 'Knowledge owner' },
  })
  const signed = await app.request(
    '/api/auth/sign-in/email',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
    env,
  )
  const cookie = signed.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('Missing session')
  const workspace = await bootstrapWorkspace(db, {
    userId: created.user.id,
    userName: 'Knowledge owner',
    name: 'Question facts',
  })
  const base = await createKnowledgeBase(db, {
    workspaceId: workspace.id,
    createdByUserId: created.user.id,
    name: 'Support facts',
  })
  return {
    workspaceId: workspace.id,
    baseId: base.id,
    userId: created.user.id,
    env,
    jobs,
    call: (path: string, method = 'GET', body?: unknown) =>
      app.request(
        `/api/workspaces/${workspace.id}/knowledge-bases/${base.id}${path}`,
        {
          method,
          headers: { Cookie: cookie, Origin: env.APP_URL, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
      ),
  }
}
