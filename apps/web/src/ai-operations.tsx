import { useCallback, useEffect, useState } from 'react'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './components/ui/table'

type Version = {
  id: string
  publishedAt: string
  snapshot: Record<string, unknown>
  invalidReferences: string[]
}
type Budget = { monthlyLimit: number | null; used: number; reserved: number; period: string }
type Run = {
  id: string
  state: string
  createdAt: string
  configVersionId: string | null
  failureCode?: string | null
  cancellationReason?: string | null
}
type Diagnostics = {
  run: (Run & { configSnapshot: Record<string, unknown> | null }) | null
  operation: {
    id: string
    state: string
    input: string
    output: { kind?: string; decision?: { response?: string; handoffReason?: string } } | null
    snapshot: Record<string, unknown> | null
    failureCode: string | null
    configVersionId: string | null
  } | null
  inputs: { id: string; text: string }[]
  history: { id: string; text: string; direction: string }[]
  output: { text: string } | null
  chunks: { id: string; text: string }[]
  missingChunkIds: string[]
  attempts: { id: string; stage: string; state: string; httpStatus: number | null }[]
  feedback: { id: string; category: string; note: string }[]
}
type Analytics = {
  calculatedAt: string
  runs: { day: string; state: string; count: number }[]
  usage: {
    kind: string
    state: string
    operations: number
    charged: number
    provider_attempts: number
  }[]
  replies: { sender: string; replies: number; sent: number; failed: number }[]
}

const labels: Record<string, string> = {
  QUEUED: '等待',
  GENERATING: '生成中',
  COMPLETED: '已完成',
  HANDOFF: '转人工',
  CANCELLED: '已取消',
  FAILED: '失败',
  UNKNOWN: '结果不明，已暂停',
  RESERVED: '已预约',
  STARTED: '处理中',
  SUCCESS: '成功',
  LIVE_REPLY: '真实接待',
  TEST: '隔离测试',
  KNOWLEDGE_INDEX: '知识索引',
  HUMAN: '人工',
  AI: 'AI',
  KNOWLEDGE: '知识问题',
  MODEL: '模型问题',
  OTHER: '其它',
  NEW_CUSTOMER_MESSAGE: '输入已更新',
  OWNERSHIP_CHANGED: '接待成员已更改',
  QUOTA_EXHAUSTED: '额度已耗尽',
  OPERATION_PAUSED: '调用已暂停',
  NO_KNOWLEDGE: '无可靠知识',
  GROUNDING_FAILED: '回答缺少知识依据',
  INVALID_OUTPUT: '模型输出无效',
  INVALID_EMBEDDING: '检索输出无效',
  AI_PROVIDER_ERROR: '模型服务失败',
  MODEL_HANDOFF: '模型请求转人工',
}
const label = (value: string) => labels[value] ?? value

async function api<T>(url: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  )
  if (!response.ok) {
    const result = (await response.json().catch(() => null)) as { error?: { code: string } } | null
    const code = result?.error?.code
    throw new Error(
      code === 'QUOTA_EXHAUSTED'
        ? '本月额度已耗尽。测试已停止。'
        : code === 'FORBIDDEN'
          ? '没有查看或修改权限。'
          : code === 'INVALID_REQUEST'
            ? '输入无效，或限额低于已使用及预约量。'
            : '操作未确认成功，请刷新查看状态后重试。',
    )
  }
  return response.json() as Promise<T>
}

