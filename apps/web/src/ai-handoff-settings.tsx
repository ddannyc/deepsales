import { useCallback, useEffect, useState } from 'react'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import { Checkbox } from './components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select'
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
import type { AiStopCondition } from './ai-stop-settings'

export type HandoffCondition =
  | Exclude<AiStopCondition, { kind: 'REPLIES' }>
  | { kind: 'SEMANTIC'; text: string }
export type HandoffRule = {
  id: string
  revision: number
  name: string
  enabled: boolean
  condition: HandoffCondition
}
type Options = {
  properties: { id: string; name: string; type: string; options: string[] }[]
  tags: { id: string; name: string }[]
}
const newRule = () => ({
  name: '',
  enabled: true,
  condition: { kind: 'SEMANTIC' as const, text: '' },
})

export function AiHandoffSettings({
  workspaceId,
  memberId,
}: {
  workspaceId: string
  memberId: string
}) {
  const root = `/api/workspaces/${workspaceId}/ai-operations/${memberId}/handoff-rules`
  const [rules, setRules] = useState<HandoffRule[]>([])
  const [options, setOptions] = useState<Options>()
  const [draft, setDraft] = useState<{
    id?: string
    revision?: number
    name: string
    enabled: boolean
    condition: HandoffCondition
  }>(newRule)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [deleting, setDeleting] = useState<HandoffRule>()
  const load = useCallback(async () => {
    const [r, d] = await Promise.all([
      fetch(root),
      fetch(`/api/workspaces/${workspaceId}/inbox-filter-options`),
    ])
    if (!r.ok || !d.ok) throw new Error('读取条件失败，请重新加载。')
    const [data, definitions] = await Promise.all([r.json(), d.json()])
    return { rules: data.rules as HandoffRule[], options: definitions as Options }
  }, [root, workspaceId])
  useEffect(() => {
    let cancelled = false
    setOptions(undefined)
    setError('')
    void load()
      .then((data) => {
        if (!cancelled) {
          setRules(data.rules)
          setOptions(data.options)
          setDraft(newRule())
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [load])
  async function mutate(body: unknown, id?: string, remove = false, saveDraft = false) {
    setBusy(true)
    setError('')
    setFeedback('')
    try {
      const response = await fetch(`${root}${id ? `/${id}` : ''}`, {
        method: remove ? 'DELETE' : id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error('操作失败；条件可能已变化或引用已失效。请重新加载后修复。')
      const data = await load()
      setRules(data.rules)
      setOptions(data.options)
      if (saveDraft) setDraft(newRule())
      setDeleting(undefined)
      setFeedback(remove ? '条件已删除，立即生效' : '条件已保存，立即生效')
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请重试。')
    } finally {
      setBusy(false)
    }
  }
  const c = draft.condition
  const definition =
    c.kind === 'PROPERTY' ? options?.properties.find((p) => p.id === c.definitionId) : undefined
  return (
    <section className="ai-config-section" aria-labelledby="ai-custom-handoff-title">
      <div className="section-heading">
        <div>
          <h2 id="ai-custom-handoff-title">自定义转人工条件</h2>
          <p>
            独立条件保存、启停和删除立即生效，不需要发布；历史还原不会回滚。任一条件匹配即按既有人工分配规则转接，无可用人工时排队。
          </p>
        </div>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {feedback && <p role="status">{feedback}</p>}
      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          setError('')
          void load()
            .then((d) => {
              setRules(d.rules)
              setOptions(d.options)
            })
            .catch((e) => setError(e.message))
        }}
      >
        重新加载条件
      </Button>
      {!options && !error && <p role="status">正在加载条件…</p>}
      {rules.map((r) => (
        <div className="form-grid-two" key={r.id}>
          <span>
            {r.name} · {r.enabled ? '启用' : '停用'} · 修订 {r.revision}
          </span>
          <div className="settings-actions">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDraft(r)
                setFeedback('')
              }}
            >
              编辑 {r.name}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void mutate(
                  {
                    name: r.name,
                    enabled: !r.enabled,
                    condition: r.condition,
                    revision: r.revision,
                  },
                  r.id,
                )
              }
            >
              {r.enabled ? '停用' : '启用'} {r.name}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setDeleting(r)}>
              删除 {r.name}
            </Button>
          </div>
        </div>
      ))}
      {options && (
        <fieldset disabled={busy}>
          <legend>{draft.id ? '编辑条件' : '新增条件'}</legend>
          <label className="form-field" htmlFor="handoff-rule-name">
            <span>转人工条件名称</span>
            <Input
              id="handoff-rule-name"
              maxLength={100}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <Select
            disabled={busy}
            value={
              c.kind === 'SEMANTIC'
                ? 'SEMANTIC'
                : c.kind === 'TAG'
                  ? `tag:${c.tagId}`
                  : `property:${c.definitionId}`
            }
            onValueChange={(v) => {
              const condition: HandoffCondition =
                v === 'SEMANTIC'
                  ? { kind: 'SEMANTIC', text: '' }
                  : v.startsWith('tag:')
                    ? { kind: 'TAG', tagId: v.slice(4) }
                    : {
                        kind: 'PROPERTY',
                        definitionId: v.slice(9),
                        value:
                          options.properties.find((p) => p.id === v.slice(9))?.type === 'NUMBER'
                            ? 0
                            : (options.properties.find((p) => p.id === v.slice(9))?.options[0] ??
                              ''),
                      }
              setDraft({ ...draft, condition })
            }}
          >
            <SelectTrigger aria-label="自定义转人工条件类型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="SEMANTIC">自然语义条件</SelectItem>
              {options.properties.map((p) => (
                <SelectItem key={p.id} value={`property:${p.id}`}>
                  属性：{p.name} 等于
                </SelectItem>
              ))}
              {options.tags.map((p) => (
                <SelectItem key={p.id} value={`tag:${p.id}`}>
                  标签：{p.name}
                </SelectItem>
              ))}
              {c.kind === 'PROPERTY' && !definition && (
                <SelectItem value={`property:${c.definitionId}`}>
                  属性已失效，请修复或停用
                </SelectItem>
              )}
              {c.kind === 'TAG' && !options.tags.some((t) => t.id === c.tagId) && (
                <SelectItem value={`tag:${c.tagId}`}>标签已失效，请修复或停用</SelectItem>
              )}
            </SelectContent>
          </Select>
          {c.kind === 'SEMANTIC' ? (
            <label className="form-field" htmlFor="handoff-rule-text">
              <span>自然语义条件</span>
              <Textarea
                id="handoff-rule-text"
                maxLength={4000}
                value={c.text}
                onChange={(e) => setDraft({ ...draft, condition: { ...c, text: e.target.value } })}
              />
            </label>
          ) : c.kind === 'PROPERTY' ? (
            definition?.type === 'OPTION' ? (
              <Select
                value={String(c.value)}
                onValueChange={(value) => setDraft({ ...draft, condition: { ...c, value } })}
              >
                <SelectTrigger aria-label="转人工属性值">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {definition.options.map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <label className="form-field" htmlFor="handoff-property-value">
                <span>转人工属性值</span>
                <Input
                  id="handoff-property-value"
                  type={definition?.type === 'NUMBER' ? 'number' : 'text'}
                  value={c.value}
                  maxLength={2000}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      condition: {
                        ...c,
                        value:
                          definition?.type === 'NUMBER' ? Number(e.target.value) : e.target.value,
                      },
                    })
                  }
                />
              </label>
            )
          ) : (
            <p>已添加此标签时匹配；只使用 AI 有权读取的来源。</p>
          )}
          <label className="checkbox-field" htmlFor="handoff-rule-enabled">
            <Checkbox
              id="handoff-rule-enabled"
              disabled={busy}
              checked={draft.enabled}
              onCheckedChange={(enabled) => setDraft({ ...draft, enabled: enabled === true })}
            />
            启用此条件
          </label>
          <div className="settings-actions">
            <Button
              type="button"
              disabled={busy || !draft.name.trim()}
              onClick={() =>
                void mutate(
                  {
                    name: draft.name,
                    enabled: draft.enabled,
                    condition: draft.condition,
                    ...(draft.id ? { revision: draft.revision } : {}),
                  },
                  draft.id,
                  false,
                  true,
                )
              }
            >
              保存转人工条件
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setDraft(newRule())}
            >
              取消条件编辑
            </Button>
          </div>
        </fieldset>
      )}
      <p className="field-description">
        属性按类型精确匹配，标签按是否添加匹配；缺失和不可见资料不匹配。自然语义条件会使用模型判断并计入接待用量。测试仅模拟转人工，不会真实分配或发送。
      </p>
      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除转人工条件？</AlertDialogTitle>
            <AlertDialogDescription>
              删除立即生效，不能通过 AI 历史还原恢复此条件。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (deleting) void mutate({ revision: deleting.revision }, deleting.id, true)
              }}
            >
              确认删除条件
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
