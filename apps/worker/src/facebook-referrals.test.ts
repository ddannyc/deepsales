import { describe, expect, it } from 'vitest'
import { normalizeFacebookReferrals, facebookReferralJobSchema } from './facebook-referrals'
import { normalizeFacebookWebhook } from './facebook'

describe('Messenger referral boundary', () => {
  it('extracts standalone and message referrals without manufacturing customer messages', () => {
    const payload = {
      object: 'page',
      entry: [
        {
          id: 'page-1',
          messaging: [
            {
              sender: { id: 'visitor' },
              recipient: { id: 'page-1' },
              timestamp: 1700000000000,
              referral: {
                source: 'ADS',
                type: 'OPEN_THREAD',
                ad_id: 'ad-1',
                ref: 'catalog',
                ads_context_data: {
                  ad_title: 'Compact desk lamp',
                  photo_url: 'https://example.com/photo.png',
                  secret: 'discard',
                },
              },
            },
            {
              sender: { id: 'visitor' },
              recipient: { id: 'page-1' },
              timestamp: 1700000000001,
              message: {
                mid: 'mid-1',
                text: 'Hello',
                referral: { source: 'SHORTLINK', type: 'OPEN_THREAD', ref: 'help' },
              },
            },
          ],
        },
      ],
    }
    const referrals = normalizeFacebookReferrals(payload)
    expect(referrals).toHaveLength(2)
    expect(referrals[0]).toMatchObject({
      externalMessageId: null,
      source: 'ADS',
      adId: 'ad-1',
      adTitle: 'Compact desk lamp',
      imageUrl: 'https://example.com/photo.png',
    })
    expect(referrals[1]).toMatchObject({
      externalMessageId: 'mid-1',
      source: 'SHORTLINK',
      adTitle: null,
      imageUrl: null,
    })
    expect(JSON.stringify(referrals)).not.toContain('discard')
    expect(normalizeFacebookWebhook(payload)).toHaveLength(1)
    expect(
      facebookReferralJobSchema.parse({
        v: 1,
        type: 'facebook.referral',
        receivedAt: new Date(0).toISOString(),
        event: referrals[0],
      }).event,
    ).toEqual(referrals[0])
  })

  it('rejects mismatched recipients, echoes, unsafe fields and standalone events without a stable timestamp', () => {
    const event = {
      sender: { id: 'visitor' },
      recipient: { id: 'page-1' },
      timestamp: 1700000000000,
      referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: 'ad-1' },
    }
    const events = normalizeFacebookReferrals({
      object: 'page',
      entry: [
        {
          id: 'page-1',
          messaging: [
            { ...event, recipient: { id: 'wrong-page' } },
            { ...event, timestamp: undefined },
            { ...event, message: { mid: 'echo', is_echo: true } },
            { ...event, referral: { ...event.referral, ref: 'x'.repeat(2001) } },
            {
              ...event,
              referral: {
                ...event.referral,
                ads_context_data: { photo_url: 'javascript:alert(1)' },
              },
            },
          ],
        },
      ],
    })
    expect(events).toHaveLength(1)
    expect(events[0].imageUrl).toBeNull()
  })
})
