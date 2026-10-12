import { useCallback, useEffect, useId, useRef, useState } from 'react'
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
import { Input } from './components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select'
import { StatusBadge } from './components/ui/status-badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './components/ui/table'
import { Textarea } from './components/ui/textarea'

type QuestionSet = { id: string; name: string; questions: string[]; revision: number }
type Batch = {
  id: string
  name: string
  source: string
  configVersionId: string | null
  snapshot: { instructions: string; responseLanguage: string }
  createdAt: string
  cancelledAt: string | null
}
type Item = {
  id: string
  position: number
  text: string
  state: string
  attempt: number
  retryAt: string | null
  charged: boolean
  failureCode: string | null
  chunkIds: string[] | null
  output: { kind?: string; decision?: { response?: string } } | null
}
type Result = { batch: Batch; items: Item[] }
const states: Record<string, string> = {
  QUEUED: '待执行',
  RUNNING: '执行中',
  COMPLETED: '已完成',
  FAILED: '失败',
  UNKNOWN: '结果不明，已暂停',
  CANCELLED: '已取消',
}
const failures: Record<string, string> = {
  QUOTA_EXHAUSTED: '额度不足',
  INVALID_OUTPUT: '模型输出无效',
  AI_PROVIDER_ERROR: '服务调用失败',
  OPERATION_PAUSED: '调用结果不明',
  INVALID_CONFIGURATION: '配置或权限已变化',
}

