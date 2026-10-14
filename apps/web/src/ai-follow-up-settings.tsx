import { useEffect, useState } from 'react'
import { Button } from '#components/ui/button'
import { Input } from '#components/ui/input'
import { Switch } from '#components/ui/switch'
import { Textarea } from '#components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '#components/ui/alert-dialog'
import { AiStopSettings, emptyStopRules, type AiStopCondition } from './ai-stop-settings'

type Rule = {
  id: string
  revision?: number
  name: string
  enabled: boolean
  timer: 'LAST_AI_REPLY' | 'AI_ASSIGNMENT'
  delaySeconds: number
  instructions: string
  groups: AiStopCondition[][]
}
type Event = {
  id: string
  ruleId: string
  conversationId: string
  triggeredAt: string
  state: string
  failureCode: string | null
  operationState: string | null
  outputMessageId: string | null
  deliveryState: string | null
  deliveryFailureCode: string | null
}
const fresh = (): Rule => ({
  id: crypto.randomUUID(),
  name: '',
  enabled: false,
  timer: 'LAST_AI_REPLY',
  delaySeconds: 300,
  instructions: '',
  groups: [],
})
const states: Record<string, string> = {
  QUEUED: '等待执行',
  GENERATING: '生成中',
  COMPLETED: '已提交，送达状态见会话',
  FAILED: '失败',
  CANCELLED: '已取消',
  HANDOFF: '已转人工',
  SKIPPED: '已跳过',
}
export function AiFollowUpSettings({
  workspaceId,
  memberId,
}: {
  workspaceId: string
  memberId: string
}) {
  const root = `/api/workspaces/${workspaceId}/ai-operations/${memberId}/follow-ups`
  const [data, setData] = useState<{ rules: Rule[]; events: Event[] }>()
  const [draft, setDraft] = useState<Rule>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deleting, setDeleting] = useState<Rule>()
  const [preview, setPreview] = useState<{
    matches: { conversationId: string }[]
    scanned: number
    limit: number
  }>()
  useEffect(() => {
    let active = true
    void fetch(root)
      .then(async (response) => {
        if (!response.ok) throw new Error('回访规则读取失败，请重试。')
        const value = await response.json()
        if (active) setData(value)
      })
      .catch((cause) => {
        if (active) setError(cause.message)
      })
    return () => {
      active = false
    }
  }, [root])
  async function action(method: string, body: unknown, suffix = '') {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(root + suffix, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok)
        throw new Error('操作失败，草稿已保留。请检查条件是否有效、规则是否已被修改，再重试。')
      const value = await response.json()
      if (suffix) setPreview(value)
      else {
        const refreshed = await fetch(root)
        if (!refreshed.ok) throw new Error('操作已保存，刷新列表失败；请刷新页面确认。')
        setData(await refreshed.json())
        setDraft(undefined)
        setDeleting(undefined)
        setNotice('回访规则已保存，即时生效。')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试。')
    } finally {
      setBusy(false)
    }
  }
  async function refresh() {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(root)
      if (!response.ok) throw new Error('回访记录刷新失败；原列表与草稿已保留，请重试。')
      setData(await response.json())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '刷新失败，请重试。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="ai-config-section" aria-labelledby="ai-follow-up-title">
      <div className="section-heading">
        <div>
          <h2 id="ai-follow-up-title">主动回访</h2>
          <p>
            规则保存即生效，启用不追溯旧锚点。每条规则在同一会话只触发一次；修改、停用再启用不恢复名额。删除后重新创建属于新的规则。
          </p>
        </div>
        <Button
          type="button"
          disabled={busy}
          onClick={() => {
            setDraft(fresh())
            setPreview(undefined)
          }}
        >
          添加回访规则
        </Button>
      </div>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!data && !error && <p role="status">正在读取回访规则…</p>}
      {data?.rules.length === 0 && <p>尚无回访规则。</p>}
      {data?.rules.map((rule) => (
        <div className="runtime-panel" key={rule.id}>
          <span>
            {rule.name} · {rule.enabled ? '启用' : '停用'} ·{' '}
            {rule.timer === 'LAST_AI_REPLY' ? '最后 AI 回复' : '分配 AI'}后 {rule.delaySeconds} 秒 ·
            修订 {rule.revision}
          </span>
          <div className="row-actions">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDraft(rule)
                setPreview(undefined)
              }}
            >
              编辑 {rule.name}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setDeleting(rule)}>
              删除 {rule.name}
            </Button>
          </div>
        </div>
      ))}
      {draft && (
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault()
            void action('POST', {
              id: draft.id,
              revision: draft.revision,
              name: draft.name,
              enabled: draft.enabled,
              timer: draft.timer,
              delaySeconds: draft.delaySeconds,
              instructions: draft.instructions,
              groups: draft.groups,
            })
          }}
        >
          <label className="form-field" htmlFor="follow-up-name">
            <span className="form-field-label">回访规则名称</span>
            <Input
              id="follow-up-name"
              required
              maxLength={100}
              disabled={busy}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <div className="switch-field">
            <span>启用回访规则</span>
            <Switch
              aria-label="启用回访规则"
              checked={draft.enabled}
              disabled={busy}
              onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
            />
          </div>
          <Select
            disabled={busy}
            value={draft.timer}
            onValueChange={(timer) => setDraft({ ...draft, timer: timer as Rule['timer'] })}
          >
            <SelectTrigger aria-label="回访计时起点">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="LAST_AI_REPLY">最后 AI 回复发送接口确认成功后</SelectItem>
              <SelectItem value="AI_ASSIGNMENT">分配 AI 后</SelectItem>
            </SelectContent>
          </Select>
          <label className="form-field" htmlFor="follow-up-delay">
            <span className="form-field-label">回访延迟（秒）</span>
            <Input
              id="follow-up-delay"
              type="number"
              min={1}
              max={2592000}
              required
              disabled={busy}
              value={draft.delaySeconds}
              onChange={(event) => setDraft({ ...draft, delaySeconds: Number(event.target.value) })}
            />
          </label>
          <label className="form-field" htmlFor="follow-up-instructions">
            <span className="form-field-label">回访要求（可空）</span>
            <Textarea
              id="follow-up-instructions"
              disabled={busy}
              maxLength={4000}
              value={draft.instructions}
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
            />
          </label>
          <p className="field-description">
            留空时根据授权当前会话生成，事实仍需知识依据。发送接口成功不代表实际送达或已读。新输入、接管、关闭、停止及规则修改会取消未提交回访；已提交消息继续按送达状态处理。
          </p>
          <AiStopSettings
            workspaceId={workspaceId}
            audienceOnly
            busy={busy}
            rules={{ ...emptyStopRules, groups: draft.groups }}
            onChange={(rules) => {
              setDraft({ ...draft, groups: rules.groups })
              setPreview(undefined)
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void action('POST', { groups: draft.groups }, '/preview')}
          >
            预览回访客户
          </Button>
          {preview && (
            <p role="status">
              预览当前 AI 接待中的前 {preview.limit} 条会话：已检查 {preview.scanned} 条，匹配{' '}
              {preview.matches.length} 条。
              {preview.matches.map((match) => match.conversationId.slice(0, 8)).join('、')}
              。执行时仍重新检查资格。
            </p>
          )}
          <div className="ai-form-actions">
            <Button type="submit" disabled={busy}>
              {busy ? '保存中…' : '保存回访规则'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setDraft(undefined)}
            >
              取消编辑
            </Button>
          </div>
        </form>
      )}
      <h3>回访记录</h3>
      <Button type="button" variant="outline" disabled={busy} onClick={() => void refresh()}>
        刷新回访记录
      </Button>
      <p className="field-description">
        失败复用原触发记录，安全重试最多 2
        次；结果不明暂停，需先核对原消息和提供方结果，不自动创建新机会。
      </p>
      {data?.events.length === 0 && <p>尚未触发回访。</p>}
      {data?.events.map((event) => (
        <p key={event.id}>
          {data.rules.find((rule) => rule.id === event.ruleId)?.name ?? '已删除规则'} · 会话{' '}
          {event.conversationId.slice(0, 8)} ·{' '}
          {event.operationState === 'UNKNOWN' || event.deliveryFailureCode === 'AMBIGUOUS_DELIVERY'
            ? '结果不明，已暂停'
            : event.deliveryState === 'FAILED'
              ? '发送失败，详见会话'
              : event.deliveryState === 'SENT'
                ? '发送接口已确认成功'
                : (states[event.state] ?? event.state)}{' '}
          · {new Date(event.triggeredAt).toLocaleString()}
          {event.failureCode
            ? ` · ${{ FOLLOW_UP_INELIGIBLE: '回访资格或锚点已变化', FOLLOW_UP_RULE_CHANGED: '规则已修改或删除', NEW_CUSTOMER_MESSAGE: '客户已发送新消息', AI_PROVIDER_ERROR: '模型服务失败', INVALID_OUTPUT: '模型输出无效', QUOTA_EXHAUSTED: '额度已耗尽' }[event.failureCode] ?? event.failureCode}`
            : ''}
        </p>
      ))}
      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除回访规则？</AlertDialogTitle>
            <AlertDialogDescription>
              未提交任务会取消，已有触发事实保留。重新创建是新的规则，不恢复原规则的一次性名额。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>保留规则</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                if (deleting)
                  void action('DELETE', { id: deleting.id, revision: deleting.revision })
              }}
            >
              确认删除回访规则
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
