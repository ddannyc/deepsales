import { useEffect, useId, useRef, useState } from 'react'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from './components/ui/sheet'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog'

type Definition = {
  id: string
  name: string
  level: 'CUSTOMER' | 'CONVERSATION'
  type: 'TEXT' | 'NUMBER' | 'OPTION'
  options: string[]
  maxLength: number
  revision: number
}
type Tag = { id: string; name: string; level: 'CUSTOMER' | 'CONVERSATION' }
type Profile = {
  customer: {
    id: string
    displayName: string | null
    email: string | null
    phone: string | null
    preferredLanguage: string | null
    notes: string | null
    ownerMemberId: string | null
    profileRevision: number
  }
  definitions: Definition[]
  tagDefinitions: Tag[]
  tags: { tagId: string }[]
  values: {
    definitionId: string
    value: string | number | null
    revision: number
    allowAutomaticUpdate: boolean
  }[]
  history: {
    id: string
    definitionName: string
    value: string | number | null
    sourceName: string | null
    sourceChannelId: string
    createdAt: string
    allowAutomaticUpdate: boolean
  }[]
  identities: { id: string; channelId: string; channelName: string; customerId: string }[]
  currentIdentityId: string
  nextHistoryCursor: string | null
}
type Method = 'POST' | 'PATCH' | 'PUT' | 'DELETE'
type Props = {
  workspaceId: string
  conversationId: string
  manager: boolean
  canEdit: boolean
  members: { id: string; displayName: string | null; type: string; status: string }[]
  onSaved: () => Promise<void>
  onFilter: (tag: { id: string; name: string }) => void
}

async function read<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const data = (await response.json()) as T & { error?: { code: string } }
  if (!response.ok) {
    const code = data.error?.code
    const error = new Error(
      code === 'FORBIDDEN'
        ? '无权查看或编辑此客户资料，可能包含无权限渠道的共享资料。'
        : code === 'CONFLICT'
          ? '资料已变更或仍有依赖，请刷新后重试。'
          : code === 'NOT_FOUND'
            ? '资料不存在，请刷新。'
            : '保存失败，请检查类型、选项和长度后重试。',
    )
    error.name = code ?? 'REQUEST_FAILED'
    throw error
  }
  return data
}

