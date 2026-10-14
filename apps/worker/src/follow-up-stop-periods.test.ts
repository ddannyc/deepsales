import { EMPTY_AI_STOP_RULES, hasAiStopPeriodBetween } from '@deepsales/db'
import { describe, expect, it } from 'vitest'
const rules = (day: number, start: string, end: string) => ({
  ...EMPTY_AI_STOP_RULES,
  periods: [{ day, start, end }],
})
describe('follow-up stop interval invalidation', () => {
  it('does not revive a timer after a completed stop window and respects exact endpoints', () => {
    const r = rules(2, '18:00', '19:00')
    expect(
      hasAiStopPeriodBetween(
        r,
        'UTC',
        new Date('2026-10-13T17:00Z'),
        new Date('2026-10-13T20:00Z'),
      ),
    ).toBe(true)
    expect(
      hasAiStopPeriodBetween(
        r,
        'UTC',
        new Date('2026-10-13T19:00Z'),
        new Date('2026-10-13T20:00Z'),
      ),
    ).toBe(false)
    expect(
      hasAiStopPeriodBetween(
        r,
        'UTC',
        new Date('2026-10-13T17:00Z'),
        new Date('2026-10-13T18:00Z'),
      ),
    ).toBe(true)
    expect(
      hasAiStopPeriodBetween(
        r,
        'UTC',
        new Date('2026-10-13T17:00Z'),
        new Date('2026-10-13T17:59:59Z'),
      ),
    ).toBe(false)
  })
  it('finds a short interval across local midnight and fractional UTC offsets', () => {
    expect(
      hasAiStopPeriodBetween(
        rules(3, '00:10', '00:11'),
        'Asia/Kathmandu',
        new Date('2026-10-13T18:00Z'),
        new Date('2026-10-13T19:00Z'),
      ),
    ).toBe(true)
  })
  it('distinguishes a skipped spring hour from an actual partial interval', () => {
    expect(
      hasAiStopPeriodBetween(
        rules(0, '02:10', '02:20'),
        'America/New_York',
        new Date('2026-03-08T06:00Z'),
        new Date('2026-03-08T08:00Z'),
      ),
    ).toBe(false)
    expect(
      hasAiStopPeriodBetween(
        rules(0, '02:30', '03:30'),
        'America/New_York',
        new Date('2026-03-08T06:00Z'),
        new Date('2026-03-08T08:00Z'),
      ),
    ).toBe(true)
  })
  it('recognizes both copies of a repeated autumn stop hour', () => {
    const r = rules(0, '01:10', '01:20')
    expect(
      hasAiStopPeriodBetween(
        r,
        'America/New_York',
        new Date('2026-11-01T05:00Z'),
        new Date('2026-11-01T05:30Z'),
      ),
    ).toBe(true)
    expect(
      hasAiStopPeriodBetween(
        r,
        'America/New_York',
        new Date('2026-11-01T06:00Z'),
        new Date('2026-11-01T06:30Z'),
      ),
    ).toBe(true)
  })
  it('bounds long downtime and keeps empty schedules inactive', () => {
    expect(
      hasAiStopPeriodBetween(
        rules(1, '00:00', '00:01'),
        'UTC',
        new Date('2026-01-01'),
        new Date('2026-10-01'),
      ),
    ).toBe(true)
    expect(
      hasAiStopPeriodBetween(
        EMPTY_AI_STOP_RULES,
        'UTC',
        new Date('2026-01-01'),
        new Date('2026-10-01'),
      ),
    ).toBe(false)
  })
})
