import { useCallback, useEffect, useId, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './components/ui/alert-dialog'
import { Button } from './components/ui/button'
import { Checkbox } from './components/ui/checkbox'
import { Input } from './components/ui/input'
import { StatusBadge } from './components/ui/status-badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select'
import { Textarea } from './components/ui/textarea'
import { InboxFilterControls, type InboxFilters } from './inbox-filters'

type Block = { id: string; text?: string; assetId?: string }
type Calendar = {
  localTime: string
  timeZone: string
  repeat: string
  maxRuns?: number
  until?: string
}
type Plan = {
  id: string
  name: string
  status: string
  channelId: string
  identityIds: string[]
  content: Block[]
  selectionMode: string
  targetLanguage: string | null
  calendar: Calendar | null
  intervalSeconds: number
  nextRunAt: string | null
}
type Detail = {
  campaign: Plan
  nextRunBefore: string | null
  runs: {
    id: string
    scheduledAt: string
    nextRecipientOrdinal: number | null
    recipients: {
      id: string
      channelIdentityId: string
      state: string
      reason: string | null
      messages: { id: string; state: string; failureCode: string | null }[]
    }[]
  }[]
}
type Audience = {
  id: string
  channelIdentityId: string
  customerName: string | null
  channelName: string
  assigneeName: string | null
}
const labels: Record<string, string> = {
  DRAFT: '草稿',
  ACTIVE: '执行中',
  PAUSED: '已暂停',
  CANCELLED: '已取消',
  COMPLETED: '已完成',
  WAITING: '等待',
  SUCCESS: '发送接口已接受',
  FAILED: '失败',
  SKIPPED: '已跳过',
  UNKNOWN: '结果不明',
  PENDING: '等待发送',
  SENT: '发送接口已接受',
  SEND_NOT_PERMITTED: '渠道、成员权限或消息窗口不允许发送',
  CAMPAIGN_NOT_PERMITTED: '渠道或成员权限已变化',
  TRANSLATION_FAILED: '翻译失败，未发送',
  TRANSLATION_RESULT_UNKNOWN: '翻译结果不明，已暂停',
  QUOTA_EXHAUSTED: 'AI 用量已达限额，未发送',
  MEDIA_UNAVAILABLE: '素材已不可用',
  NO_CONVERSATION: '没有可用的历史会话',
  FACEBOOK_DELIVERY_FAILED: '提供方拒绝了发送',
  AMBIGUOUS_DELIVERY: '发送结果不明，请先核实',
  REPLY_WINDOW_CLOSED: '普通消息窗口已关闭',
}
const initialBlock = () => ({ id: crypto.randomUUID(), text: '' })
const statusTones = {
  DRAFT: 'neutral',
  ACTIVE: 'info',
  PAUSED: 'warning',
  CANCELLED: 'neutral',
  COMPLETED: 'success',
  WAITING: 'warning',
  SUCCESS: 'success',
  FAILED: 'destructive',
  SKIPPED: 'neutral',
  UNKNOWN: 'warning',
  PENDING: 'warning',
  SENT: 'success',
} as const

function CampaignStatus({ state }: { state: string }) {
  return (
    <StatusBadge tone={statusTones[state as keyof typeof statusTones] ?? 'neutral'}>
      {labels[state] ?? state}
    </StatusBadge>
  )
}

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { id: string; name: string }[]
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <label htmlFor={id}>
      {label}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )
}

