import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button } from './components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select'
import { StatusBadge } from './components/ui/status-badge'
import { Textarea } from './components/ui/textarea'

type Setup = {
  memberActive: boolean
  providerReady: boolean
  knowledgeBaseId: string | null
  readyDocuments: number
  channels: { id: string; name: string }[]
}
type Candidate = { id: string; sourceInstructions: string; instructions: string }

export function AiSetupGuide({
  workspaceId,
  memberId,
  instructions,
  responseLanguage,
  knowledgeBaseId,
  draftDirty,
  disabled,
  onApply,
}: {
  workspaceId: string
  memberId: string
  instructions: string
  responseLanguage: string
  knowledgeBaseId: string | null
  draftDirty: boolean
  disabled: boolean
  onApply: (source: string, candidate: string) => void
}) {
  const root = `/api/workspaces/${workspaceId}/ai-operations/${memberId}`
  const prefix = useId()
  const [setup, setSetup] = useState<Setup>()
  const [loading, setLoading] = useState(false)
  const [brief, setBrief] = useState('')
  const [mode, setMode] = useState('GENERATE')
  const [candidate, setCandidate] = useState<Candidate & { key: string }>()
  const [edited, setEdited] = useState('')
  const [generation, setGeneration] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const mounted = useRef(true)
  const loadEpoch = useRef(0)
  const key = JSON.stringify([root, brief, mode, instructions, generation])
  const request = useRef({ key, id: crypto.randomUUID() })
  if (request.current.key !== key) request.current = { key, id: crypto.randomUUID() }
  const refresh = useCallback(async () => {
    const epoch = ++loadEpoch.current
    setLoading(true)
    try {
      const response = await fetch(`${root}/setup`)
      if (!response.ok) throw new Error('引导状态读取失败，请刷新后重试。')
      const data = (await response.json()) as Setup
      if (mounted.current && epoch === loadEpoch.current) setSetup(data)
    } catch (cause) {
      if (mounted.current && epoch === loadEpoch.current) setError((cause as Error).message)
    } finally {
      if (mounted.current && epoch === loadEpoch.current) setLoading(false)
    }
  }, [root])
  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      loadEpoch.current++
    }
  }, [refresh])
  function cancel() {
    setGeneration((value) => value + 1)
    setCandidate(undefined)
    setEdited('')
    setStatus('候选已取消，草稿和运行配置未改变。已开始的生成仍计入用量。')
  }
  async function generate() {
    const started = request.current
    setBusy(true)
    setError('')
    setStatus('')
    try {
      const response = await fetch(`${root}/persona`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: started.id, mode, brief, sourceInstructions: instructions }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok)
        throw new Error(
          data.error?.code === 'QUOTA_EXHAUSTED'
            ? '本月额度已耗尽，当前草稿已保留。'
            : data.error?.code === 'OPERATION_PAUSED'
              ? '生成结果不明，已暂停；当前草稿已保留。'
              : data.error?.code === 'RETRY_LATER'
                ? '请等待服务重试间隔，当前草稿已保留。'
                : '人设生成失败或权限已变化，当前草稿已保留。请检查后重试。',
        )
      if (mounted.current && request.current.key === started.key) {
        setCandidate({ ...data.candidate, key: started.key })
        setEdited(data.candidate.instructions)
      }
    } catch (cause) {
      if (mounted.current && request.current.key === started.key) setError((cause as Error).message)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const valid = candidate?.key === key
  const checks = [
    {
      name: '指令与回复语言',
      ready: Boolean(instructions.trim() && responseLanguage.trim()),
      detail: '继续编辑下方已有草稿，或生成候选后比较采用。',
      href: '#ai-instructions',
    },
    {
      name: '知识资料',
      ready: Boolean(
        knowledgeBaseId && setup?.knowledgeBaseId === knowledgeBaseId && setup.readyDocuments > 0,
      ),
      detail:
        knowledgeBaseId !== setup?.knowledgeBaseId
          ? '所选知识库尚未保存；保存草稿后刷新引导。'
          : '选择知识库，并在知识库页面准备可用资料。',
      href: '/knowledge',
    },
    {
      name: '渠道权限',
      ready: Boolean(setup?.channels.length),
      detail: setup?.channels.length
        ? `已授权：${setup.channels.map((c) => c.name).join('、')}。实际渠道连接仍需检查。`
        : '在团队成员设置授予渠道权限，并在 Facebook 设置检查连接。',
      href: '/team',
    },
    {
      name: 'AI 服务与成员状态',
      ready: Boolean(setup?.providerReady && setup.memberActive),
      detail: '成员需启用；服务未就绪时请联系站点管理员。',
      href: '/team',
    },
  ]
  return (
    <section className="ai-config-section" aria-label="AI 配置引导">
      <div className="section-heading">
        <h2>配置引导</h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => {
            setError('')
            void refresh()
          }}
        >
          刷新引导
        </Button>
      </div>
      <p>已有草稿会继续保留。先完成配置、知识和渠道权限，再保存草稿、测试并明确发布。</p>
      {loading && <p role="status">正在检查配置…</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      <ul>
        {checks.map((check) => (
          <li key={check.name}>
            <StatusBadge tone={check.ready ? 'success' : 'warning'}>
              {check.ready ? '已就绪' : '需补齐'}
            </StatusBadge>{' '}
            {check.name} · {check.detail} <a href={check.href}>前往检查</a>
          </li>
        ))}
      </ul>
      <p className="field-description">
        {draftDirty
          ? '有未保存的更改，先点击“保存草稿”。'
          : '测试使用已保存配置，已有测试会话保留启动时的快照。修改配置后请清空测试。'}{' '}
        <a href={`#ai-test-bench-${memberId}`}>前往多轮测试台</a>
        ；确认结果后点击页面上方“发布”，才影响线上接待。
      </p>
      <label className="field" htmlFor={`${prefix}-mode`}>
        人设操作
      </label>
      <Select value={mode} onValueChange={setMode} disabled={busy || disabled}>
        <SelectTrigger id={`${prefix}-mode`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="GENERATE">生成人设草稿</SelectItem>
          <SelectItem value="OPTIMIZE">优化当前指令</SelectItem>
        </SelectContent>
      </Select>
      <label className="field" htmlFor={`${prefix}-brief`}>
        接待职责与语气
      </label>
      <Textarea
        id={`${prefix}-brief`}
        value={brief}
        maxLength={2000}
        disabled={busy || disabled}
        onChange={(e) => setBrief(e.target.value)}
      />
      <p className="field-description">
        描述希望 AI
        如何接待；不会生成专属转人工规则或授权新工具。生成计入工作区用量，取消不会撤回已开始的调用。
      </p>
      <div className="message-translation-controls">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={
            busy ||
            disabled ||
            !setup?.providerReady ||
            !setup.memberActive ||
            !brief.trim() ||
            (mode === 'OPTIMIZE' && !instructions.trim())
          }
          onClick={() => void generate()}
        >
          {busy ? '正在生成…' : '生成候选'}
        </Button>
        {(busy || candidate) && (
          <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={cancel}>
            取消候选
          </Button>
        )}
      </div>
      {candidate && (
        <>
          <label className="field" htmlFor={`${prefix}-original`}>
            生成时的原指令
          </label>
          <Textarea id={`${prefix}-original`} value={candidate.sourceInstructions} readOnly />
          <label className="field" htmlFor={`${prefix}-candidate`}>
            编辑人设候选
          </label>
          <Textarea
            id={`${prefix}-candidate`}
            value={edited}
            maxLength={20000}
            disabled={disabled || busy || !valid}
            onChange={(e) => setEdited(e.target.value)}
          />
          {!valid && <p role="status">原指令或生成需求已变化，旧候选失效。请重新生成。</p>}
          <Button
            type="button"
            size="sm"
            disabled={disabled || busy || !valid || !edited.trim()}
            onClick={() => {
              onApply(candidate.sourceInstructions, edited)
              setCandidate(undefined)
              setEdited('')
              setGeneration((value) => value + 1)
              setStatus('已采用到本地草稿；请保存，再测试并明确发布。')
            }}
          >
            采用到草稿
          </Button>
        </>
      )}
    </section>
  )
}