export function AiBatchTests({
  workspaceId,
  memberId,
  versions,
  request,
  onInspect,
  onUpdated,
}: {
  workspaceId: string
  memberId: string
  versions: { id: string; publishedAt: string }[]
  request: <T>(url: string, body?: unknown, method?: string) => Promise<T>
  onInspect: (id: string) => void
  onUpdated: () => Promise<void>
}) {
  const root = `/api/workspaces/${workspaceId}/ai-operations/${memberId}`
  const storageKey = `ai-batch:${workspaceId}:${memberId}`
  const prefix = useId()
  const [sets, setSets] = useState<QuestionSet[]>([])
  const [setId, setSetId] = useState('NEW')
  const [name, setName] = useState('')
  const [questions, setQuestions] = useState('')
  const [source, setSource] = useState('DRAFT')
  const [batches, setBatches] = useState<Batch[]>([])
  const [result, setResult] = useState<Result>()
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const epoch = useRef(0)
  const activeId = useRef<string | undefined>(undefined)
  const setRequestId = useRef(crypto.randomUUID())
  const batchRequestId = useRef(crypto.randomUUID())
  const selected = sets.find((s) => s.id === setId)
  const list = questions
    .split('\n')
    .map((q) => q.trim())
    .filter(Boolean)
  const dirty =
    selected &&
    (selected.name !== name || JSON.stringify(selected.questions) !== JSON.stringify(list))
  const refresh = useCallback(async () => {
    const [data, history] = await Promise.all([
      request<{ sets: QuestionSet[] }>(`${root}/question-sets`),
      request<{ batches: Batch[] }>(`${root}/batches`),
    ])
    setSets(data.sets)
    setBatches(history.batches)
  }, [root, request])
  useEffect(() => {
    let disposed = false
    const saved = sessionStorage.getItem(storageKey)
    setLoading(true)
    void Promise.all([
      refresh(),
      saved ? request<Result>(`${root}/batches/${saved}`) : Promise.resolve(undefined),
    ])
      .then(([, restored]) => {
        if (!disposed && restored) {
          activeId.current = restored.batch.id
          setResult(restored)
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
  }, [refresh, root, storageKey, request])
  function selectSet(id: string) {
    const selected = sets.find((s) => s.id === id)
    setSetId(id)
    setName(selected?.name ?? '')
    setQuestions(selected?.questions.join('\n') ?? '')
    setRequestId.current = crypto.randomUUID()
    batchRequestId.current = crypto.randomUUID()
  }
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
  async function openBatch(id: string) {
    epoch.current++
    activeId.current = id
    setBusy(false)
    const data = await request<Result>(`${root}/batches/${id}`)
    if (activeId.current === id) {
      setResult(data)
      sessionStorage.setItem(storageKey, id)
    }
  }
  async function run(only?: Item) {
    if (!result) return
    const id = result.batch.id,
      started = ++epoch.current
    setBusy(true)
    setError('')
    setStatus('')
    let current = result
    try {
      while (started === epoch.current && activeId.current === id) {
        const item =
          only ??
          current.items.find((i) => i.state === 'RUNNING') ??
          (!current.batch.cancelledAt ? current.items.find((i) => i.state === 'QUEUED') : undefined)
        if (!item) break
        current = await request<Result>(`${root}/batches/${id}/execute`, {
          itemId: item.id,
          attempt: item.attempt,
        })
        if (started !== epoch.current || activeId.current !== id) break
        setResult(current)
        const finished = current.items.find((i) => i.id === item.id)
        if (only || finished?.state === 'UNKNOWN' || finished?.failureCode === 'QUOTA_EXHAUSTED')
          break
      }
      if (started === epoch.current) {
        setStatus('当前执行已结束。可查看结果或独立恢复失败题。')
        await onUpdated()
      }
    } catch (cause) {
      if (started === epoch.current) {
        setError((cause as Error).message)
        const recovered = await request<Result>(`${root}/batches/${id}`).catch(() => undefined)
        if (recovered && started === epoch.current) setResult(recovered)
      }
    } finally {
      if (started === epoch.current) setBusy(false)
    }
  }
  return (
    <section className="runtime-section" aria-label="AI 批量问题测试">
      <div className="section-heading">
        <h3>批量问题测试</h3>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || loading}
          onClick={() => void act(refresh)}
        >
          刷新批量记录
        </Button>
      </div>
      <p className="field-description">
        每批最多 100
        题，串行执行且逐题计入逻辑用量。每题独立上下文，不自动评分；不会修改客户、分配或发送消息。
      </p>
      {loading && <p role="status">正在读取问题集和批次…</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      <label className="field" htmlFor={`${prefix}-set`}>
        问题集
      </label>
      <Select value={setId} onValueChange={selectSet} disabled={busy || loading}>
        <SelectTrigger id={`${prefix}-set`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="NEW">新建问题集</SelectItem>
          {sets.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <label className="field" htmlFor={`${prefix}-name`}>
        问题集名称
      </label>
      <Input
        id={`${prefix}-name`}
        value={name}
        maxLength={100}
        disabled={busy}
        onChange={(e) => {
          setName(e.target.value)
          setRequestId.current = crypto.randomUUID()
        }}
      />
      <label className="field" htmlFor={`${prefix}-questions`}>
        测试问题，每行一题
      </label>
      <Textarea
        id={`${prefix}-questions`}
        value={questions}
        disabled={busy}
        onChange={(e) => {
          setQuestions(e.target.value)
          setRequestId.current = crypto.randomUUID()
        }}
      />
      <p className="field-description">
        {list.length}/100 题；每题最多 8,000 字符。请使用中性验收内容。已有批次保留创建时的题目。
      </p>
      <div className="message-translation-controls">
        <Button
          size="sm"
          variant="outline"
          disabled={
            busy ||
            !name.trim() ||
            !list.length ||
            list.length > 100 ||
            list.some((q) => q.length > 8000)
          }
          onClick={() =>
            void act(async () => {
              const data = await request<{ set: QuestionSet }>(`${root}/question-sets`, {
                id: selected?.id ?? setRequestId.current,
                revision: selected?.revision,
                name,
                questions: list,
              })
              await refresh()
              setSetId(data.set.id)
              batchRequestId.current = crypto.randomUUID()
              setStatus('问题集已保存。')
            })
          }
        >
          保存问题集
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !selected}
          onClick={() => setDeleting(true)}
        >
          删除问题集
        </Button>
      </div>
      <label className="field" htmlFor={`${prefix}-source`}>
        批量测试配置
      </label>
      <Select
        value={source}
        onValueChange={(v) => {
          setSource(v)
          batchRequestId.current = crypto.randomUUID()
        }}
        disabled={busy}
      >
        <SelectTrigger id={`${prefix}-source`}>
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
      <p className="field-description">
        创建时冻结主配置和问题；独立规则及知识资料仍按当前权限校验。未保存的配置编辑不会参与测试。
      </p>
      {dirty && <p role="status">问题集有未保存修改，请先保存。</p>}
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !selected || Boolean(dirty)}
        onClick={() =>
          void act(async () => {
            const data = await request<{ batch: Batch }>(`${root}/batches`, {
              id: batchRequestId.current,
              questionSetId: selected?.id,
              source: ['DRAFT', 'PUBLISHED'].includes(source) ? source : 'VERSION',
              versionId: ['DRAFT', 'PUBLISHED'].includes(source) ? undefined : source,
            })
            await openBatch(data.batch.id)
            await refresh()
            batchRequestId.current = crypto.randomUUID()
            setStatus('批次已创建，尚未调用模型。')
          })
        }
      >
        创建批次
      </Button>
      <label className="field" htmlFor={`${prefix}-batch`}>
        查看批次
      </label>
      <Select
        value={result?.batch.id ?? 'NONE'}
        onValueChange={(id) => void act(() => openBatch(id))}
        disabled={cancelling || !batches.length}
      >
        <SelectTrigger id={`${prefix}-batch`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="NONE" disabled>
            选择批次
          </SelectItem>
          {batches.map((b) => (
            <SelectItem key={b.id} value={b.id}>
              {b.name} · {new Date(b.createdAt).toLocaleString()}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {result && (
        <>
          <p role="status">
            固定配置：
            {result.batch.source === 'DRAFT'
              ? '已保存草稿快照'
              : `发布版本 ${result.batch.configVersionId}`}{' '}
            · 输出语言：{result.batch.snapshot.responseLanguage} ·{' '}
            {result.batch.cancelledAt
              ? '批次已取消，运行中题目仍可能完成'
              : `${result.items.filter((i) => i.state === 'COMPLETED').length}/${result.items.length} 已完成`}
          </p>
          <details>
            <summary>查看固定配置指令</summary>
            <p className="ai-test-output">{result.batch.snapshot.instructions}</p>
          </details>
          <div className="message-translation-controls">
            <Button
              size="sm"
              disabled={
                busy ||
                cancelling ||
                result.items.some((i) => i.state === 'UNKNOWN') ||
                !result.items.some(
                  (i) =>
                    i.state === 'RUNNING' || (!result.batch.cancelledAt && i.state === 'QUEUED'),
                )
              }
              onClick={() => void run()}
            >
              {busy ? '执行中…' : '执行或恢复批次'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={cancelling || Boolean(result.batch.cancelledAt)}
              onClick={() => {
                const id = result.batch.id
                epoch.current++
                setBusy(false)
                setCancelling(true)
                setError('')
                void request<Result>(`${root}/batches/${id}/cancel`, {})
                  .then((data) => {
                    if (activeId.current === id) {
                      setResult(data)
                      setStatus('未开始题已取消；已开始的调用仍计入用量。')
                    }
                  })
                  .catch((cause: Error) => setError(cause.message))
                  .finally(() => setCancelling(false))
              }}
            >
              {cancelling ? '取消中…' : '取消未开始题'}
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>问题</TableHead>
                <TableHead>回答与依据</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>逻辑用量</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="whitespace-normal break-words max-w-sm">
                    {i.position + 1}. {i.text}
                  </TableCell>
                  <TableCell className="whitespace-normal break-words max-w-sm">
                    <p>{i.output?.decision?.response ?? '暂无回答'}</p>
                    <p className="table-muted">
                      {i.output?.kind === 'HANDOFF' ? '模拟转人工 · ' : ''}
                      {i.chunkIds?.length ?? 0} 条检索依据
                    </p>
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      tone={
                        i.state === 'COMPLETED'
                          ? 'success'
                          : i.state === 'FAILED' || i.state === 'UNKNOWN'
                            ? 'destructive'
                            : 'neutral'
                      }
                    >
                      {states[i.state]}
                    </StatusBadge>
                    {i.failureCode && <p>{failures[i.failureCode] ?? '测试未完成'}</p>}
                    {i.retryAt && (
                      <p className="table-muted">
                        最早重试：{new Date(i.retryAt).toLocaleString()}
                      </p>
                    )}
                  </TableCell>
                  <TableCell>
                    {i.charged ? '1' : '0'} · {i.attempt}/3 次执行
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!i.attempt}
                      onClick={() => onInspect(i.id)}
                    >
                      查看依据与诊断
                    </Button>
                    {i.state === 'FAILED' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          busy ||
                          cancelling ||
                          i.attempt >= 3 ||
                          result.items.some((item) => item.state === 'UNKNOWN')
                        }
                        onClick={() => void run(i)}
                      >
                        重试此题
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除问题集？</AlertDialogTitle>
            <AlertDialogDescription>已有批次的题目和结果会保留。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>保留</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                void act(async () => {
                  if (!selected) return
                  await request(
                    `${root}/question-sets`,
                    { id: selected.id, revision: selected.revision },
                    'DELETE',
                  )
                  selectSet('NEW')
                  await refresh()
                  setStatus('问题集已删除，历史批次保留。')
                })
              }
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
