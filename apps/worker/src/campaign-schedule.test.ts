import { describe, expect, it } from 'vitest'
import { nextCampaignOccurrence, resolveCampaignTime } from './campaign-schedule'

describe('campaign calendar', () => {
  it('resolves the saved zone and rejects ambiguous or missing daylight-saving times', () => {
    expect(resolveCampaignTime('2026-10-14T09:00', 'Asia/Hong_Kong').toISOString()).toBe(
      '2026-10-14T01:00:00.000Z',
    )
    expect(() => resolveCampaignTime('2026-03-08T02:30', 'America/New_York')).toThrow()
    expect(() => resolveCampaignTime('2026-11-01T01:30', 'America/New_York')).toThrow()
    expect(() => resolveCampaignTime('2026-02-30T09:00', 'UTC')).toThrow()
    expect(() => resolveCampaignTime('2026-10-14T09:00', 'Invalid/Zone')).toThrow()
  })
  it('keeps local daily time across an offset change and skips missed occurrences', () => {
    expect(
      nextCampaignOccurrence(
        { localTime: '2026-03-07T09:00', timeZone: 'America/New_York', repeat: 'DAILY' },
        new Date('2026-03-07T14:00:00Z'),
      )?.toISOString(),
    ).toBe('2026-03-08T13:00:00.000Z')
    expect(
      nextCampaignOccurrence(
        { localTime: '2026-10-01T09:00', timeZone: 'UTC', repeat: 'WEEKLY' },
        new Date('2026-10-20T00:00:00Z'),
      )?.toISOString(),
    ).toBe('2026-10-22T09:00:00.000Z')
    expect(
      nextCampaignOccurrence(
        { localTime: '2026-10-01T09:00', timeZone: 'UTC', repeat: 'NONE' },
        new Date('2026-10-20T00:00:00Z'),
      ),
    ).toBeNull()
  })
})