export function Campaigns({ workspaceId, manager }: { workspaceId: string; manager: boolean }) {
  const base = `/api/workspaces/${workspaceId}`
  const [plans, setPlans] = useState<Plan[]>([])
  const [channels, setChannels] = useState<{ id: string; displayName: string }[]>([])
  const [assets, setAssets] = useState<{ id: string; title: string; kind: string }[]>([])
  const [templates, setTemplates] = useState<{ id: string; title: string; text: string }[]>([])
  const [name, setName] = useState('')
  const [editingId, setEditingId] = useState<string>()
  const [channelId, setChannelId] = useState('none')
  const [filters, setFilters] = useState<InboxFilters>({ view: 'all-open' })
  const ready = useCallback((next?: InboxFilters) => {
    if (next) setFilters(next)
  }, [])
  const [createdFrom, setCreatedFrom] = useState('')
  const [createdTo, setCreatedTo] = useState('')
  const [audience, setAudience] = useState<Audience[]>([])
  const [cursor, setCursor] = useState<unknown>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [blocks, setBlocks] = useState<Block[]>([initialBlock()])
  const [selectionMode, setSelectionMode] = useState('ALL')
  const [language, setLanguage] = useState('none')
  const [timing, setTiming] = useState('NOW')
  const [localTime, setLocalTime] = useState('')
  const [timeZone, setTimeZone] = useState('UTC')
  const [repeat, setRepeat] = useState('NONE')
  const [maxRuns, setMaxRuns] = useState('10')
  const [interval, setInterval] = useState('1')
  const [detail, setDetail] = useState<Detail>()
  const [confirm, setConfirm] = useState<Plan>()
  const [confirmAction, setConfirmAction] = useState<'execute' | 'cancel'>('execute')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const request = useCallback(
    async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
      const response = await fetch(`${base}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      })
      if (!response.ok) {
        const result = (await response.json().catch(() => ({}))) as { error?: { code: string } }
        throw new Error(
          result.error?.code === 'FORBIDDEN'
            ? '需要管理员身份及渠道访问权限。'
            : result.error?.code === 'INVALID_REQUEST'
              ? '请检查受众、内容及时间。定时必须在未来，夏令时缺失或重复时刻不可用。'
              : '操作失败，请重试。',
        )
      }
      return response.json() as Promise<T>
    },
    [base],
  )
  const load = useCallback(async () => {
    const [p, c, a, t] = await Promise.all([
      request<{ campaigns: Plan[] }>('/campaigns'),
      request<{ channels: { id: string; displayName: string }[] }>('/channels'),
      request<{ assets: { id: string; title: string; kind: string }[] }>('/media-assets'),
      request<{ templates: { id: string; title: string; text: string }[] }>('/reply-templates'),
    ])
    setPlans(p.campaigns)
    setChannels(c.channels)
    setAssets(a.assets)
    setTemplates(t.templates)
  }, [request])
  useEffect(() => {
    if (!manager) {
      setLoading(false)
      return
    }
    let cancelled = false
    void load()
      .catch((e) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [load, manager])
  async function act(work: () => Promise<void>) {
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await work()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function search(more = false) {
    const query = new URLSearchParams({
      channelId,
      filters: JSON.stringify({
        ...filters,
        ...(createdFrom ? { createdFrom: `${createdFrom}T00:00:00Z` } : {}),
        ...(createdTo ? { createdTo: `${createdTo}T23:59:59Z` } : {}),
      }),
    })
    if (more && cursor) query.set('cursor', JSON.stringify(cursor))
    const result = await request<{ conversations: Audience[]; nextCursor: unknown }>(
      `/campaigns/audience?${query}`,
    )
    setAudience(more ? [...audience, ...result.conversations] : result.conversations)
    setCursor(result.nextCursor)
  }
  async function refresh(id: string) {
    setDetail(await request<Detail>(`/campaigns/${id}`))
    await load()
  }
  const changeBlock = (index: number, block: Block) =>
    setBlocks(blocks.map((current, i) => (i === index ? block : current)))
  if (!manager)
    return (
      <main className="workspace-page">
        <h1>群发计划</h1>
        <p>仅管理员可管理群发计划。</p>
      </main>
    )
  return (
    <main className="workspace-page">
      <header className="page-header">
        <div className="page-header-copy">
          <h1>群发计划</h1>
          <p>保存明确受众后单独执行。普通消息仅在当前获许可窗口内发送，不改变接待成员。</p>
        </div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void act(() => (detail ? refresh(detail.campaign.id) : load()))}
        >
          刷新
        </Button>
      </header>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {loading ? (
        <p role="status">正在加载计划…</p>
      ) : (
        <>
          <section className="runtime-section" aria-labelledby="campaign-create">
            <h2 id="campaign-create">{editingId ? '编辑草稿' : '新建计划'}</h2>
            {editingId && (
              <Button
                variant="ghost"
                onClick={() => {
                  setEditingId(undefined)
                  setName('')
                  setSelected([])
                  setBlocks([initialBlock()])
                }}
              >
                新建另一份草稿
              </Button>
            )}
            <div className="form-grid-two">
              <label htmlFor="campaign-name">
                计划名称
                <Input
                  id="campaign-name"
                  value={name}
                  maxLength={100}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <Choice
                label="发送渠道"
                value={channelId}
                options={[
                  { id: 'none', name: '请选择渠道' },
                  ...channels.map((c) => ({ id: c.id, name: c.displayName })),
                ]}
                onChange={(value) => {
                  setChannelId(value)
                  setSelected([])
                  setAudience([])
                }}
              />
            </div>
            <h3>选择受众</h3>
            <InboxFilterControls
              workspaceId={workspaceId}
              manager
              filters={filters}
              onApply={setFilters}
              onReady={ready}
            />
            <div className="form-grid-two">
              <label htmlFor="campaign-created-from">
                客户创建日期起（UTC）
                <Input
                  id="campaign-created-from"
                  type="date"
                  value={createdFrom}
                  onChange={(e) => setCreatedFrom(e.target.value)}
                />
              </label>
              <label htmlFor="campaign-created-to">
                客户创建日期止（UTC）
                <Input
                  id="campaign-created-to"
                  type="date"
                  value={createdTo}
                  onChange={(e) => setCreatedTo(e.target.value)}
                />
              </label>
            </div>
            <Button
              variant="outline"
              disabled={busy || channelId === 'none'}
              onClick={() => void act(() => search())}
            >
              预览受众
            </Button>
            <p>已明确选择 {selected.length} 个渠道身份。循环不会自动加入新客户。</p>
            <Button variant="ghost" disabled={!selected.length} onClick={() => setSelected([])}>
              清除已选身份
            </Button>
            {audience.map((person) => (
              <label
                key={person.id}
                htmlFor={`audience-${person.id}`}
                className="flex items-center gap-2"
              >
                <Checkbox
                  id={`audience-${person.id}`}
                  checked={selected.includes(person.channelIdentityId)}
                  onCheckedChange={(checked) =>
                    setSelected(
                      checked
                        ? [...new Set([...selected, person.channelIdentityId])]
                        : selected.filter((id) => id !== person.channelIdentityId),
                    )
                  }
                />
                {person.customerName ?? '未命名客户'} · {person.channelName} ·{' '}
                {person.assigneeName ?? '未分配'}
              </label>
            ))}
            {cursor !== null && (
              <Button variant="ghost" disabled={busy} onClick={() => void act(() => search(true))}>
                更多受众
              </Button>
            )}
            <h3>内容块</h3>
            {blocks.map((block, index) => (
              <div key={block.id} className="runtime-section">
                <label htmlFor={`block-${block.id}`}>第 {index + 1} 块文字</label>
                <Textarea
                  id={`block-${block.id}`}
                  value={block.text ?? ''}
                  maxLength={2000}
                  disabled={Boolean(block.assetId)}
                  onChange={(e) => changeBlock(index, { id: block.id, text: e.target.value })}
                />
                <Choice
                  label={`第 ${index + 1} 块素材`}
                  value={block.assetId ?? 'none'}
                  options={[
                    { id: 'none', name: '使用文字' },
                    ...assets.map((a) => ({ id: a.id, name: `${a.title} · ${a.kind}` })),
                  ]}
                  onChange={(value) =>
                    changeBlock(
                      index,
                      value === 'none'
                        ? { id: block.id, text: '' }
                        : { id: block.id, assetId: value },
                    )
                  }
                />
                <Choice
                  label={`第 ${index + 1} 块话术`}
                  value="none"
                  options={[
                    { id: 'none', name: '插入话术文字' },
                    ...templates.map((t) => ({ id: t.id, name: t.title })),
                  ]}
                  onChange={(value) => {
                    const template = templates.find((t) => t.id === value)
                    if (template) changeBlock(index, { id: block.id, text: template.text })
                  }}
                />
                <div className="page-header-actions">
                  <Button
                    variant="ghost"
                    disabled={index === 0}
                    onClick={() => {
                      const next = [...blocks]
                      ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
                      setBlocks(next)
                    }}
                  >
                    上移
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={index === blocks.length - 1}
                    onClick={() => {
                      const next = [...blocks]
                      ;[next[index + 1], next[index]] = [next[index], next[index + 1]]
                      setBlocks(next)
                    }}
                  >
                    下移
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={blocks.length === 1}
                    onClick={() => setBlocks(blocks.filter((b) => b.id !== block.id))}
                  >
                    删除内容块
                  </Button>
                </div>
              </div>
            ))}
            <Button
              variant="outline"
              disabled={blocks.length >= 20}
              onClick={() => setBlocks([...blocks, initialBlock()])}
            >
              添加内容块
            </Button>
            <div className="form-grid-two">
              <Choice
                label="内容选择"
                value={selectionMode}
                options={[
                  { id: 'ALL', name: '全部按顺序发送' },
                  { id: 'RANDOM', name: '每身份随机一块' },
                ]}
                onChange={setSelectionMode}
              />
              <Choice
                label="翻译目标"
                value={language}
                options={[
                  { id: 'none', name: '保留原文' },
                  ...['en', 'zh', 'es', 'fr', 'de', 'ja', 'pt', 'ar'].map((id) => ({
                    id,
                    name: id,
                  })),
                ]}
                onChange={setLanguage}
              />
            </div>
            <p>
              随机选择和翻译结果按轮次及身份保留。翻译失败停止该身份发送；结果不明暂停等待处理。
            </p>
            <div className="form-grid-two">
              <Choice
                label="执行时间"
                value={timing}
                options={[
                  { id: 'NOW', name: '确认执行后开始' },
                  { id: 'SCHEDULED', name: '定时' },
                ]}
                onChange={setTiming}
              />
              <label htmlFor="campaign-interval">
                同渠道发送间隔（秒）
                <Input
                  id="campaign-interval"
                  type="number"
                  min={1}
                  max={86400}
                  value={interval}
                  onChange={(e) => setInterval(e.target.value)}
                />
              </label>
            </div>
            <p>默认至少 1 秒，提供方更严格的限制和退避优先；扫描恢复可能使实际间隔更长。</p>
            {timing === 'SCHEDULED' && (
              <>
                <div className="form-grid-two">
                  <label htmlFor="campaign-local-time">
                    计划当地时间
                    <Input
                      id="campaign-local-time"
                      type="datetime-local"
                      value={localTime}
                      onChange={(e) => setLocalTime(e.target.value)}
                    />
                  </label>
                  <label htmlFor="campaign-time-zone">
                    计划时区
                    <Input
                      id="campaign-time-zone"
                      value={timeZone}
                      onChange={(e) => setTimeZone(e.target.value)}
                      placeholder="UTC"
                    />
                  </label>
                  <Choice
                    label="重复周期"
                    value={repeat}
                    options={[
                      { id: 'NONE', name: '不重复' },
                      { id: 'DAILY', name: '每天' },
                      { id: 'WEEKLY', name: '每周' },
                    ]}
                    onChange={setRepeat}
                  />
                  {repeat !== 'NONE' && (
                    <label htmlFor="campaign-max-runs">
                      最多轮次
                      <Input
                        id="campaign-max-runs"
                        type="number"
                        min={1}
                        max={1000}
                        value={maxRuns}
                        onChange={(e) => setMaxRuns(e.target.value)}
                      />
                    </label>
                  )}
                </div>
                <p>
                  夏令时缺失或重复的起始时刻不接受；循环中这些时刻跳过。恢复时不补发错过的历史轮次。
                </p>
              </>
            )}
            <Button
              disabled={
                busy ||
                Boolean(
                  editingId &&
                    plans.some((plan) => plan.id === editingId && plan.status !== 'DRAFT'),
                ) ||
                !name.trim() ||
                !selected.length ||
                channelId === 'none' ||
                blocks.some((b) => !b.assetId && !b.text?.trim())
              }
              onClick={() =>
                void act(async () => {
                  const result = await request<{ campaign: Plan }>('/campaigns', 'POST', {
                    id: editingId ?? crypto.randomUUID(),
                    name,
                    channelId,
                    identityIds: selected,
                    content: blocks,
                    selectionMode,
                    targetLanguage: language === 'none' ? null : language,
                    intervalSeconds: Number(interval),
                    calendar:
                      timing === 'NOW'
                        ? null
                        : {
                            localTime,
                            timeZone,
                            repeat,
                            ...(repeat === 'NONE' ? {} : { maxRuns: Number(maxRuns) }),
                          },
                  })
                  await refresh(result.campaign.id)
                  setEditingId(result.campaign.id)
                  setStatus('草稿已保存，尚未发送。')
                })
              }
            >
              保存草稿
            </Button>
          </section>
          <section className="runtime-section">
            <h2>已保存计划</h2>
            {!plans.length && <p>保存草稿后，计划及逐身份执行结果会显示在这里。</p>}
            {plans.map((plan) => (
              <div key={plan.id} className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => void act(() => refresh(plan.id))}>
                  {plan.name}
                </Button>
                <CampaignStatus state={plan.status} />
                <span>{plan.identityIds.length} 个身份</span>
                {plan.status === 'DRAFT' && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditingId(plan.id)
                      setName(plan.name)
                      setChannelId(plan.channelId)
                      setSelected(plan.identityIds)
                      setBlocks(plan.content)
                      setSelectionMode(plan.selectionMode)
                      setLanguage(plan.targetLanguage ?? 'none')
                      setInterval(String(plan.intervalSeconds))
                      setTiming(plan.calendar ? 'SCHEDULED' : 'NOW')
                      setLocalTime(plan.calendar?.localTime ?? '')
                      setTimeZone(plan.calendar?.timeZone ?? 'UTC')
                      setRepeat(plan.calendar?.repeat ?? 'NONE')
                      setMaxRuns(String(plan.calendar?.maxRuns ?? 10))
                    }}
                  >
                    编辑草稿
                  </Button>
                )}
                {plan.status === 'DRAFT' && (
                  <Button
                    disabled={busy}
                    variant="outline"
                    onClick={() => {
                      setConfirmAction('execute')
                      setConfirm(plan)
                    }}
                  >
                    执行计划
                  </Button>
                )}
                {plan.status === 'ACTIVE' && (
                  <Button
                    disabled={busy}
                    variant="outline"
                    onClick={() =>
                      void act(async () => {
                        await request(`/campaigns/${plan.id}/pause`, 'POST', {})
                        await refresh(plan.id)
                      })
                    }
                  >
                    暂停
                  </Button>
                )}
                {plan.status === 'PAUSED' && (
                  <Button
                    disabled={busy}
                    variant="outline"
                    onClick={() =>
                      void act(async () => {
                        await request(`/campaigns/${plan.id}/resume`, 'POST', {})
                        await refresh(plan.id)
                      })
                    }
                  >
                    恢复
                  </Button>
                )}
                {['DRAFT', 'ACTIVE', 'PAUSED'].includes(plan.status) && (
                  <Button
                    disabled={busy}
                    variant="ghost"
                    onClick={() => {
                      setConfirmAction('cancel')
                      setConfirm(plan)
                    }}
                  >
                    取消后续发送
                  </Button>
                )}
              </div>
            ))}
          </section>
          {detail && (
            <section className="runtime-section">
              <h2>{detail.campaign.name} · 执行结果</h2>
              <p>发送接口接受不代表送达或已读。已合法提交的消息在暂停或取消后仍独立送达。</p>
              {detail.campaign.nextRunAt && (
                <p>
                  下一轮：{detail.campaign.nextRunAt} ·{' '}
                  {detail.campaign.calendar?.timeZone ?? 'UTC'}
                </p>
              )}
              {!detail.runs.length && <p>尚无执行轮次。</p>}
              {detail.runs.map((run) => (
                <section key={run.id}>
                  <h3>{run.scheduledAt}</h3>
                  {run.recipients.map((person) => (
                    <p key={person.id}>
                      身份 …{person.channelIdentityId.slice(-6)}：
                      <CampaignStatus state={person.state} />
                      {person.reason &&
                        ` · ${labels[person.reason] ?? '发送未完成，请检查渠道和素材状态。'}`}
                      {person.messages.map((m) => (
                        <CampaignStatus key={m.id} state={m.state} />
                      ))}
                    </p>
                  ))}
                  {run.nextRecipientOrdinal !== null && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const more = await request<Detail>(
                            `/campaigns/${detail.campaign.id}?runId=${run.id}&afterOrdinal=${run.nextRecipientOrdinal}`,
                          )
                          const next = more.runs[0]
                          if (!next) throw new Error('此轮次已不可用，请刷新。')
                          setDetail((current) =>
                            current?.campaign.id === detail.campaign.id
                              ? {
                                  ...current,
                                  runs: current.runs.map((item) =>
                                    item.id === run.id
                                      ? {
                                          ...next,
                                          recipients: [...item.recipients, ...next.recipients],
                                        }
                                      : item,
                                  ),
                                }
                              : current,
                          )
                        })
                      }
                    >
                      更多收件结果
                    </Button>
                  )}
                </section>
              ))}
              {detail.nextRunBefore && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const more = await request<Detail>(
                        `/campaigns/${detail.campaign.id}?before=${encodeURIComponent(detail.nextRunBefore ?? '')}`,
                      )
                      setDetail((current) =>
                        current?.campaign.id === detail.campaign.id
                          ? {
                              ...current,
                              runs: [...current.runs, ...more.runs],
                              nextRunBefore: more.nextRunBefore,
                            }
                          : current,
                      )
                    })
                  }
                >
                  更早轮次
                </Button>
              )}
            </section>
          )}
        </>
      )}
      <AlertDialog
        open={Boolean(confirm)}
        onOpenChange={(open) => {
          if (!open) setConfirm(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === 'execute' ? '执行此群发计划？' : '取消此计划的后续发送？'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === 'execute'
                ? `${confirm?.name} 将按已保存内容及时间向 ${confirm?.identityIds.length} 个明确选择的身份发送。每次发送前重新检查许可；不改变接待成员。`
                : `${confirm?.name} 的未提交收件项和未来轮次将取消。已合法提交的消息仍独立送达。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {confirmAction === 'execute' ? '保留草稿' : '保留计划'}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                const plan = confirm
                if (plan)
                  void act(async () => {
                    await request(`/campaigns/${plan.id}/${confirmAction}`, 'POST', {})
                    setConfirm(undefined)
                    await refresh(plan.id)
                    setStatus(
                      confirmAction === 'execute' ? '计划已提交执行。' : '计划后续发送已取消。',
                    )
                  })
              }}
            >
              {confirmAction === 'execute' ? '确认执行计划' : '确认取消后续发送'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}