export function AiOperations({
  workspaceId,
  memberId,
  publishedVersionId,
  onRestored,
}: {
  workspaceId: string
  memberId: string
  publishedVersionId?: string | null
  onRestored: () => Promise<void>
}) {
  const root = `/api/workspaces/${workspaceId}/ai-operations`
  const [versions, setVersions] = useState<Version[]>([])
  const [budget, setBudget] = useState<Budget>()
  const [limit, setLimit] = useState('')
  const [runs, setRuns] = useState<Run[]>([])
  const [tests, setTests] = useState<Run[]>([])
  const [nextCursor, setNextCursor] = useState<{ createdAt: string; id: string } | null>(null)
  const [preview, setPreview] = useState<Version>()
  const [diagnostics, setDiagnostics] = useState<Diagnostics>()
  const [category, setCategory] = useState('MODEL')
  const [note, setNote] = useState('')
  const [source, setSource] = useState('PUBLISHED')
  const [question, setQuestion] = useState('')
  const [testId, setTestId] = useState<string>()
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [from, setFrom] = useState(() =>
    new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
  )
  const [to, setTo] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10))
  const [timezone, setTimezone] = useState('UTC')
  const [versionFilter, setVersionFilter] = useState('ALL')
  const [memberFilter, setMemberFilter] = useState('CURRENT')
  const [analytics, setAnalytics] = useState<Analytics>()
  const load = useCallback(async () => {
    const [history, nextBudget, records] = await Promise.all([
      api<{ versions: Version[] }>(`${root}/${memberId}/versions`),
      api<Budget>(`${root}/budget`),
      api<{ runs: Run[]; tests: Run[]; nextCursor: { createdAt: string; id: string } | null }>(
        `${root}/${memberId}/runs`,
      ),
    ])
    setVersions(history.versions)
    setBudget(nextBudget)
    setLimit(nextBudget.monthlyLimit?.toString() ?? '')
    setRuns(records.runs)
    setTests(records.tests)
    setNextCursor(records.nextCursor)
  }, [root, memberId])
  async function act(work: () => Promise<void>) {
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await work()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (!publishedVersionId) setVersions([])
    setLoading(true)
    void load()
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setLoading(false))
  }, [load, publishedVersionId])
  useEffect(() => {
    const messageId = new URLSearchParams(window.location.search).get('diagnosticMessage')
    if (messageId)
      void api<Diagnostics>(`${root}/message/${messageId}`)
        .then(setDiagnostics)
        .catch((cause: Error) => setError(cause.message))
  }, [root])
  return (
    <section className="ai-operations" aria-label="AI 发布与运营">
      <header className="section-heading">
        <h2>发布与运营</h2>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(load)}>
          刷新记录
        </Button>
      </header>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {loading && <p role="status">正在加载运营记录…</p>}
      <section className="runtime-section">
        <h3>发布历史</h3>
        {!loading && !versions.length && <p className="table-muted">尚无发布版本。</p>}
        <div className="ai-operation-list">
          {versions.map((version) => (
            <div key={version.id}>
              <span>
                {new Date(version.publishedAt).toLocaleString()}{' '}
                {version.id === publishedVersionId ? '· 当前运行版本' : ''}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setPreview(version)}
              >
                预览版本
              </Button>
            </div>
          ))}
        </div>
      </section>
      <section className="runtime-section">
        <h3>工作区用量限额</h3>
        <p>
          自然月 UTC · 每个逻辑操作计 1
          次。真实回复（含检索）、隔离测试、知识索引分别计数。已发起调用即计费，服务失败仍计 1
          次，重试不重复扣应用额度。
        </p>
        {budget && (
          <p>
            {budget.period}：已使用 {budget.used} · 预约 {budget.reserved} ·{' '}
            {budget.monthlyLimit === null ? '未设限' : `限额 ${budget.monthlyLimit}`}
          </p>
        )}
        <label className="field" htmlFor="ai-budget-limit">
          本月硬限额（留空为未设限）
          <Input
            id="ai-budget-limit"
            value={limit}
            type="number"
            min="0"
            step="1"
            onChange={(e) => setLimit(e.target.value)}
          />
        </label>
        <Button
          size="sm"
          disabled={busy || !budget}
          onClick={() =>
            void act(async () => {
              await api(
                `${root}/budget`,
                { monthlyLimit: limit === '' ? null : Number(limit) },
                'PATCH',
              )
              await load()
              setStatus('限额已保存')
            })
          }
        >
          保存限额
        </Button>
        <p className="table-muted">
          实际服务尝试可能增加成本；金额未核实。接待额度耗尽后转人工，无人可接待时排队，额度恢复不会自动接回
          AI。
        </p>
      </section>
      <section className="runtime-section">
        <h3>隔离单题测试</h3>
        <p className="table-muted">不创建客户、会话或外发消息。多轮和批量测试另行交付。</p>
        <Select
          value={source}
          onValueChange={(value) => {
            setSource(value)
            setTestId(undefined)
          }}
        >
          <SelectTrigger aria-label="测试配置">
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
        <label className="field" htmlFor="ai-test-question">
          测试问题
          <Textarea
            id="ai-test-question"
            value={question}
            maxLength={8_000}
            onChange={(e) => {
              setQuestion(e.target.value)
              setTestId(undefined)
            }}
          />
        </label>
        <Button
          size="sm"
          disabled={busy || !question.trim()}
          onClick={() =>
            void act(async () => {
              const id = testId ?? crypto.randomUUID()
              setTestId(id)
              setDiagnostics(
                await api<Diagnostics>(`${root}/${memberId}/test`, {
                  id,
                  source: source === 'DRAFT' || source === 'PUBLISHED' ? source : 'VERSION',
                  versionId: source === 'DRAFT' || source === 'PUBLISHED' ? undefined : source,
                  text: question,
                }),
              )
              await load()
            })
          }
        >
          运行测试
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setTestId(undefined)
            setQuestion('')
            setDiagnostics(undefined)
          }}
        >
          新测试
        </Button>
      </section>
      <section className="runtime-section">
        <h3>运行与问题诊断</h3>
        {!runs.length && !tests.length && !loading && <p className="table-muted">暂无运行记录。</p>}
        <div className="ai-operation-list">
          {[
            ...runs.map((r) => ({ ...r, kind: 'LIVE_REPLY' })),
            ...tests.map((r) => ({ ...r, kind: 'TEST' })),
          ]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((run) => (
              <div key={run.id}>
                <span>
                  {label(run.kind)} · {label(run.state)} ·{' '}
                  {new Date(run.createdAt).toLocaleString()}
                  <br />
                  {run.failureCode
                    ? label(run.failureCode)
                    : run.cancellationReason
                      ? label(run.cancellationReason)
                      : ''}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      setDiagnostics(await api<Diagnostics>(`${root}/${run.id}/diagnostics`))
                      setNote('')
                    })
                  }
                >
                  查看诊断
                </Button>
              </div>
            ))}
        </div>
        {nextCursor && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const next = await api<{
                  runs: Run[]
                  tests: Run[]
                  nextCursor: { createdAt: string; id: string } | null
                }>(
                  `${root}/${memberId}/runs?cursor=${encodeURIComponent(JSON.stringify(nextCursor))}`,
                )
                setRuns(next.runs)
                setTests(next.tests)
                setNextCursor(next.nextCursor)
              })
            }
          >
            查看更早记录
          </Button>
        )}
      </section>
      <section className="runtime-section">
        <h3>统计</h3>
        <p className="table-muted">
          按持久 ID 去重。区间左含右不含，日期边界使用
          UTC，按所选时区分日；处理中记录不算成功回复。数据在查询时直接汇总。
        </p>
        <div className="ai-analytics-filters">
          <label className="field" htmlFor="ai-analytics-from">
            起始日期
            <Input
              id="ai-analytics-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="field" htmlFor="ai-analytics-to">
            截止日期（不含）
            <Input
              id="ai-analytics-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <label className="field" htmlFor="ai-analytics-timezone">
            统计时区
            <Input
              id="ai-analytics-timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            />
          </label>
          <Select value={memberFilter} onValueChange={setMemberFilter}>
            <SelectTrigger aria-label="统计成员">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="CURRENT">当前 AI 成员</SelectItem>
              <SelectItem value="ALL">全部成员（含人工）</SelectItem>
            </SelectContent>
          </Select>
          <Select value={versionFilter} onValueChange={setVersionFilter}>
            <SelectTrigger aria-label="统计版本">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部版本</SelectItem>
              {versions.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {new Date(v.publishedAt).toLocaleString()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={busy || !from || !to}
            onClick={() =>
              void act(async () => {
                const query = new URLSearchParams({
                  from: `${from}T00:00:00.000Z`,
                  to: `${to}T00:00:00.000Z`,
                  timezone,
                })
                if (memberFilter === 'CURRENT') query.set('memberId', memberId)
                if (versionFilter !== 'ALL') query.set('versionId', versionFilter)
                setAnalytics(await api<Analytics>(`${root}/analytics?${query}`))
              })
            }
          >
            查询统计
          </Button>
        </div>
        {analytics && (
          <>
            <p>汇总时间：{new Date(analytics.calculatedAt).toLocaleString()}</p>
            {!analytics.runs.length && !analytics.usage.length && !analytics.replies.length && (
              <p>所选区间暂无数据。</p>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>生产消息发送人</TableHead>
                  <TableHead>已提交</TableHead>
                  <TableHead>发送成功</TableHead>
                  <TableHead>发送失败</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {analytics.replies.map((r) => (
                  <TableRow key={r.sender}>
                    <TableCell>{label(r.sender)}</TableCell>
                    <TableCell>{r.replies}</TableCell>
                    <TableCell>{r.sent}</TableCell>
                    <TableCell>{r.failed}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead>生产 AI 状态</TableHead>
                  <TableHead>逻辑运行</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {analytics.runs.map((r) => (
                  <TableRow key={`${r.day}:${r.state}`}>
                    <TableCell>{r.day}</TableCell>
                    <TableCell>{label(r.state)}</TableCell>
                    <TableCell>{r.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>操作类型</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>逻辑操作</TableHead>
                  <TableHead>已扣额度</TableHead>
                  <TableHead>实际调用</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {analytics.usage.map((r) => (
                  <TableRow key={`${r.kind}:${r.state}`}>
                    <TableCell>{label(r.kind)}</TableCell>
                    <TableCell>{label(r.state)}</TableCell>
                    <TableCell>{r.operations}</TableCell>
                    <TableCell>{r.charged}</TableCell>
                    <TableCell>{r.provider_attempts}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </section>
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open && !busy) setPreview(undefined)
        }}
      >
        <DialogContent className="ai-diagnostic-dialog">
          <DialogHeader>
            <DialogTitle>历史版本预览</DialogTitle>
            <DialogDescription>
              还原将覆盖当前草稿（包括未保存的更改），需再次发布才生效。独立规则、工具和客户属性保留当前状态。
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <>
              <SnapshotPreview snapshot={preview.snapshot} />
              {preview.invalidReferences.length > 0 && (
                <p role="alert" className="inline-error">
                  知识库已失效，还原后必须重新选择知识库才能发布。
                </p>
              )}
              <Button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api(`${root}/${memberId}/restore`, { versionId: preview.id })
                    await onRestored()
                    setPreview(undefined)
                    setStatus('历史配置已还原到草稿，运行版本保持不变')
                  })
                }
              >
                还原到草稿
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(diagnostics)}
        onOpenChange={(open) => {
          if (!open) setDiagnostics(undefined)
        }}
      >
        <DialogContent className="ai-diagnostic-dialog">
          <DialogHeader>
            <DialogTitle>AI 运行诊断</DialogTitle>
            <DialogDescription>内容从授权存储读取。反馈不修改知识或配置。</DialogDescription>
          </DialogHeader>
          {diagnostics && (
            <>
              <p>
                {label(diagnostics.run?.state ?? diagnostics.operation?.state ?? '')} · 版本{' '}
                {diagnostics.run?.configVersionId ??
                  diagnostics.operation?.configVersionId ??
                  '草稿或历史记录无版本'}
              </p>
              {diagnostics.run?.failureCode && <p>{label(diagnostics.run.failureCode)}</p>}
              {diagnostics.operation?.failureCode && (
                <p>{label(diagnostics.operation.failureCode)}</p>
              )}
              {diagnostics.run?.cancellationReason && (
                <p>{label(diagnostics.run.cancellationReason)}</p>
              )}
              <h3>输入</h3>
              {diagnostics.history.length > 0 && (
                <details>
                  <summary>本次使用的前文</summary>
                  {diagnostics.history.map((m) => (
                    <p key={m.id}>
                      {m.direction === 'INBOUND' ? '客户' : '客服'}：{m.text}
                    </p>
                  ))}
                </details>
              )}
              {diagnostics.inputs.map((input) => (
                <p key={input.id}>{input.text}</p>
              ))}
              {diagnostics.operation?.input && <p>{diagnostics.operation.input}</p>}
              <h3>结果</h3>
              <pre>
                {diagnostics.output?.text ??
                  diagnostics.operation?.output?.decision?.response ??
                  '未提交客户回复'}
              </pre>
              <details>
                <summary>实际配置</summary>
                <SnapshotPreview
                  snapshot={
                    diagnostics.run?.configSnapshot ?? diagnostics.operation?.snapshot ?? null
                  }
                />
              </details>
              <h3>知识依据</h3>
              {diagnostics.chunks.map((chunk) => (
                <p key={chunk.id}>{chunk.text}</p>
              ))}
              {diagnostics.missingChunkIds.length > 0 && <p>部分知识已删除，无法读取原文。</p>}
              <h3>服务尝试</h3>
              {diagnostics.attempts.map((a) => (
                <p key={a.id}>
                  {a.stage} · {label(a.state)} · {a.httpStatus ?? '无响应'}
                </p>
              ))}
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger aria-label="反馈类型">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MODEL">模型问题</SelectItem>
                  <SelectItem value="KNOWLEDGE">知识问题</SelectItem>
                  <SelectItem value="OTHER">其它问题</SelectItem>
                </SelectContent>
              </Select>
              <label className="field" htmlFor="ai-feedback-note">
                问题说明
                <Textarea
                  id="ai-feedback-note"
                  value={note}
                  maxLength={2_000}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <Button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const id = diagnostics.run?.id ?? diagnostics.operation?.id
                    setDiagnostics(
                      await api<Diagnostics>(`${root}/${id}/feedback`, { category, note }),
                    )
                    setNote('')
                  })
                }
              >
                保存反馈
              </Button>
              {diagnostics.feedback.map((f) => (
                <p key={f.id}>
                  {label(f.category)}：{f.note}
                </p>
              ))}
              {error && (
                <p role="alert" className="inline-error">
                  {error}
                </p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}

function SnapshotPreview({ snapshot }: { snapshot: Record<string, unknown> | null }) {
  if (!snapshot) return <p>历史记录未保存配置快照。</p>
  return (
    <dl className="runtime-details">
      <div>
        <dt>指令</dt>
        <dd>{String(snapshot.instructions ?? '')}</dd>
      </div>
      <div>
        <dt>回复语言</dt>
        <dd>{String(snapshot.responseLanguage ?? '')}</dd>
      </div>
      <div>
        <dt>知识库引用</dt>
        <dd>{String(snapshot.knowledgeBaseId ?? '未设置')}</dd>
      </div>
      {Object.entries({
        handoffOnCustomerRequest: '客户要求人工',
        handoffOnNoKnowledge: '缺少知识',
        handoffOnNegativeSentiment: '负面情绪',
        handoffOnUnableToAnswer: '无法回答',
      }).map(([key, name]) => (
        <div key={key}>
          <dt>{name}时转人工</dt>
          <dd>{snapshot[key] ? '开启' : '关闭'}</dd>
        </div>
      ))}
      <div>
        <dt>转人工关键词</dt>
        <dd>
          {Array.isArray(snapshot.handoffKeywords)
            ? snapshot.handoffKeywords.join('、') || '未设置'
            : '未设置'}
        </dd>
      </div>
    </dl>
  )
}
