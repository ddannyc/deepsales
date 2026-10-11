import { useEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select'
import { Textarea } from './components/ui/textarea'

export type ReplySuggestion = {
  id: string
  inputMessageId: string
  aiMemberId: string
  text: string
  chunkIds: string[]
}

export function ReplySuggestions({
  workspaceId,
  conversationId,
  inputMessageId,
  members,
  disabled,
  onSend,
}: {
  workspaceId: string
  conversationId: string
  inputMessageId?: string
  members: { id: string; displayName: string }[]
  disabled: boolean
  onSend: (suggestion: ReplySuggestion, text: string) => Promise<void>
}) {
  const [aiId, setAiId] = useState('')
  const [result, setResult] = useState<ReplySuggestion>()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [generation, setGeneration] = useState(0)
  const key = JSON.stringify([workspaceId, conversationId, inputMessageId, aiId, generation])
  const request = useRef({ key, id: crypto.randomUUID() })
  if (request.current.key !== key) request.current = { key, id: crypto.randomUUID() }
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!aiId && members.length) setAiId(members[0].id)
  }, [aiId, members])
  const valid = result && result.inputMessageId === inputMessageId && result.aiMemberId === aiId
  async function generate() {
    const startedKey = key
    setBusy(true)
    setError('')
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/conversations/${conversationId}/suggestions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: request.current.id, aiMemberId: aiId }),
        },
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok)
        throw new Error(
          data.error?.code === 'QUOTA_EXHAUSTED'
            ? '额度不足，当前草稿已保留。'
            : data.error?.code === 'OPERATION_PAUSED'
              ? '生成结果未确认，已暂停。当前草稿已保留。'
              : '建议生成失败、客户输入或权限已变化。请检查后重试。',
        )
      if (mounted.current && request.current.key === startedKey) {
        setResult(data.suggestion)
        setText(data.suggestion.text)
      }
    } catch (cause) {
      if (mounted.current && request.current.key === startedKey)
        setError(cause instanceof Error ? cause.message : '生成失败，请重试。')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  function cancel() {
    setResult(undefined)
    setText('')
    setError('')
    setGeneration((value) => value + 1)
  }
  return (
    <section className="message-translation" aria-label="AI 回复建议">
      <div className="message-translation-controls">
        <Select value={aiId} onValueChange={setAiId} disabled={disabled || busy || !members.length}>
          <SelectTrigger aria-label="建议使用的 AI">
            <SelectValue placeholder="选择已发布 AI" />
          </SelectTrigger>
          <SelectContent>
            {members.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy || !aiId || !inputMessageId}
          onClick={() => void generate()}
        >
          {busy ? '处理中…' : '生成回复建议'}
        </Button>
        {(result || busy) && (
          <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={disabled}>
            取消建议
          </Button>
        )}
      </div>
      <p className="field-description">
        使用所选 AI 的已发布配置和知识；建议可编辑，确认后才发送。生成计入工作区用量。
      </p>
      {!members.length && <p className="field-description">需要具有当前渠道权限的已发布 AI。</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {result && !valid && (
        <p className="field-description" role="status">
          客户输入或所选 AI 已变化，旧建议已失效。请重新生成。
        </p>
      )}
      {result && (
        <Textarea
          aria-label="编辑回复建议"
          value={text}
          maxLength={2000}
          disabled={disabled || busy || !valid}
          onChange={(event) => setText(event.target.value)}
        />
      )}
      {valid && (
        <Button
          type="button"
          disabled={disabled || busy || !text.trim()}
          onClick={() => {
            setBusy(true)
            setError('')
            void onSend(result, text)
              .then(() => {
                if (mounted.current) cancel()
              })
              .catch(() => {
                if (mounted.current)
                  setError('发送未确认成功或建议已失效，内容已保留。请检查后重试。')
              })
              .finally(() => {
                if (mounted.current) setBusy(false)
              })
          }}
        >
          确认发送建议
        </Button>
      )}
    </section>
  )
}
