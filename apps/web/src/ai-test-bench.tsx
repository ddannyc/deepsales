import { useEffect, useId, useRef, useState } from 'react'
import type { HandoffRule } from './ai-handoff-settings'
import { Button } from './components/ui/button'
import { Checkbox } from './components/ui/checkbox'
import { Input } from './components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select'
import { StatusBadge } from './components/ui/status-badge'
import { Textarea } from './components/ui/textarea'

type Customer = {
  properties: { definitionId: string; value: string | number }[]
  tags: string[]
  source: string
  language: string
  memory: string
}
type Session = {
  id: string
  generation: number
  source: string
  configVersionId: string | null
  customer: Customer
  snapshot: { instructions: string; responseLanguage: string; automaticLanguageEnabled?: boolean }
}
type Turn = {
  id: string
  state: string
  input: string
  failureCode: string | null
  output: { kind?: string; decision?: { response?: string } } | null
  chunkIds: string[]
}
type Options = {
  properties: {
    id: string
    name: string
    level: string
    type: string
    options: string[]
    maxLength: number
  }[]
  tags: { id: string; name: string; level: string }[]
}
const emptyCustomer = (): Customer => ({
  properties: [],
  tags: [],
  source: '',
  language: '',
  memory: '',
})

export function AiTestBench({
  workspaceId,
  memberId,
  versions,
  rules,
  request,
  onInspect,
  onUpdated,
}: {
  workspaceId: string
  memberId: string
  versions: { id: string; publishedAt: string }[]
  rules: HandoffRule[]
  request: <T>(url: string, body?: unknown) => Promise<T>
  onInspect: (id: string) => void
  onUpdated: () => Promise<void>
}) {
  const root = `/api/workspaces/${workspaceId}/ai-operations/${memberId}`
  const storageKey = `ai-test:${workspaceId}:${memberId}`
  const prefix = useId()
  const [source, setSource] = useState('PUBLISHED')
  const [customer, setCustomer] = useState<Customer>(emptyCustomer)
  const [options, setOptions] = useState<Options>()
  const [session, setSession] = useState<Session>()
  const [turns, setTurns] = useState<Turn[]>([])
  const [question, setQuestion] = useState('')
  const [simulatedRule, setSimulatedRule] = useState('NONE')
  const [busy, setBusy] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const epoch = useRef(0)
  const requestId = useRef(crypto.randomUUID())
  const sessionId = useRef(crypto.randomUUID())
  useEffect(() => {
    let disposed = false
    const saved = sessionStorage.getItem(storageKey)
    setLoading(true)
    void Promise.all([
      request<Options>(`/api/workspaces/${workspaceId}/inbox-filter-options`),
      saved
        ? request<{ session: Session; turns: Turn[] }>(`${root}/sessions/${saved}`)
        : Promise.resolve(undefined),
    ])
      .then(([definitions, data]) => {
        if (disposed) return
        setOptions(definitions)
        if (data) {
          setSession(data.session)
          setTurns(data.turns)
          setCustomer(data.session.customer)
          setSource(
            data.session.source === 'VERSION'
              ? (data.session.configVersionId ?? 'PUBLISHED')
              : data.session.source,
          )
        }
      })
      .catch((cause: Error) => {
        if (!disposed) setError(cause.message)
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
      epoch.current++
    }
  }, [root, storageKey, workspaceId, request])

  function changeProperty(definitionId: string, value: string | number | null) {
    setCustomer((current) => ({
      ...current,
      properties: [
        ...current.properties.filter((p) => p.definitionId !== definitionId),
        ...(value === null ? [] : [{ definitionId, value }]),
      ],
    }))
  }
  async function run() {
    const currentEpoch = epoch.current
    setBusy(true)
    setError('')
    try {
      const active =
        session ??
        (
          await request<{ session: Session }>(`${root}/sessions`, {
            id: sessionId.current,
            source: ['DRAFT', 'PUBLISHED'].includes(source) ? source : 'VERSION',
            versionId: ['DRAFT', 'PUBLISHED'].includes(source) ? undefined : source,
            customer,
          })
        ).session
      if (epoch.current !== currentEpoch) return
      setSession(active)
      sessionStorage.setItem(storageKey, active.id)
      await request(`${root}/test`, {
        id: requestId.current,
        source: active.source,
        versionId: active.configVersionId ?? undefined,
        text: question,
        sessionId: active.id,
        generation: active.generation,
      })
      const data = await request<{ session: Session; turns: Turn[] }>(
        `${root}/sessions/${active.id}`,
      )
      if (epoch.current !== currentEpoch) return
      setSession(data.session)
      setCustomer(data.session.customer)
      setTurns(data.turns)
      const latest = data.turns.at(-1)
      if (latest?.state === 'COMPLETED') {
        setQuestion('')
        requestId.current = crypto.randomUUID()
      }
      await onUpdated()
    } catch (cause) {
      if (epoch.current === currentEpoch)
        setError(cause instanceof Error ? cause.message : '测试失败，请重试。')
    } finally {
      if (epoch.current === currentEpoch) setBusy(false)
    }
  }
  async function clear() {
    const currentEpoch = ++epoch.current
    setClearing(true)
    setError('')
    try {
      if (session)
        await request(`${root}/sessions/${session.id}/clear`, { generation: session.generation })
      if (epoch.current !== currentEpoch) return
      sessionStorage.removeItem(storageKey)
      setSession(undefined)
      setTurns([])
      setCustomer(emptyCustomer())
      setSimulatedRule('NONE')
      setQuestion('')
      requestId.current = crypto.randomUUID()
      sessionId.current = crypto.randomUUID()
      await onUpdated()
    } catch (cause) {
      if (epoch.current === currentEpoch)
        setError(cause instanceof Error ? cause.message : '清空未确认，请重试。')
    } finally {
      if (epoch.current === currentEpoch) {
        setBusy(false)
        setClearing(false)
      }
    }
  }
  const frozen = busy || clearing || loading || Boolean(session)
  return (
    <section className="runtime-section" aria-label="多轮测试台">
      <h3>多轮测试台</h3>
      <p className="table-muted">
        模拟资料仅用于隔离测试，不创建真实客户、会话、分配或外发。每次生成计入用量。清空会取消旧运行并重置模拟记忆；已发生的调用仍计费。
      </p>
      {loading && <p role="status">正在加载测试台…</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <label className="field" htmlFor={`${prefix}-config`}>
        测试配置
        <Select
          value={source}
          disabled={frozen}
          onValueChange={(value) => {
            setSource(value)
            sessionId.current = crypto.randomUUID()
          }}
        >
          <SelectTrigger id={`${prefix}-config`} aria-label="测试配置">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="DRAFT">当前已保存草稿</SelectItem>
            <SelectItem value="PUBLISHED">当前发布版本</SelectItem>
            {versions.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                历史：{new Date(v.publishedAt).toLocaleString()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {session && (
        <p role="status">
          所测配置：
          {session.source === 'DRAFT'
            ? '已保存草稿快照'
            : `固定发布版本 ${session.configVersionId}`}{' '}
          · 输出语言：
          {session.snapshot.automaticLanguageEnabled
            ? session.customer.language || session.snapshot.responseLanguage
            : session.snapshot.responseLanguage}
          。更换配置或模拟资料前请清空测试。
        </p>
      )}
      <details>
        <summary>模拟客户资料</summary>
        <p className="field-description">
          模拟语言填写语言代码，例如 en、zh-CN；留空从客户输入判断。固定语言模式仍使用配置语言。
        </p>
        {(['source', 'language', 'memory'] as const).map((field) => (
          <label className="field" key={field} htmlFor={`${prefix}-${field}`}>
            {{ source: '模拟来源', language: '模拟语言', memory: '模拟记忆' }[field]}
            <Textarea
              id={`${prefix}-${field}`}
              disabled={frozen}
              value={customer[field]}
              maxLength={field === 'language' ? 100 : 1000}
              onChange={(e) => setCustomer({ ...customer, [field]: e.target.value })}
            />
          </label>
        ))}
        {options?.properties.map((d) => (
          <label className="field" key={d.id} htmlFor={`${prefix}-${d.id}`}>
            模拟属性：{d.name}（{d.level === 'CUSTOMER' ? '客户' : '会话'}）
            {d.type === 'OPTION' ? (
              <Select
                disabled={frozen}
                value={
                  customer.properties.some((p) => p.definitionId === d.id)
                    ? `option:${customer.properties.find((p) => p.definitionId === d.id)?.value}`
                    : 'NONE'
                }
                onValueChange={(value) =>
                  changeProperty(d.id, value === 'NONE' ? null : value.slice(7))
                }
              >
                <SelectTrigger id={`${prefix}-${d.id}`} aria-label={`模拟属性：${d.name}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">未设置</SelectItem>
                  {d.options.map((value) => (
                    <SelectItem key={value} value={`option:${value}`}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={`${prefix}-${d.id}`}
                disabled={frozen}
                type={d.type === 'NUMBER' ? 'number' : 'text'}
                value={customer.properties.find((p) => p.definitionId === d.id)?.value ?? ''}
                maxLength={d.maxLength}
                onChange={(e) =>
                  changeProperty(
                    d.id,
                    !e.target.value
                      ? null
                      : d.type === 'NUMBER'
                        ? Number(e.target.value)
                        : e.target.value,
                  )
                }
              />
            )}
          </label>
        ))}
        {options?.tags.map((tag) => (
          <label className="checkbox-field" key={tag.id} htmlFor={`${prefix}-${tag.id}`}>
            <Checkbox
              id={`${prefix}-${tag.id}`}
              disabled={frozen}
              checked={customer.tags.includes(tag.id)}
              onCheckedChange={(checked) =>
                setCustomer({
                  ...customer,
                  tags: checked
                    ? [...customer.tags, tag.id]
                    : customer.tags.filter((id) => id !== tag.id),
                })
              }
            />
            模拟标签：{tag.name}（{tag.level === 'CUSTOMER' ? '客户' : '会话'}）
          </label>
        ))}
      </details>
      <Select
        value={simulatedRule}
        disabled={frozen}
        onValueChange={(value) => {
          setSimulatedRule(value)
          const condition = rules.find((r) => r.id === value)?.condition
          setCustomer({
            ...customer,
            properties:
              condition?.kind === 'PROPERTY'
                ? [{ definitionId: condition.definitionId, value: condition.value }]
                : [],
            tags: condition?.kind === 'TAG' ? [condition.tagId] : [],
          })
        }}
      >
        <SelectTrigger aria-label="模拟属性标签条件">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="NONE">不提供模拟属性或标签</SelectItem>
          {rules
            .filter((r) => r.enabled && r.condition.kind !== 'SEMANTIC')
            .map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      <p className="table-muted">
        快捷填入条件对应的模拟属性或标签；自然语义条件使用当前问题判断。最多 50 轮，上下文最多 48
        条消息、8,000 字符；超出后请清空开始新测试。
      </p>
      <div className="ai-operation-list" role="log" aria-label="测试对话记录">
        {turns.map((turn) => (
          <article key={turn.id} className="message-translation">
            <p>模拟客户：{turn.input}</p>
            <StatusBadge
              tone={
                turn.state === 'COMPLETED'
                  ? 'success'
                  : ['FAILED', 'UNKNOWN'].includes(turn.state)
                    ? 'destructive'
                    : 'neutral'
              }
            >
              {{
                COMPLETED: '已完成',
                FAILED: '失败',
                CANCELLED: '已取消',
                UNKNOWN: '结果不明，已暂停',
                STARTED: '生成中',
                RESERVED: '等待生成',
              }[turn.state] ?? turn.state}
            </StatusBadge>
            {turn.output?.decision?.response && <p>测试 AI：{turn.output.decision.response}</p>}
            {turn.failureCode && (
              <p className="field-description">
                失败原因：
                {{
                  AI_PROVIDER_ERROR: '模型服务失败',
                  INVALID_OUTPUT: '模型返回内容无效',
                  INVALID_CONFIGURATION: '配置引用已变化，请清空后检查',
                  INVALID_REQUEST: '模拟资料已失效，请检查',
                  QUOTA_EXHAUSTED: '本月额度已耗尽',
                  TEST_CLEARED: '测试已清空',
                }[turn.failureCode] ?? '测试未完成，请查看诊断。'}
              </p>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={() => onInspect(turn.id)}>
              查看测试诊断
            </Button>
          </article>
        ))}
      </div>
      <label className="field" htmlFor={`${prefix}-question`}>
        测试问题
        <Textarea
          id={`${prefix}-question`}
          disabled={busy || clearing || loading}
          value={question}
          maxLength={8000}
          onChange={(e) => {
            setQuestion(e.target.value)
            requestId.current = crypto.randomUUID()
          }}
        />
      </label>
      <div className="message-translation-controls">
        <Button
          type="button"
          size="sm"
          disabled={busy || clearing || loading || !question.trim()}
          onClick={() => void run()}
        >
          {busy ? '运行中…' : '运行测试'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={clearing || loading || (busy && !session)}
          onClick={() => void clear()}
        >
          清空测试
        </Button>
      </div>
    </section>
  )
}
