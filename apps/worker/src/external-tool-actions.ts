import {
  claimAiExternalAction,
  readExternalDispatchCredential,
  recordExternalActionReceipt,
  type Database,
  type ExternalActionInput,
} from '@deepsales/db'
import type { Bindings } from './bindings'
import { decryptCredential } from './credential-crypto'
import { allowedExternalOrigins } from './external-tool-routes'
import { buildExternalRequest, callExternalTool, ExternalToolError } from './external-tools'

export async function executeExternalToolAction(
  withDb: <T>(work: (db: Database) => Promise<T>) => Promise<T>,
  env: Bindings,
  input: ExternalActionInput,
) {
  const claimed = await withDb((db) => claimAiExternalAction(db, input))
  if (!claimed.dispatch) return claimed.action
  let dispatched = false
  try {
    const definition = { ...claimed.dispatch.tool, origin: claimed.dispatch.origin }
    const request = buildExternalRequest(
      definition,
      input.call.arguments.values,
      allowedExternalOrigins(env),
    )
    const authorized = await withDb((db) =>
      readExternalDispatchCredential(db, { ...input, actionId: claimed.action.id }),
    )
    if (!authorized)
      return withDb((db) =>
        recordExternalActionReceipt(db, {
          actionId: claimed.action.id,
          state: 'CANCELLED',
          failureCode: 'TOOL_AUTHORIZATION_CHANGED',
        }),
      )
    const credential = authorized.credential
      ? await decryptCredential(
          authorized.credential,
          env.TOKEN_ENCRYPTION_KEY,
          `external:${claimed.action.workspaceId}:${authorized.definition.pluginId}`,
        )
      : null
    dispatched = true
    const values = await callExternalTool(request, definition.output, credential)
    // Receipt records the observed external effect even if the current run can no
    // longer use it. Result authorization is checked independently before reply.
    return withDb((db) =>
      recordExternalActionReceipt(db, {
        actionId: claimed.action.id,
        state: 'SUCCEEDED',
        result: values,
      }),
    )
  } catch (error) {
    const unknown = dispatched && claimed.dispatch.tool.effect === 'WRITE'
    return withDb((db) =>
      recordExternalActionReceipt(db, {
        actionId: claimed.action.id,
        state: unknown ? 'UNKNOWN' : 'FAILED',
        failureCode: error instanceof ExternalToolError ? error.code : 'EXTERNAL_REQUEST_FAILED',
      }),
    )
  }
}
