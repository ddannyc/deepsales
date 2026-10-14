type Calendar = { localTime: string; timeZone: string; repeat: 'NONE' | 'DAILY' | 'WEEKLY' }

function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const value = (type: string) => parts.find((part) => part.type === type)?.value
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`
}

export function resolveCampaignTime(localTime: string, timeZone: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localTime)) throw new Error('INVALID_TIME')
  const naive = Date.parse(`${localTime}:00Z`)
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 16) !== localTime)
    throw new Error('INVALID_TIME')
  const candidates = new Set<number>()
  // Adjacent offsets find both sides of a transition without guessing the browser's zone.
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = naive + hours * 3_600_000
    const offset = Date.parse(`${localParts(new Date(sample), timeZone)}:00Z`) - sample
    const instant = naive - offset
    if (localParts(new Date(instant), timeZone) === localTime) candidates.add(instant)
  }
  if (candidates.size !== 1) throw new Error('AMBIGUOUS_OR_MISSING_TIME')
  return new Date([...candidates][0])
}

export function nextCampaignOccurrence(calendar: Calendar, after: Date) {
  const first = resolveCampaignTime(calendar.localTime, calendar.timeZone)
  if (first > after) return first
  if (calendar.repeat === 'NONE') return null
  const step = calendar.repeat === 'DAILY' ? 1 : 7
  const anchor = Date.parse(`${calendar.localTime}:00Z`)
  const localAfter = Date.parse(`${localParts(after, calendar.timeZone)}:00Z`)
  const elapsedDays = Math.floor((localAfter - anchor) / 86_400_000)
  const firstStep = Math.max(1, Math.floor(elapsedDays / step))
  for (let index = firstStep; index <= firstStep + 370; index++) {
    const localTime = new Date(anchor + index * step * 86_400_000).toISOString().slice(0, 16)
    try {
      const candidate = resolveCampaignTime(localTime, calendar.timeZone)
      if (candidate > after) return candidate
    } catch {
      // A nonexistent or repeated local occurrence is skipped, never sent twice.
    }
  }
  throw new Error('INVALID_SCHEDULE')
}
