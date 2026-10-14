import {
  deleteExternalDefinition,
  debugExternalTool,
  listExternalConfiguration,
  saveExternalPlugin,
  saveExternalTool,
  type Database,
  type ExternalIdentity,
} from '@deepsales/db'
import type { Context } from 'hono'
import { z } from 'zod'
import type { Bindings } from './bindings'
import { encryptCredential } from './credential-crypto'
import { buildExternalRequest, validateExternalOrigin } from './external-tools'

export function allowedExternalOrigins(env: Bindings): string[] {
  try {
    const value: unknown = JSON.parse(env.AI_TOOL_ALLOWED_ORIGINS ?? '[]')
    return Array.isArray(value) &&
      value.length <= 20 &&
      value.every((item) => typeof item === 'string')
      ? value
      : []
  } catch {
    return []
  }
}
const uuid = z.string().uuid()
const primitive = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()])
const inputSchema = z
  .object({
    name: z.string().min(1).max(50),
    type: z.enum(['string', 'number', 'boolean']),
    location: z.enum(['path', 'query', 'body']),
    required: z.boolean(),
  })
  .strict()
const fixedSchema = z
  .object({
    name: z.string().min(1).max(50),
    location: z.enum(['path', 'query', 'body']),
    value: primitive,
  })
  .strict()
const outputSchema = z
  .object({
    name: z.string().min(1).max(50),
    path: z.array(z.string().min(1).max(50)).min(1).max(4),
    type: z.enum(['string', 'number', 'boolean']),
  })
  .strict()

export async function externalToolRoute(
  c: Context<{ Bindings: Bindings }>,
  db: Database,
  identity: ExternalIdentity,
  action: string,
  segments: string[],
  body: unknown,
) {
  if (!['plugins', 'external-tools'].includes(action)) return null
  if (c.req.method === 'GET') {
    const configuration = await listExternalConfiguration(db, identity)
    return c.json({ ...configuration, allowedOrigins: allowedExternalOrigins(c.env) })
  }
  if (c.req.method === 'DELETE') {
    const input = z.object({ id: uuid, revision: z.number().int().positive() }).strict().parse(body)
    await deleteExternalDefinition(db, {
      ...identity,
      ...input,
      kind: action === 'plugins' ? 'plugin' : 'tool',
    })
    return c.json({ deleted: true })
  }
  if (c.req.method !== 'POST') return c.json({ error: { code: 'NOT_FOUND' } }, 404)
  if (action === 'plugins') {
    const input = z
      .object({
        id: uuid,
        revision: z.number().int().positive().optional(),
        name: z.string().trim().min(1).max(100),
        channelId: uuid,
        origin: z.string().max(1000),
        enabled: z.boolean(),
        auth: z.enum(['NONE', 'BEARER']),
        credential: z.string().min(1).max(4000).nullable().optional(),
      })
      .strict()
      .parse(body)
    const origin = validateExternalOrigin(input.origin, allowedExternalOrigins(c.env))
    const credential =
      input.credential === undefined
        ? undefined
        : input.credential === null
          ? null
          : await encryptCredential(
              input.credential,
              c.env.TOKEN_ENCRYPTION_KEY,
              `external:${identity.workspaceId}:${input.id}`,
            )
    return c.json(await saveExternalPlugin(db, { ...identity, ...input, origin, credential }), 201)
  }
  if (segments[3] === 'debug') {
    const input = z
      .object({ id: uuid, values: z.record(z.string().max(50), primitive) })
      .strict()
      .parse(body)
    const toolId = uuid.parse(segments[2])
    const config = await listExternalConfiguration(db, identity)
    const tool = config.tools.find((tool) => tool.id === toolId)
    const plugin = config.plugins.find((plugin) => plugin.id === tool?.pluginId)
    if (!tool || !plugin) return c.json({ error: { code: 'NOT_FOUND' } }, 404)
    buildExternalRequest(
      { ...tool, origin: plugin.origin },
      input.values,
      allowedExternalOrigins(c.env),
    )
    // Debug is always simulated, before any production credential query or fetch.
    return c.json(await debugExternalTool(db, { ...identity, ...input, toolId }))
  }
  const input = z
    .object({
      id: uuid,
      revision: z.number().int().positive().optional(),
      pluginId: uuid,
      name: z.string().trim().min(1).max(100),
      description: z.string().max(1000),
      enabled: z.boolean(),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string().max(1000),
      effect: z.enum(['READ', 'WRITE']),
      inputs: z.array(inputSchema).max(20),
      fixed: z.array(fixedSchema).max(20),
      output: z.array(outputSchema).min(1).max(20),
      objectScope: z.string().max(1000),
    })
    .strict()
    .parse(body)
  const config = await listExternalConfiguration(db, identity)
  const plugin = config.plugins.find((plugin) => plugin.id === input.pluginId)
  if (!plugin) return c.json({ error: { code: 'NOT_FOUND' } }, 404)
  validateExternalOrigin(plugin.origin, allowedExternalOrigins(c.env))
  return c.json(
    await saveExternalTool(db, { ...identity, ...input } as Parameters<typeof saveExternalTool>[1]),
    201,
  )
}
