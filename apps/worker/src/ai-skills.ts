import { z } from 'zod'

export const aiSkillSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    condition: z.string().trim().min(1).max(2000),
    instructions: z.string().trim().min(1).max(8000),
  })
  .strict()
