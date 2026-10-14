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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select'
import { Switch } from './components/ui/switch'
import { Textarea } from './components/ui/textarea'

type Rule = {
  id: string
  revision: number
  definitionId: string
  instructions: string
  enabled: boolean
}
type Definition = { id: string; name: string; level: string; type: string }
export function AiPropertySettings({
  workspaceId,
  memberId,
  kind = 'property',
}: {
  workspaceId: string
  memberId: string
  kind?: 'property' | 'tag'
}) {
  const noun = kind === 'tag' ? '标签追加' : '属性采集'
  const action = kind === 'tag' ? '追加' : '采集'
  const field = kind === 'tag' ? '标签' : '属性'
  const root = `/api/workspaces/${workspaceId}/ai-operations/${memberId}/${kind}-rules`
  const prefix = useId()
  const loadRequest = useRef(0)
  const [rules, setRules] = useState<Rule[]>([])
  const [definitions, setDefinitions] = useState<Definition[]>()
  const [draft, setDraft] = useState<Partial<Rule>>({ instructions: '', enabled: true })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [deleting, setDeleting] = useState<Rule>()
  const load = useCallback(async () => {
    const request = ++loadRequest.current
    const [r, d] = await Promise.all([
      fetch(root),
      fetch(`/api/workspaces/${workspaceId}/inbox-filter-options`),
    ])
    if (!r.ok || !d.ok) throw new Error('读取属性采集失败，请重新加载。')
    const [data, options] = await Promise.all([r.json(), d.json()])
    if (request !== loadRequest.current) return
    setRules(data.rules)
    setDefinitions(kind === 'tag' ? options.tags : options.properties)
  }, [root, workspaceId, kind])
  useEffect(() => {
    void load().catch((e) => setError(e.message))
    return () => {
      loadRequest.current++
    }
  }, [load])
  async function save(rule: Partial<Rule>, remove = false) {
    setBusy(true)
    setError('')
    setStatus('')
    try {
      const response = await fetch(root, {
        method: remove ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          remove
            ? { id: rule.id, revision: rule.revision }
            : {
                id: rule.id ?? crypto.randomUUID(),
                revision: rule.revision,
                definitionId: rule.definitionId,
                instructions: rule.instructions,
                enabled: rule.enabled,
              },
        ),
      })
      if (!response.ok) throw new Error('保存失败，规则或属性可能已变化。请重新加载后重试。')
      await load()
      if (rule === draft && !remove) setDraft({ instructions: '', enabled: true })
      setDeleting(undefined)
      setStatus(remove ? '采集规则已删除，立即生效。' : '采集规则已保存，立即生效。')
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请重试。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label={`AI ${noun}`} className="ai-config-section">
      <h2>AI {noun}</h2>
      <p className="field-description">
        {kind === 'tag'
          ? '功能开关发布后生效；规则保存、启停和删除立即生效。仅追加已有授权标签，人工较新决定受保护。'
          : '独立规则保存、启停和删除立即生效，不随主配置历史还原。每个 AI 最多 20 个受控字段，复用回复生成；人工值仅在明确允许自动更新后可覆盖，属性与长期摘要分别管理。'}
      </p>
      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        onClick={() => void load().catch((e) => setError(e.message))}
      >
        重新加载采集规则
      </Button>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      {!definitions ? (
        <p role="status">正在读取属性…</p>
      ) : (
        <>
          {!rules.length && (
            <p>
              暂无{action}规则。先在客户资料中定义{field}，再选择授权对象。
            </p>
          )}
          {rules.map((rule) => (
            <div className="runtime-panel" key={rule.id}>
              <strong>
                {definitions.find((d) => d.id === rule.definitionId)?.name ?? '属性已失效'}
              </strong>
              <Switch
                aria-label={`启用${action} ${definitions.find((d) => d.id === rule.definitionId)?.name ?? '失效定义'}`}
                checked={rule.enabled}
                disabled={busy}
                onCheckedChange={(enabled) => void save({ ...rule, enabled })}
              />
              <p>{rule.instructions}</p>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setDraft(rule)}
              >
                编辑{action}规则
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setDeleting(rule)}
              >
                删除{action}规则
              </Button>
            </div>
          ))}
          <form
            className="dialog-form"
            onSubmit={(e) => {
              e.preventDefault()
              void save(draft)
            }}
          >
            <label htmlFor={`${prefix}-field`}>{kind === 'tag' ? '追加标签' : '采集属性'}</label>
            <Select
              value={draft.definitionId ?? ''}
              onValueChange={(definitionId) => setDraft((d) => ({ ...d, definitionId }))}
              disabled={busy}
            >
              <SelectTrigger id={`${prefix}-field`}>
                <SelectValue placeholder="选择已有属性" />
              </SelectTrigger>
              <SelectContent>
                {definitions.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name} · {d.level === 'CUSTOMER' ? '客户级' : '会话级'} ·{' '}
                    {d.type === 'NUMBER' ? '数字' : d.type === 'OPTION' ? '选项' : '文本'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label htmlFor={`${prefix}-instructions`}>{action}说明</label>
            <Textarea
              id={`${prefix}-instructions`}
              value={draft.instructions ?? ''}
              required
              maxLength={2000}
              disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, instructions: e.target.value }))}
            />
            <Button type="submit" disabled={busy || !draft.definitionId}>
              {busy ? '正在保存…' : `保存${action}规则`}
            </Button>
            {draft.id && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setDraft({ instructions: '', enabled: true })}
              >
                取消编辑采集
              </Button>
            )}
          </form>
        </>
      )}
      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除采集规则？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后立即停止该字段的自动采集，已有属性值和历史保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>保留规则</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault()
                if (deleting) void save(deleting, true)
              }}
            >
              确认删除采集规则
            </AlertDialogAction>
          </AlertDialogFooter>
          {error && <p role="alert">{error}</p>}
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
