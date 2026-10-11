import { z } from 'zod'
import { FacebookWebhookPayloadError, MAX_FACEBOOK_WEBHOOK_EVENTS } from './facebook'

const referral = z.object({
  source: z.string().min(1).max(200),
  type: z.string().min(1).max(200),
  ref: z.string().max(2000).optional(),
  ad_id: z.string().min(1).max(200).optional(),
  referer_uri: z.string().max(2000).optional(),
  ads_context_data: z
    .object({
      ad_title: z.string().max(2000).optional(),
      photo_url: z.string().max(2000).optional(),
    })
    .optional(),
})

export const facebookReferralJobSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('facebook.referral'),
    receivedAt: z.string().datetime(),
    event: z
      .object({
        pageId: z.string().min(1).max(200),
        externalUserId: z.string().min(1).max(500),
        externalMessageId: z.string().min(1).max(500).nullable(),
        providerSentAt: z.string().datetime().nullable(),
        source: z.string().min(1).max(200),
        type: z.string().min(1).max(200),
        ref: z.string().max(2000).nullable(),
        adId: z.string().min(1).max(200).nullable(),
        refererUri: z.string().max(2000).nullable(),
        adTitle: z.string().max(2000).nullable(),
        imageUrl: z
          .string()
          .url()
          .max(2000)
          .refine((value) => value.startsWith('https://'))
          .nullable(),
      })
      .strict()
      .refine((event) => event.providerSentAt !== null || event.externalMessageId !== null),
  })
  .strict()

export function normalizeFacebookReferrals(payload: unknown) {
  const envelope = z
    .object({ object: z.literal('page'), entry: z.array(z.unknown()) })
    .safeParse(payload)
  const events: z.infer<typeof facebookReferralJobSchema>['event'][] = []
  if (!envelope.success) return events
  for (const rawEntry of envelope.data.entry) {
    const entry = z.object({ id: z.string(), messaging: z.array(z.unknown()) }).safeParse(rawEntry)
    if (!entry.success) continue
    for (const rawEvent of entry.data.messaging) {
      const parsed = z
        .object({
          sender: z.object({ id: z.string() }),
          recipient: z.object({ id: z.string() }),
          timestamp: z.number().int().nonnegative().optional(),
          referral: z.unknown().optional(),
          message: z
            .object({
              mid: z.string().optional(),
              is_echo: z.boolean().optional(),
              referral: z.unknown().optional(),
            })
            .optional(),
        })
        .safeParse(rawEvent)
      if (!parsed.success) continue
      const event = parsed.data
      if (event.recipient.id !== entry.data.id || event.message?.is_echo) continue
      const detail = referral.safeParse(event.message?.referral ?? event.referral)
      if (!detail.success) continue
      const timestamp = event.timestamp === undefined ? null : new Date(event.timestamp)
      const image = detail.data.ads_context_data?.photo_url
      const imageUrl =
        image && z.string().url().safeParse(image).success && image.startsWith('https://')
          ? image
          : null
      const queued = facebookReferralJobSchema.shape.event.safeParse({
        pageId: entry.data.id,
        externalUserId: event.sender.id,
        externalMessageId: event.message?.mid ?? null,
        providerSentAt:
          timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.toISOString() : null,
        source: detail.data.source,
        type: detail.data.type,
        ref: detail.data.ref ?? null,
        adId: detail.data.ad_id ?? null,
        refererUri: detail.data.referer_uri ?? null,
        adTitle: detail.data.ads_context_data?.ad_title ?? null,
        imageUrl,
      })
      if (!queued.success) continue
      if (events.length >= MAX_FACEBOOK_WEBHOOK_EVENTS)
        throw new FacebookWebhookPayloadError('TOO_MANY_EVENTS')
      events.push(queued.data)
    }
  }
  return events
}
