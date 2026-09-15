import { z } from 'zod'

export const aiResponseJobSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('ai.response'),
    runId: z.string().uuid(),
  })
  .strict()

export const maintenanceRoutingJobSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('routing.conversation'),
    workspaceId: z.string().uuid(),
    conversationId: z.string().uuid(),
  })
  .strict()