export function CustomerSidebar(props: Props) {
  const [open, setOpen] = useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button variant="outline" type="button" onClick={() => setOpen(true)}>
        客户资料
      </Button>
      <SheetContent className="customer-sheet" showCloseButton={false}>
        <SheetHeader>
          <SheetTitle>客户资料</SheetTitle>
          <SheetClose asChild>
            <Button type="button" variant="ghost">
              关闭客户资料
            </Button>
          </SheetClose>
          <SheetDescription>客户资料归属独立于会话负责人。保存后立即生效。</SheetDescription>
        </SheetHeader>
        {open && (
          <CustomerFacts
            {...props}
            key={props.conversationId}
            onFilter={(tag) => {
              props.onFilter(tag)
              setOpen(false)
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function CustomerFacts({
  workspaceId,
  conversationId,
  manager,
  canEdit,
  members,
  onSaved,
  onFilter,
}: Props) {
  const base = `/api/workspaces/${workspaceId}/conversations/${conversationId}`
  const formId = useId()
  const profileRequest = useRef(0)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [definition, setDefinition] = useState<Partial<Definition> | null>(null)
  const [tagEditor, setTagEditor] = useState<Partial<Tag> | null>(null)
  const [deletion, setDeletion] = useState<{
    kind: 'property' | 'tag'
    id: string
    name: string
    dependencies?: number
  } | null>(null)
  const [targets, setTargets] = useState<{ id: string; displayName: string | null }[]>([])
  const [targetId, setTargetId] = useState('')
  const [targetCursor, setTargetCursor] = useState<string | null>(null)
  const [link, setLink] = useState<{
    identityId: string
    targetCustomerId: string | null
    expectedCustomerId: string
    conversations: number
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    const request = ++profileRequest.current
    void read<Profile>(`${base}/customer-profile`)
      .then((data) => {
        if (!cancelled && request === profileRequest.current) setProfile(data)
      })
      .catch((cause) => {
        if (!cancelled && request === profileRequest.current) setError(cause.message)
      })
    return () => {
      cancelled = true
    }
  }, [base])

  async function action(work: () => Promise<void>) {
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await work()
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'FORBIDDEN') {
        profileRequest.current++
        setProfile(null)
      }
      setError(cause instanceof Error ? cause.message : '操作失败，请重试。')
    } finally {
      setBusy(false)
    }
  }
  async function save(path: string, method: Method, body?: unknown) {
    if (/^\/(customer-profile|properties\/|tags\/)/.test(path))
      body = { ...(body as Record<string, unknown>), expectedCustomerId: profile?.customer.id }
    await read(`${base}${path}`, method, body)
    await refresh()
    await onSaved()
    setStatus('已保存')
  }
  async function refresh() {
    const request = ++profileRequest.current
    const data = await read<Profile>(`${base}/customer-profile`)
    if (request === profileRequest.current) setProfile(data)
    setStatus('已刷新')
  }
  async function previewIdentity(identityId: string, targetCustomerId: string | null) {
    if (!profile) return
    const expectedCustomerId = profile.customer.id
    const { impact } = await read<{ impact: { conversations: number } }>(
      `${base}/identities/${identityId}/preview`,
      'POST',
      { targetCustomerId, expectedCustomerId },
    )
    setLink({
      identityId,
      targetCustomerId,
      expectedCustomerId,
      conversations: impact.conversations,
    })
  }
  async function loadTargets(after?: string) {
    const data = await read<{ customers: typeof targets; nextCursor: string | null }>(
      `${base}/customer-link-targets${after ? `?after=${encodeURIComponent(after)}` : ''}`,
    )
    setTargets((current) =>
      after
        ? [...current, ...data.customers.filter((t) => !current.some((c) => c.id === t.id))]
        : data.customers,
    )
    setTargetCursor(data.nextCursor)
  }
  return (
    <div className="customer-facts" aria-busy={busy}>
      {error && <p role="alert">{error}</p>}
      <p role="status">{status}</p>
      {!canEdit && <p>仅会话负责人或管理员可编辑客户资料。</p>}
      <Button type="button" variant="ghost" disabled={busy} onClick={() => void action(refresh)}>
        刷新资料
      </Button>
      {!profile ? (
        <p role="status">{error ? '资料暂不可用。对话仍可继续处理。' : '正在加载客户资料…'}</p>
      ) : (
        <>
          <form
            key={`${profile.customer.id}:${profile.customer.profileRevision}`}
            onSubmit={(event) => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)
              void action(async () => {
                await save('/customer-profile', 'PATCH', {
                  expectedRevision: profile.customer.profileRevision,
                  ...Object.fromEntries(
                    [
                      'displayName',
                      'email',
                      'phone',
                      'preferredLanguage',
                      'notes',
                      'ownerMemberId',
                    ].map((key) => [key, data.get(key) || null]),
                  ),
                })
              })
            }}
          >
            <fieldset disabled={busy || !canEdit}>
              <legend>联系方式与备注</legend>
              <label htmlFor={`${formId}-displayName`}>
                客户名称
                <Input
                  id={`${formId}-displayName`}
                  name="displayName"
                  defaultValue={profile.customer.displayName ?? ''}
                  maxLength={100}
                />
              </label>
              <label htmlFor={`${formId}-email`}>
                电子邮箱
                <Input
                  id={`${formId}-email`}
                  name="email"
                  type="email"
                  defaultValue={profile.customer.email ?? ''}
                  maxLength={254}
                />
              </label>
              <label htmlFor={`${formId}-phone`}>
                电话
                <Input
                  id={`${formId}-phone`}
                  name="phone"
                  type="tel"
                  defaultValue={profile.customer.phone ?? ''}
                  maxLength={50}
                />
              </label>
              <label htmlFor={`${formId}-language`}>
                偏好语言
                <Input
                  id={`${formId}-language`}
                  name="preferredLanguage"
                  defaultValue={profile.customer.preferredLanguage ?? ''}
                  maxLength={100}
                />
              </label>
              <label htmlFor={`${formId}-notes`}>
                客户备注
                <Textarea
                  id={`${formId}-notes`}
                  name="notes"
                  defaultValue={profile.customer.notes ?? ''}
                  maxLength={2000}
                />
              </label>
              <label>
                资料负责人
                <select
                  aria-label="资料负责人"
                  name="ownerMemberId"
                  defaultValue={profile.customer.ownerMemberId ?? ''}
                >
                  <option value="">未设置</option>
                  {members
                    .filter((m) => m.type === 'HUMAN' && m.status === 'ACTIVE')
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                </select>
              </label>
              <Button type="submit">保存客户资料</Button>
            </fieldset>
          </form>
          {(['CUSTOMER', 'CONVERSATION'] as const).map((level) => (
            <section
              key={level}
              aria-label={level === 'CUSTOMER' ? '客户级属性与标签' : '会话级属性与标签'}
            >
              <h3>{level === 'CUSTOMER' ? '客户级' : '会话级'}属性与标签</h3>
              {profile.definitions
                .filter((d) => d.level === level)
                .map((d) => {
                  const value = profile.values.find((v) => v.definitionId === d.id)
                  return (
                    <form
                      key={`${profile.customer.id}:${d.id}:${value?.revision ?? 0}`}
                      onSubmit={(event) => {
                        event.preventDefault()
                        const data = new FormData(event.currentTarget)
                        const text = String(data.get('value') ?? '')
                        void action(() =>
                          save(`/properties/${d.id}`, 'PUT', {
                            value: text === '' ? null : d.type === 'NUMBER' ? Number(text) : text,
                            expectedRevision: value?.revision ?? 0,
                            allowAutomaticUpdate: data.get('automatic') === 'on',
                          }),
                        )
                      }}
                    >
                      <fieldset disabled={busy || !canEdit}>
                        <label htmlFor={`${formId}-${d.id}`}>
                          {d.name}
                          {d.type === 'OPTION' ? (
                            <select
                              aria-label={d.name}
                              id={`${formId}-${d.id}`}
                              name="value"
                              defaultValue={String(value?.value ?? '')}
                            >
                              <option value="">未设置</option>
                              {d.options.map((o) => (
                                <option key={o}>{o}</option>
                              ))}
                            </select>
                          ) : (
                            <Input
                              id={`${formId}-${d.id}`}
                              name="value"
                              type={d.type === 'NUMBER' ? 'number' : 'text'}
                              step="any"
                              maxLength={d.maxLength}
                              defaultValue={String(value?.value ?? '')}
                            />
                          )}
                        </label>
                        <label className="customer-checkbox">
                          <input
                            type="checkbox"
                            name="automatic"
                            defaultChecked={value?.allowAutomaticUpdate ?? false}
                          />
                          允许自动更新（默认保护人工值）
                        </label>
                        <Button variant="outline" type="submit">
                          保存{d.name}
                        </Button>
                      </fieldset>
                      {manager && (
                        <div className="customer-actions">
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setDefinition(d)}
                          >
                            编辑{d.name}定义
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void action(async () => {
                                const data = await read<{ dependencies: { values: number } }>(
                                  `${base}/property-definitions/${d.id}/dependencies`,
                                )
                                setDeletion({
                                  kind: 'property',
                                  id: d.id,
                                  name: d.name,
                                  dependencies: data.dependencies.values,
                                })
                              })
                            }
                          >
                            删除{d.name}定义
                          </Button>
                        </div>
                      )}
                    </form>
                  )
                })}
              {manager && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    setDefinition({ name: '', level, type: 'TEXT', options: [], maxLength: 2000 })
                  }
                >
                  新增{level === 'CUSTOMER' ? '客户' : '会话'}属性
                </Button>
              )}
              <div className="customer-tags">
                {profile.tagDefinitions
                  .filter((t) => t.level === level)
                  .map((t) => {
                    const added = profile.tags.some((v) => v.tagId === t.id)
                    return (
                      <div key={t.id}>
                        <label className="customer-checkbox">
                          <input
                            type="checkbox"
                            checked={added}
                            disabled={busy || !canEdit}
                            onChange={() =>
                              void action(() => save(`/tags/${t.id}`, added ? 'DELETE' : 'PUT'))
                            }
                          />
                          {t.name}
                        </label>
                        <div className="customer-actions">
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => onFilter(t)}
                          >
                            筛选{t.name}
                          </Button>
                          {manager && (
                            <>
                              <Button
                                type="button"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => setTagEditor(t)}
                              >
                                编辑{t.name}标签
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => setDeletion({ kind: 'tag', id: t.id, name: t.name })}
                              >
                                删除{t.name}标签
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    )
                  })}
              </div>
              {manager && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setTagEditor({ name: '', level })}
                >
                  新增{level === 'CUSTOMER' ? '客户' : '会话'}标签
                </Button>
              )}
            </section>
          ))}
          <section aria-label="属性修改历史">
            <h3>属性修改历史</h3>
            {profile.history.length ? (
              <ol>
                {profile.history.map((h) => (
                  <li key={h.id}>
                    {h.definitionName}：{h.value === null ? '已清除' : String(h.value)} · 人工：
                    {h.sourceName} ·{' '}
                    {profile.identities.find((i) => i.channelId === h.sourceChannelId)
                      ?.channelName ?? '原来源渠道'}{' '}
                    · {new Date(h.createdAt).toLocaleString()} ·{' '}
                    {h.allowAutomaticUpdate ? '允许自动更新' : '受保护'}
                  </li>
                ))}
              </ol>
            ) : (
              <p>尚无修改记录。</p>
            )}
            {profile.nextHistoryCursor && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const data = await read<Pick<Profile, 'history' | 'nextHistoryCursor'>>(
                      `${base}/property-history?before=${encodeURIComponent(profile.nextHistoryCursor ?? '')}`,
                    )
                    setProfile((current) =>
                      current
                        ? {
                            ...current,
                            history: [...current.history, ...data.history],
                            nextHistoryCursor: data.nextHistoryCursor,
                          }
                        : null,
                    )
                  })
                }
              >
                加载更早属性历史
              </Button>
            )}
          </section>
          <section aria-label="渠道身份">
            <h3>渠道身份</h3>
            <p>
              关联客户：{profile.customer.displayName ?? '未命名客户'}（
              {profile.customer.id.slice(0, 8)}）
            </p>
            {profile.identities.map((i) => (
              <div key={i.id}>
                <p>
                  {i.channelName} · 身份 {i.id.slice(0, 8)}
                  {i.id === profile.currentIdentityId ? '（当前）' : ''}
                </p>
                {manager && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void action(() => previewIdentity(i.id, null))}
                  >
                    解除身份 {i.id.slice(0, 8)} 关联
                  </Button>
                )}
              </div>
            ))}
            {manager && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void action(() => loadTargets())}
                >
                  加载可关联客户
                </Button>
                {targetCursor && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void action(() => loadTargets(targetCursor))}
                  >
                    加载更多客户
                  </Button>
                )}
                <label>
                  目标客户
                  <select
                    aria-label="目标客户"
                    value={targetId}
                    onChange={(e) => setTargetId(e.currentTarget.value)}
                  >
                    <option value="">选择客户</option>
                    {targets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.displayName ?? '未命名客户'}（{t.id.slice(0, 8)}）
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  type="button"
                  disabled={busy || !targetId}
                  onClick={() =>
                    void action(() => previewIdentity(profile.currentIdentityId, targetId))
                  }
                >
                  预览身份关联
                </Button>
              </>
            )}
          </section>
        </>
      )}
      <Dialog
        open={definition !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDefinition(null)
        }}
      >
        <DialogContent className="customer-facts-dialog">
          <DialogHeader>
            <DialogTitle>{definition?.id ? '编辑属性定义' : '新增属性定义'}</DialogTitle>
            <DialogDescription>级别和类型创建后不可变；现存值必须仍符合定义。</DialogDescription>
          </DialogHeader>
          {definition && (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                const data = new FormData(event.currentTarget)
                void action(async () => {
                  await save(
                    `/property-definitions${definition.id ? `/${definition.id}` : ''}`,
                    definition.id ? 'PATCH' : 'POST',
                    {
                      name: String(data.get('name')),
                      level: definition.level,
                      type: definition.type,
                      options:
                        definition.type === 'OPTION'
                          ? String(data.get('options'))
                              .split('\n')
                              .map((s) => s.trim())
                              .filter(Boolean)
                          : [],
                      maxLength: Number(data.get('maxLength')),
                      ...(definition.id ? { expectedRevision: definition.revision } : {}),
                    },
                  )
                  setDefinition(null)
                })
              }}
            >
              <fieldset disabled={busy}>
                <label htmlFor={`${formId}-definitionName`}>
                  属性名称
                  <Input
                    id={`${formId}-definitionName`}
                    name="name"
                    defaultValue={definition.name}
                    required
                    maxLength={100}
                  />
                </label>
                <label>
                  属性类型
                  <select
                    aria-label="属性类型"
                    value={definition.type}
                    disabled={Boolean(definition.id)}
                    onChange={(e) =>
                      setDefinition({
                        ...definition,
                        type: e.currentTarget.value as Definition['type'],
                      })
                    }
                  >
                    <option value="TEXT">文本</option>
                    <option value="NUMBER">数字</option>
                    <option value="OPTION">预定义选项</option>
                  </select>
                </label>
                <label htmlFor={`${formId}-maxLength`}>
                  最大文本长度
                  <Input
                    id={`${formId}-maxLength`}
                    name="maxLength"
                    type="number"
                    min={1}
                    max={2000}
                    defaultValue={definition.maxLength}
                    required
                  />
                </label>
                {definition.type === 'OPTION' && (
                  <label htmlFor={`${formId}-options`}>
                    可选值（每行一个）
                    <Textarea
                      id={`${formId}-options`}
                      name="options"
                      defaultValue={definition.options?.join('\n')}
                      required
                    />
                  </label>
                )}
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setDefinition(null)}>
                    取消
                  </Button>
                  <Button type="submit">保存属性定义</Button>
                </DialogFooter>
              </fieldset>
            </form>
          )}
          {error && <p role="alert">{error}</p>}
        </DialogContent>
      </Dialog>
      <Dialog
        open={tagEditor !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setTagEditor(null)
        }}
      >
        <DialogContent className="customer-facts-dialog">
          <DialogHeader>
            <DialogTitle>标签定义</DialogTitle>
            <DialogDescription>
              客户标签在关联身份间共享，会话标签仅用于当前会话。
            </DialogDescription>
          </DialogHeader>
          {tagEditor && (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                const data = new FormData(event.currentTarget)
                void action(async () => {
                  await save(
                    `/tag-definitions${tagEditor.id ? `/${tagEditor.id}` : ''}`,
                    tagEditor.id ? 'PATCH' : 'POST',
                    { name: String(data.get('name')), level: tagEditor.level },
                  )
                  setTagEditor(null)
                })
              }}
            >
              <label htmlFor={`${formId}-tagName`}>
                标签名称
                <Input
                  id={`${formId}-tagName`}
                  name="name"
                  defaultValue={tagEditor.name}
                  required
                  maxLength={100}
                  disabled={busy}
                />
              </label>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setTagEditor(null)}
                >
                  取消
                </Button>
                <Button type="submit" disabled={busy}>
                  保存标签定义
                </Button>
              </DialogFooter>
            </form>
          )}
          {error && <p role="alert">{error}</p>}
        </DialogContent>
      </Dialog>
      <Dialog
        open={deletion !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeletion(null)
        }}
      >
        <DialogContent className="customer-facts-dialog">
          <DialogHeader>
            <DialogTitle>删除 {deletion?.name}</DialogTitle>
            <DialogDescription>
              {deletion?.kind === 'property'
                ? `现存值依赖：${deletion.dependencies ?? 0}。存在依赖时禁止删除；历史来源记录保留。`
                : '删除标签及其关联，不删除任何会话或消息。'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setDeletion(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy || Boolean(deletion?.dependencies)}
              onClick={() =>
                void action(async () => {
                  if (!deletion) return
                  await save(
                    `/${deletion.kind === 'property' ? 'property' : 'tag'}-definitions/${deletion.id}`,
                    'DELETE',
                  )
                  setDeletion(null)
                })
              }
            >
              确认删除
            </Button>
          </DialogFooter>
          {error && <p role="alert">{error}</p>}
        </DialogContent>
      </Dialog>
      <Dialog
        open={link !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setLink(null)
        }}
      >
        <DialogContent className="customer-facts-dialog">
          <DialogHeader>
            <DialogTitle>{link?.targetCustomerId ? '确认身份关联' : '确认解除关联'}</DialogTitle>
            <DialogDescription>
              影响该身份的 {link?.conversations} 个会话。
              {link?.targetCustomerId
                ? '将共享目标客户资料、客户属性和标签。'
                : '将创建独立客户档案，停止共享现有客户资料、属性和标签。'}
              消息历史、会话负责人及发送资格保持原值。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setLink(null)}>
              取消
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  if (!link) return
                  await save(`/identities/${link.identityId}`, 'PUT', {
                    targetCustomerId: link.targetCustomerId,
                    expectedCustomerId: link.expectedCustomerId,
                    confirmed: true,
                  })
                  setLink(null)
                  setTargetId('')
                })
              }
            >
              确认更改关联
            </Button>
          </DialogFooter>
          {error && <p role="alert">{error}</p>}
        </DialogContent>
      </Dialog>
    </div>
  )
}
