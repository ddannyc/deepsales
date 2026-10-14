import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { AiMemberError, getAiMemberConfig, readAiViewerChannelIds } from './ai-members'
import {
  type ExternalRequestDefinition,
  validateExternalDefinition,
  validateExternalObjectScope,
} from './ai-external-contracts'
import { reserveAiOperation } from './ai-operations'
import type { Database } from './database'
import { aiExternalPlugin, aiExternalTool, aiToolAction, aiOperation, workspace } from './schema'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
export type ExternalIdentity = { workspaceId: string; memberId: string; actingUserId: string }
type Plugin = typeof aiExternalPlugin.$inferSelect
const publicPluginColumns = {
  id: aiExternalPlugin.id,
  channelId: aiExternalPlugin.channelId,
  name: aiExternalPlugin.name,
  origin: aiExternalPlugin.origin,
  enabled: aiExternalPlugin.enabled,
  revision: aiExternalPlugin.revision,
  auth: aiExternalPlugin.auth,
  configured: sql<boolean>`${aiExternalPlugin.auth} = 'NONE' or ${aiExternalPlugin.encryptedCredential} is not null`,
}
export type ExternalPluginInput = ExternalIdentity &
  Pick<Plugin, 'id' | 'name' | 'channelId' | 'origin' | 'enabled' | 'auth'> & {
    revision?: number
    credential?: { ciphertext: string; iv: string; keyVersion: string } | null
  }
export type ExternalToolInput = ExternalIdentity &
  Omit<typeof aiExternalTool.$inferInsert, 'createdAt' | 'updatedAt' | 'deletedAt' | 'revision'> & {
    revision?: number
  }

