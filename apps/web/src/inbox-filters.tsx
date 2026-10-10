import { useCallback, useEffect, useState } from 'react'
import { Button } from '#components/ui/button'
import { Checkbox } from '#components/ui/checkbox'
import { Input } from '#components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '#components/ui/sheet'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#components/ui/alert-dialog'

export type InboxFilters = {
  view: 'my' | 'waiting-human' | 'ai-handling' | 'unassigned' | 'all-open' | 'closed' | 'team'
  query?: string
  memberIds?: string[]
  tagIds?: string[]
  customerId?: string
  updatedFrom?: string
  updatedTo?: string
  attention?: 'unread' | 'unanswered'
  mute?: 'muted' | 'unmuted'
  properties?: { definitionId: string; value: string | number }[]
}
type Options = {
  members: { id: string; name: string | null }[]
  tags: { id: string; name: string; level: string }[]
  properties: { id: string; name: string; level: string; type: string; options: string[] }[]
}
type SavedView = {
  id: string
  name: string
  scope: 'PERSONAL' | 'PUBLIC'
  filters: InboxFilters
  valid: boolean
  canEdit: boolean
}

export function inboxQuery(filters: InboxFilters) {
  const query = new URLSearchParams({ view: filters.view })
  for (const key of [
    'query',
    'customerId',
    'updatedFrom',
    'updatedTo',
    'attention',
    'mute',
  ] as const) {
    if (filters[key]?.trim()) query.set(key, filters[key].trim())
  }
  if (filters.memberIds?.length) query.set('memberIds', filters.memberIds.join(','))
  if (filters.tagIds?.length) query.set('tagIds', filters.tagIds.join(','))
  if (filters.properties?.length) query.set('properties', JSON.stringify(filters.properties))
  return query.toString()
}

function viewUrl(id?: string) {
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('inboxView', id)
  else url.searchParams.delete('inboxView')
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}