async function lockManager(tx: Tx, input: ExternalIdentity) {
  await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
  await getAiMemberConfig(tx, input)
  return readAiViewerChannelIds(tx, input)
}
function publicPlugin(plugin: Plugin) {
  return {
    id: plugin.id,
    channelId: plugin.channelId,
    name: plugin.name,
    origin: plugin.origin,
    enabled: plugin.enabled,
    revision: plugin.revision,
    auth: plugin.auth,
    configured: plugin.auth === 'NONE' || Boolean(plugin.encryptedCredential),
  }
}
async function managerPlugin(tx: Tx, input: ExternalIdentity, id: string, channels: string[]) {
  const [plugin] = await tx
    .select(publicPluginColumns)
    .from(aiExternalPlugin)
    .where(
      and(
        eq(aiExternalPlugin.id, id),
        eq(aiExternalPlugin.workspaceId, input.workspaceId),
        eq(aiExternalPlugin.memberId, input.memberId),
        inArray(aiExternalPlugin.channelId, channels),
        isNull(aiExternalPlugin.deletedAt),
      ),
    )
  if (!plugin) throw new AiMemberError('NOT_FOUND')
  return plugin
}
export async function listExternalConfiguration(db: Database, input: ExternalIdentity) {
  return db.transaction(async (tx) => {
    const channels = await lockManager(tx, input)
    const plugins = await tx
      .select(publicPluginColumns)
      .from(aiExternalPlugin)
      .where(
        and(
          eq(aiExternalPlugin.workspaceId, input.workspaceId),
          eq(aiExternalPlugin.memberId, input.memberId),
          inArray(aiExternalPlugin.channelId, channels),
          isNull(aiExternalPlugin.deletedAt),
        ),
      )
      .orderBy(asc(aiExternalPlugin.createdAt), asc(aiExternalPlugin.id))
    const tools = await tx
      .select()
      .from(aiExternalTool)
      .where(
        and(
          inArray(
            aiExternalTool.pluginId,
            plugins.map((plugin) => plugin.id),
          ),
          isNull(aiExternalTool.deletedAt),
        ),
      )
      .orderBy(asc(aiExternalTool.createdAt), asc(aiExternalTool.id))
    return { plugins, tools }
  })
}
export async function saveExternalPlugin(db: Database, input: ExternalPluginInput) {
  return db.transaction(async (tx) => {
    const channels = await lockManager(tx, input)
    if (!channels.includes(input.channelId)) throw new AiMemberError('FORBIDDEN')
    if (!input.name.trim() || input.name.length > 100 || !['NONE', 'BEARER'].includes(input.auth))
      throw new AiMemberError('INVALID_CONFIGURATION')
    const [existing] = await tx
      .select()
      .from(aiExternalPlugin)
      .where(eq(aiExternalPlugin.id, input.id))
    if (existing) {
      await managerPlugin(tx, input, input.id, channels)
      if (input.revision !== existing.revision) throw new AiMemberError('INVALID_REQUEST')
    } else if (input.revision !== undefined) throw new AiMemberError('INVALID_REQUEST')
    const credential = input.auth === 'NONE' ? null : input.credential
    const values = {
      name: input.name.trim(),
      channelId: input.channelId,
      origin: input.origin,
      enabled: input.enabled,
      auth: input.auth,
      ...(credential !== undefined
        ? {
            encryptedCredential: credential?.ciphertext ?? null,
            credentialIv: credential?.iv ?? null,
            credentialKeyVersion: credential?.keyVersion ?? null,
          }
        : {}),
      updatedAt: new Date(),
    }
    const [saved] = existing
      ? await tx
          .update(aiExternalPlugin)
          .set({ ...values, revision: existing.revision + 1 })
          .where(eq(aiExternalPlugin.id, input.id))
          .returning()
      : await tx
          .insert(aiExternalPlugin)
          .values({
            ...values,
            id: input.id,
            workspaceId: input.workspaceId,
            memberId: input.memberId,
          })
          .returning()
    if (existing)
      await tx
        .update(aiExternalTool)
        .set({ revision: sql`${aiExternalTool.revision} + 1`, updatedAt: new Date() })
        .where(eq(aiExternalTool.pluginId, saved.id))
    return publicPlugin(saved)
  })
}
export async function saveExternalTool(db: Database, input: ExternalToolInput) {
  return db.transaction(async (tx) => {
    const channels = await lockManager(tx, input)
    const plugin = await managerPlugin(tx, input, input.pluginId, channels)
    try {
      validateExternalDefinition({ ...input, origin: plugin.origin } as ExternalRequestDefinition)
      validateExternalObjectScope(input.objectScope, {
        ...input,
        origin: plugin.origin,
      } as ExternalRequestDefinition)
      if (
        !input.name.trim() ||
        input.name.length > 100 ||
        input.description.length > 1000 ||
        input.objectScope.length > 1000 ||
        (input.effect === 'WRITE' && !input.objectScope.trim())
      )
        throw new Error()
    } catch {
      throw new AiMemberError('INVALID_CONFIGURATION')
    }
    const [existing] = await tx.select().from(aiExternalTool).where(eq(aiExternalTool.id, input.id))
    if (existing) {
      if (
        existing.deletedAt ||
        existing.pluginId !== input.pluginId ||
        existing.revision !== input.revision
      )
        throw new AiMemberError('INVALID_REQUEST')
    } else if (input.revision !== undefined) throw new AiMemberError('INVALID_REQUEST')
    const {
      id,
      pluginId,
      name,
      description,
      enabled,
      method,
      path,
      effect,
      inputs,
      fixed,
      output,
      objectScope,
    } = input
    const values = {
      pluginId,
      name,
      description,
      enabled,
      method,
      path,
      effect,
      inputs,
      fixed,
      output,
      objectScope,
      updatedAt: new Date(),
    }
    const [saved] = existing
      ? await tx
          .update(aiExternalTool)
          .set({ ...values, revision: existing.revision + 1 })
          .where(eq(aiExternalTool.id, id))
          .returning()
      : await tx
          .insert(aiExternalTool)
          .values({ ...values, id })
          .returning()
    return saved
  })
}
export async function deleteExternalDefinition(
  db: Database,
  input: ExternalIdentity & { id: string; revision: number; kind: 'plugin' | 'tool' },
) {
  return db.transaction(async (tx) => {
    const channels = await lockManager(tx, input)
    if (input.kind === 'plugin') {
      const plugin = await managerPlugin(tx, input, input.id, channels)
      if (plugin.revision !== input.revision) throw new AiMemberError('INVALID_REQUEST')
      await tx
        .update(aiExternalPlugin)
        .set({
          enabled: false,
          deletedAt: new Date(),
          revision: plugin.revision + 1,
          encryptedCredential: null,
          credentialIv: null,
          credentialKeyVersion: null,
        })
        .where(eq(aiExternalPlugin.id, input.id))
      await tx
        .update(aiExternalTool)
        .set({ enabled: false, revision: sql`${aiExternalTool.revision} + 1` })
        .where(eq(aiExternalTool.pluginId, input.id))
    } else {
      const [tool] = await tx.select().from(aiExternalTool).where(eq(aiExternalTool.id, input.id))
      if (!tool || tool.deletedAt || tool.revision !== input.revision)
        throw new AiMemberError('INVALID_REQUEST')
      await managerPlugin(tx, input, tool.pluginId, channels)
      await tx
        .update(aiExternalTool)
        .set({ enabled: false, deletedAt: new Date(), revision: tool.revision + 1 })
        .where(eq(aiExternalTool.id, input.id))
    }
  })
}
export async function debugExternalTool(
  db: Database,
  input: ExternalIdentity & { id: string; toolId: string; values: Record<string, unknown> },
) {
  return db.transaction(async (tx) => {
    const channels = await lockManager(tx, input)
    const [tool] = await tx.select().from(aiExternalTool).where(eq(aiExternalTool.id, input.toolId))
    if (!tool?.enabled || tool.deletedAt) throw new AiMemberError('NOT_FOUND')
    const plugin = await managerPlugin(tx, input, tool.pluginId, channels)
    if (!plugin.enabled) throw new AiMemberError('INVALID_CONFIGURATION')
    const operation = await reserveAiOperation(tx, {
      id: input.id,
      workspaceId: input.workspaceId,
      memberId: input.memberId,
      kind: 'TEST',
      text: `external-debug:${tool.id}`,
    })
    const [existing] = await tx
      .select()
      .from(aiToolAction)
      .where(and(eq(aiToolAction.operationId, operation.id), eq(aiToolAction.ordinal, 0)))
    if (existing) {
      if (
        existing.tool !== `external:${tool.id}` ||
        existing.definitionRevision !== tool.revision ||
        JSON.stringify(existing.arguments) !== JSON.stringify(input.values)
      )
        throw new AiMemberError('INVALID_REQUEST')
      return existing
    }
    const result = Object.fromEntries(
      tool.output.map((field) => [
        field.name,
        field.type === 'string' ? '沙箱示例' : field.type === 'number' ? 0 : false,
      ]),
    )
    const [action] = await tx
      .insert(aiToolAction)
      .values({
        workspaceId: input.workspaceId,
        memberId: input.memberId,
        operationId: operation.id,
        ordinal: 0,
        tool: `external:${tool.id}`,
        definitionRevision: tool.revision,
        arguments: input.values,
        simulated: true,
        state: 'SUCCEEDED',
        result,
        startedAt: new Date(),
        completedAt: new Date(),
      })
      .returning()
    await tx
      .update(aiOperation)
      .set({ state: 'COMPLETED', updatedAt: new Date() })
      .where(eq(aiOperation.id, operation.id))
    return action
  })
}