export function InboxFilterControls({
  workspaceId,
  manager,
  filters,
  onApply,
  onReady,
}: {
  workspaceId: string
  manager: boolean
  filters: InboxFilters
  onApply: (filters: InboxFilters) => void
  onReady: (filters?: InboxFilters) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(filters)
  const [options, setOptions] = useState<Options>()
  const [views, setViews] = useState<SavedView[]>([])
  const [selected, setSelected] = useState('none')
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'PERSONAL' | 'PUBLIC'>('PERSONAL')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const current = views.find((v) => v.id === selected)
  const count =
    (filters.query ? 1 : 0) +
    (filters.memberIds?.length ?? 0) +
    (filters.tagIds?.length ?? 0) +
    (filters.customerId ? 1 : 0) +
    (filters.updatedFrom ? 1 : 0) +
    (filters.updatedTo ? 1 : 0) +
    (filters.attention ? 1 : 0) +
    (filters.mute ? 1 : 0) +
    (filters.properties?.length ?? 0)
  const base = `/api/workspaces/${workspaceId}`

  const request = useCallback(
    async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
      const response = await fetch(`${base}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      })
      if (!response.ok) {
        const data = (await response.json()) as { error?: { code: string } }
        throw new Error(
          data.error?.code === 'FORBIDDEN'
            ? '无权使用或修改此视图。'
            : data.error?.code === 'INVALID_REQUEST'
              ? '条件已失效或格式不正确，请修复后重试。'
              : '视图操作失败，请重试。',
        )
      }
      return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
    },
    [base],
  )

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      request<Options>(`/inbox-filter-options?retry=${retry}`),
      request<{ views: SavedView[] }>('/inbox-views'),
    ])
      .then(([available, saved]) => {
        if (cancelled) return
        setOptions(available)
        setViews(saved.views)
        setError('')
        const id = new URL(window.location.href).searchParams.get('inboxView')
        if (!id) {
          onReady()
          return
        }
        const found = saved.views.find((v) => v.id === id)
        if (!found) {
          setError('保存视图不存在或无权访问，请清除或选择其它视图。')
          return
        }
        setSelected(found.id)
        setName(found.name)
        setScope(found.scope)
        setDraft(found.filters)
        if (!found.valid) {
          setError('保存视图包含失效的标签、成员、客户或属性，请修复后应用。')
          return
        }
        onReady(found.filters)
      })
      .catch((cause) => {
        if (!cancelled) setError((cause as Error).message)
      })
    return () => {
      cancelled = true
    }
    // Reload only when workspace or an explicit retry changes; filter edits do not reload saved views.
  }, [request, retry, onReady])

  function apply(next: InboxFilters, id?: string) {
    viewUrl(id)
    onApply(next)
    setStatus('')
    setError('')
  }
  function choose(id: string) {
    setSelected(id)
    setStatus('')
    const found = views.find((v) => v.id === id)
    if (found) {
      setDraft(found.filters)
      setName(found.name)
      setScope(found.scope)
    }
  }
  async function save(update: boolean) {
    setBusy(true)
    setError('')
    setStatus('')
    try {
      const saved = await request<{ view: SavedView }>(
        update && current ? `/inbox-views/${current.id}` : '/inbox-views',
        update ? 'PATCH' : 'POST',
        { name, scope, filters: draft },
      )
      const listing = await request<{ views: SavedView[] }>('/inbox-views')
      setViews(listing.views)
      setSelected(saved.view.id)
      apply(draft, saved.view.id)
      setStatus('视图已保存')
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function remove() {
    if (!current) return
    setBusy(true)
    setError('')
    try {
      await request(`/inbox-views/${current.id}`, 'DELETE')
      setViews(views.filter((v) => v.id !== current.id))
      setSelected('none')
      viewUrl()
      setStatus('视图已删除')
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }
  function toggle(key: 'memberIds' | 'tagIds', id: string, checked: boolean) {
    setDraft((previous) => ({
      ...previous,
      [key]: checked
        ? [...(previous[key] ?? []), id]
        : previous[key]?.filter((value) => value !== id),
    }))
  }

  return (
    <>
      <label htmlFor="inbox-search">姓名或备注</label>
      <Input
        id="inbox-search"
        value={filters.query ?? ''}
        maxLength={200}
        onChange={(e) => apply({ ...filters, query: e.target.value || undefined })}
      />
      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          setDraft(filters)
          setStatus('')
          setOpen(true)
        }}
      >
        筛选与保存视图（{count}）
      </Button>
      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          setSelected('none')
          apply({ view: 'all-open' })
        }}
      >
        清除全部条件
      </Button>
      {error && (
        <div role="alert">
          {error}
          <Button type="button" variant="ghost" onClick={() => setRetry((value) => value + 1)}>
            重试视图加载
          </Button>
        </div>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent showCloseButton={false} className="overflow-y-auto p-4">
          <SheetHeader>
            <SheetTitle>筛选与保存视图</SheetTitle>
            <SheetDescription>
              条件在服务端组合执行。时间使用 UTC，按会话最近更新时间筛选。
            </SheetDescription>
          </SheetHeader>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            关闭
          </Button>
          {error && <p role="alert">{error}</p>}
          {status && <p role="status">{status}</p>}
          <label htmlFor="saved-inbox-view">保存的视图</label>
          <Select value={selected} onValueChange={choose}>
            <SelectTrigger id="saved-inbox-view">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">当前条件</SelectItem>
              {views.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.scope === 'PUBLIC' ? '公共' : '个人'}：{v.name}
                  {v.valid ? '' : '（需修复）'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            disabled={!current || busy || !current.valid}
            onClick={() => {
              if (current) {
                apply(current.filters, current.id)
                setDraft(current.filters)
                setOpen(false)
              }
            }}
          >
            恢复此视图
          </Button>
          {current && !current.valid && (
            <p role="alert">
              条件已失效，请清除缺失的条件或重新选择，然后应用或更新。不会自动扩大查询范围。
            </p>
          )}
          <fieldset>
            <legend>成员（任一匹配）</legend>
            {options?.members.map((m) => (
              <label
                className="flex items-center gap-2"
                key={m.id}
                htmlFor={`filter-member-${m.id}`}
              >
                <Checkbox
                  id={`filter-member-${m.id}`}
                  checked={draft.memberIds?.includes(m.id) ?? false}
                  onCheckedChange={(checked) => toggle('memberIds', m.id, checked === true)}
                />
                {m.name ?? '成员'}
              </label>
            ))}
            {!!draft.memberIds?.some((id) => !options?.members.some((m) => m.id === id)) && (
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  setDraft({
                    ...draft,
                    memberIds: draft.memberIds?.filter((id) =>
                      options?.members.some((m) => m.id === id),
                    ),
                  })
                }
              >
                清除失效成员
              </Button>
            )}
          </fieldset>
          <fieldset>
            <legend>标签（全部匹配）</legend>
            {options?.tags.map((t) => (
              <label className="flex items-center gap-2" key={t.id} htmlFor={`filter-tag-${t.id}`}>
                <Checkbox
                  id={`filter-tag-${t.id}`}
                  checked={draft.tagIds?.includes(t.id) ?? false}
                  onCheckedChange={(checked) => toggle('tagIds', t.id, checked === true)}
                />
                {t.name}（{t.level === 'CUSTOMER' ? '客户' : '会话'}）
              </label>
            ))}
            {!!draft.tagIds?.some((id) => !options?.tags.some((t) => t.id === id)) && (
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  setDraft({
                    ...draft,
                    tagIds: draft.tagIds?.filter((id) => options?.tags.some((t) => t.id === id)),
                  })
                }
              >
                清除失效标签
              </Button>
            )}
          </fieldset>
          <p>{draft.customerId ? '已限定客户。' : '可在客户资料中选择“仅查看此客户的对话”。'}</p>
          {draft.customerId && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDraft({ ...draft, customerId: undefined })}
            >
              清除客户条件
            </Button>
          )}
          <label htmlFor="filter-from">更新时间从（UTC）</label>
          <Input
            id="filter-from"
            type="datetime-local"
            value={draft.updatedFrom ? new Date(draft.updatedFrom).toISOString().slice(0, 16) : ''}
            onChange={(e) =>
              setDraft({
                ...draft,
                updatedFrom: e.target.value ? `${e.target.value}:00Z` : undefined,
              })
            }
          />
          <label htmlFor="filter-to">更新时间至（UTC）</label>
          <Input
            id="filter-to"
            type="datetime-local"
            value={draft.updatedTo ? new Date(draft.updatedTo).toISOString().slice(0, 16) : ''}
            onChange={(e) =>
              setDraft({
                ...draft,
                updatedTo: e.target.value ? `${e.target.value}:00Z` : undefined,
              })
            }
          />
          <fieldset>
            <legend>属性等于（全部匹配）</legend>
            {options?.properties.map((p) => {
              const condition = draft.properties?.find((c) => c.definitionId === p.id)
              const update = (value: string) =>
                setDraft((previous) => ({
                  ...previous,
                  properties: [
                    ...(previous.properties ?? []).filter((c) => c.definitionId !== p.id),
                    ...(value
                      ? [{ definitionId: p.id, value: p.type === 'NUMBER' ? Number(value) : value }]
                      : []),
                  ],
                }))
              return (
                <div key={p.id}>
                  <label htmlFor={`property-filter-${p.id}`}>
                    {p.name}（{p.level === 'CUSTOMER' ? '客户' : '会话'}）
                  </label>
                  {p.type === 'OPTION' ? (
                    <Select
                      value={condition ? `option:${condition.value}` : 'none'}
                      onValueChange={(value) => update(value === 'none' ? '' : value.slice(7))}
                    >
                      <SelectTrigger id={`property-filter-${p.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">不限</SelectItem>
                        {p.options.map((value) => (
                          <SelectItem key={value} value={`option:${value}`}>
                            {value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id={`property-filter-${p.id}`}
                      type={p.type === 'NUMBER' ? 'number' : 'text'}
                      value={condition?.value ?? ''}
                      onChange={(e) => update(e.target.value)}
                    />
                  )}
                </div>
              )
            })}
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDraft({ ...draft, properties: [] })}
            >
              清除属性条件
            </Button>
          </fieldset>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              apply(draft)
              setOpen(false)
            }}
          >
            应用条件
          </Button>
          <label htmlFor="inbox-view-name">视图名称</label>
          <Input
            id="inbox-view-name"
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label htmlFor="inbox-view-scope">可见范围</label>
          <Select value={scope} onValueChange={(value) => setScope(value as typeof scope)}>
            <SelectTrigger id="inbox-view-scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PERSONAL">个人（仅本人）</SelectItem>
              {manager && <SelectItem value="PUBLIC">公共（管理员维护）</SelectItem>}
            </SelectContent>
          </Select>
          {!manager && <p>公共视图仅管理员可修改。恢复公共视图不会扩大频道权限。</p>}
          <Button
            type="button"
            disabled={busy || !name.trim() || (!manager && scope === 'PUBLIC')}
            onClick={() => void save(false)}
          >
            另存为新视图
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !current?.canEdit}
            onClick={() => void save(true)}
          >
            更新此视图
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy || !current?.canEdit}
            onClick={() => setConfirmDelete(true)}
          >
            删除此视图
          </Button>
        </SheetContent>
      </Sheet>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除保存视图？</AlertDialogTitle>
            <AlertDialogDescription>仅删除筛选配置，不删除对话或客户。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
