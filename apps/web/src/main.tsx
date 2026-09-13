import {
  StrictMode,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
} from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

type Workspace = {
  id: string
  name: string
  role: 'OWNER' | 'ADMIN' | 'AGENT'
  memberId: string
}

type Me = {
  user: { id: string; name: string; email: string }
  workspaces: Workspace[]
  workspace: Workspace | null
}

type TeamChannel = {
  id: string
  displayName: string
  provider: 'FACEBOOK_MESSENGER'
  status: 'ACTIVE' | 'DISABLED'
}

type TeamMember = {
  id: string
  type: 'HUMAN' | 'AI'
  displayName: string | null
  avatarUrl: string | null
  status: 'ACTIVE' | 'DISABLED'
  autoAssignmentEnabled: boolean
  maxActiveConversations: number
  availability: boolean | null
  role: 'OWNER' | 'ADMIN' | 'AGENT' | null
  email: string | null
  configurationStatus: 'UNPUBLISHED' | null
  channelIds: string[]
}

type Team = { members: TeamMember[]; channels: TeamChannel[] }

type FacebookChannel = {
  id: string
  pageId: string
  displayName: string
  provider: 'FACEBOOK_MESSENGER'
  status: 'ACTIVE' | 'DISABLED'
  connectionStatus: 'ACTIVE' | 'ACTION_REQUIRED' | 'DISABLED'
  subscribedAt: string | null
  lastCheckedAt: string | null
  lastErrorCode: string | null
  lastErrorSubcode: number | null
  lastErrorMessage: string | null
}

type FacebookPageOption = { id: string; name: string; tasks: string[] }

type Invitation = {
  url: string
  email: string
  role: 'ADMIN' | 'AGENT'
  expiresAt: string
}

class ApiError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

const roleLabels: Record<Workspace['role'], string> = {
  OWNER: '所有者',
  ADMIN: '管理员',
  AGENT: '客服',
}
const memberTypeLabels: Record<TeamMember['type'], string> = {
  HUMAN: '人工',
  AI: 'AI',
}
const lifecycleLabels: Record<TeamMember['status'], string> = {
  ACTIVE: '启用',
  DISABLED: '停用',
}
const configurationStatusLabels: Record<NonNullable<TeamMember['configurationStatus']>, string> = {
  UNPUBLISHED: '未发布',
}

function roleLabel(role: Workspace['role'] | null) {
  return role ? roleLabels[role] : ''
}

function App() {
  const [me, setMe] = useState<Me | null>()
  const [loadError, setLoadError] = useState('')
  const [pendingInviteToken, setPendingInviteToken] = useState(() => inviteToken())

  const refresh = useCallback(async () => {
    const activeWorkspaceId = localStorage.getItem('activeWorkspaceId')
    const response = await fetch('/api/me', {
      headers: activeWorkspaceId ? { 'x-workspace-id': activeWorkspaceId } : undefined,
    })
    if (response.status === 401) return setMe(null)
    if (!response.ok) throw await responseError(response)
    const next = (await response.json()) as Me
    if (next.workspace) localStorage.setItem('activeWorkspaceId', next.workspace.id)
    setMe(next)
  }, [])

  const load = useCallback(async () => {
    setLoadError('')
    try {
      await refresh()
    } catch (cause) {
      setLoadError(
        cause instanceof ApiError && cause.code === 'NOT_READY'
          ? 'DeepSales 尚未就绪，请检查数据库连接。'
          : '收件箱加载失败，请重试。',
      )
    }
  }, [refresh])

  useEffect(() => {
    void load()
  }, [load])

  if (loadError) return <Unavailable message={loadError} onRetry={load} />
  if (me === undefined) return <Loading />
  if (!me) return <Auth onAuthenticated={refresh} invited={Boolean(pendingInviteToken)} />
  if (pendingInviteToken) {
    return (
      <InviteAcceptance
        token={pendingInviteToken}
        onAccepted={async (workspaceId) => {
          setPendingInviteToken(null)
          localStorage.setItem('activeWorkspaceId', workspaceId)
          history.replaceState(null, '', '/team')
          await refresh()
        }}
      />
    )
  }
  if (!me.workspace) return <WorkspaceSetup userName={me.user.name} onCreated={refresh} />
  return (
    <Shell
      me={me as Me & { workspace: NonNullable<Me['workspace']> }}
      onSignOut={() => setMe(null)}
      onWorkspaceChange={async (workspaceId) => {
        localStorage.setItem('activeWorkspaceId', workspaceId)
        await load()
      }}
    />
  )
}

function Auth({
  onAuthenticated,
  invited,
}: {
  onAuthenticated: () => Promise<void>
  invited: boolean
}) {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const data = new FormData(event.currentTarget)
    try {
      await request(`/api/auth/${mode}/email`, {
        name: data.get('name'),
        email: data.get('email'),
        password: data.get('password'),
      })
      await onAuthenticated()
    } catch (cause) {
      setError(authenticationErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const signingUp = mode === 'sign-up'
  return (
    <main className="auth-layout">
      <SignalRail />
      <section className="auth-intro" aria-labelledby="welcome-title">
        <p className="eyebrow">Facebook 共享收件箱</p>
        <h1 id="welcome-title">让每一段客户对话都尽在掌握。</h1>
        <p className="intro-copy">
          DeepSales 为人工与 AI 团队提供一个清晰的空间，集中处理 Messenger 消息。
        </p>
        <ol className="flow">
          <li>
            <span>消息到达</span>
            <small>Facebook Messenger</small>
          </li>
          <li>
            <span>最合适的成员回复</span>
            <small>人工或 AI</small>
          </li>
          <li>
            <span>团队始终掌控全局</span>
            <small>统一记录</small>
          </li>
        </ol>
      </section>
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="wordmark">
          DEEP<span>SALES</span>
        </div>
        <div className="mode-switch">
          <button
            type="button"
            aria-label="登录视图"
            aria-pressed={!signingUp}
            onClick={() => setMode('sign-in')}
          >
            登录
          </button>
          <button
            type="button"
            aria-label="创建账户视图"
            aria-pressed={signingUp}
            onClick={() => setMode('sign-up')}
          >
            创建账户
          </button>
        </div>
        <h2 id="auth-title">{signingUp ? '创建账户' : '登录'}</h2>
        <p className="form-lede">
          {invited
            ? '请使用受邀工作邮箱登录以加入团队。'
            : signingUp
              ? '开始创建团队工作区。'
              : '返回团队收件箱。'}
        </p>
        <form onSubmit={submit}>
          {signingUp && <Field label="姓名" name="name" autoComplete="name" />}
          <Field label="工作邮箱" name="email" type="email" autoComplete="email" />
          <Field
            label="密码"
            name="password"
            type="password"
            autoComplete={signingUp ? 'new-password' : 'current-password'}
            minLength={8}
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy} type="submit">
            {busy ? '正在处理…' : signingUp ? '创建账户' : '登录'}
          </button>
        </form>
      </section>
    </main>
  )
}

function InviteAcceptance({
  token,
  onAccepted,
}: {
  token: string
  onAccepted: (workspaceId: string) => Promise<void>
}) {
  const started = useRef(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (started.current) return
    started.current = true
    void request('/api/invitations/accept', { token })
      .then((result) => onAccepted((result as { workspace: { id: string } }).workspace.id))
      .catch((cause) => setError(invitationErrorMessage(cause)))
  }, [onAccepted, token])

  return (
    <main className="loading" role={error ? 'alert' : undefined}>
      <span>DS</span>
      {error || '正在加入团队…'}
    </main>
  )
}

function Field({
  label,
  name,
  type = 'text',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; name: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input name={name} type={type} required {...props} />
    </label>
  )
}

function WorkspaceSetup({
  userName,
  onCreated,
}: {
  userName: string
  onCreated: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const data = new FormData(event.currentTarget)
      await request('/api/workspaces', { name: data.get('name') })
      await onCreated()
    } catch (cause) {
      setError(workspaceErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="setup-layout">
      <SignalRail />
      <section className="setup-card">
        <p className="eyebrow">欢迎，{userName}</p>
        <h1>为工作区命名</h1>
        <p>这里是团队与已连接 Facebook 公共主页的共享工作区。</p>
        <form onSubmit={submit}>
          <Field label="工作区名称" name="name" maxLength={100} autoFocus />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy} type="submit">
            {busy ? '创建中…' : '创建工作区'}
          </button>
        </form>
      </section>
    </main>
  )
}

function Shell({
  me,
  onSignOut,
  onWorkspaceChange,
}: {
  me: Me & { workspace: NonNullable<Me['workspace']> }
  onSignOut: () => void
  onWorkspaceChange: (workspaceId: string) => Promise<void>
}) {
  const teamPage = window.location.pathname === '/team'
  const facebookPage = window.location.pathname === '/settings/facebook'

  async function signOut() {
    await request('/api/auth/sign-out', {})
    localStorage.removeItem('activeWorkspaceId')
    history.replaceState(null, '', '/login')
    onSignOut()
  }

  return (
    <div className="shell">
      <header className="shell-header">
        <a className="shell-mark" href="/inbox" aria-label="DeepSales 收件箱">
          DS<span>●</span>
        </a>
        <div className="workspace-label">
          <small>工作区</small>
          {me.workspaces.length > 1 ? (
            <select
              aria-label="当前工作区"
              value={me.workspace.id}
              onChange={(event) => void onWorkspaceChange(event.currentTarget.value)}
            >
              {me.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          ) : (
            <strong>{me.workspace.name}</strong>
          )}
        </div>
        <nav aria-label="主要导航">
          <a aria-current={!teamPage && !facebookPage ? 'page' : undefined} href="/inbox">
            收件箱
          </a>
          <a aria-current={teamPage ? 'page' : undefined} href="/team">
            团队
          </a>
          <a href="/knowledge">知识库</a>
          <a aria-current={facebookPage ? 'page' : undefined} href="/settings/facebook">
            Facebook 设置
          </a>
        </nav>
        <button className="text-button" type="button" onClick={signOut}>
          退出登录
        </button>
      </header>
      {teamPage ? (
        <TeamPage workspace={me.workspace} />
      ) : facebookPage ? (
        <FacebookSettingsPage workspace={me.workspace} />
      ) : (
        <main className="inbox-empty">
          <div className="pulse" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <p className="eyebrow">共享收件箱 · 在线</p>
          <h1>收件箱已准备就绪</h1>
          <p>接下来连接一个 Facebook 公共主页，新的客户对话会显示在这里。</p>
          <dl>
            <div>
              <dt>你的角色</dt>
              <dd>{roleLabel(me.workspace.role)}</dd>
            </div>
            <div>
              <dt>登录账号</dt>
              <dd>{me.user.email}</dd>
            </div>
          </dl>
        </main>
      )}
    </div>
  )
}

const facebookStatusLabels: Record<FacebookChannel['connectionStatus'], string> = {
  ACTIVE: '正常',
  ACTION_REQUIRED: '需要处理',
  DISABLED: '已停用',
}

function FacebookSettingsPage({ workspace }: { workspace: Workspace }) {
  const [channels, setChannels] = useState<FacebookChannel[]>()
  const [pendingStateId, setPendingStateId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('oauthStateId'),
  )
  const [pages, setPages] = useState<FacebookPageOption[]>()
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const canManage = workspace.role !== 'AGENT'

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/workspaces/${workspace.id}/channels`)
    if (!response.ok) throw await responseError(response)
    setChannels(((await response.json()) as { channels: FacebookChannel[] }).channels)
  }, [workspace.id])

  useEffect(() => {
    void refresh().catch((cause) => setError(facebookErrorMessage(cause)))
  }, [refresh])

  useEffect(() => {
    if (!canManage || !pendingStateId) return
    void fetch(`/api/workspaces/${workspace.id}/facebook/oauth/${pendingStateId}/pages`)
      .then(async (response) => {
        if (!response.ok) throw await responseError(response)
        setPages(((await response.json()) as { pages: FacebookPageOption[] }).pages)
      })
      .catch((cause) => setError(facebookErrorMessage(cause)))
  }, [canManage, pendingStateId, workspace.id])

  async function connect() {
    setBusy('connect')
    setError('')
    try {
      const result = (await request(
        `/api/workspaces/${workspace.id}/facebook/oauth/start`,
        {},
      )) as { authorizationUrl: string }
      window.location.assign(result.authorizationUrl)
    } catch (cause) {
      setError(facebookErrorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function recheck(channel: FacebookChannel) {
    setBusy(channel.id)
    setError('')
    try {
      await request(`/api/workspaces/${workspace.id}/channels/${channel.id}/recheck`, {})
      await refresh()
    } catch (cause) {
      setError(facebookErrorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function selectPages(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!pendingStateId || !selectedPageIds.length) return
    setBusy('select')
    setError('')
    try {
      await request(`/api/workspaces/${workspace.id}/facebook/oauth/${pendingStateId}/pages`, {
        pageIds: selectedPageIds,
      })
      await refresh()
      setPages(undefined)
      setSelectedPageIds([])
      setPendingStateId(null)
      history.replaceState(null, '', '/settings/facebook')
    } catch (cause) {
      setError(facebookErrorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function disable(channel: FacebookChannel) {
    if (!window.confirm(`确定要停用“${channel.displayName}”吗？`)) return
    setBusy(channel.id)
    setError('')
    try {
      await request(`/api/workspaces/${workspace.id}/channels/${channel.id}/disable`, {})
      await refresh()
    } catch (cause) {
      setError(facebookErrorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  return (
    <main className="facebook-page">
      <div className="team-heading">
        <div>
          <p className="eyebrow">工作区 / Facebook</p>
          <h1>Facebook Page</h1>
          <p>连接 Page，检查 Messenger 订阅和访问权限。</p>
        </div>
        {canManage && (
          <button
            className="primary"
            disabled={busy === 'connect'}
            type="button"
            onClick={() => void connect()}
          >
            {busy === 'connect' ? '正在打开…' : '连接 Facebook Page'}
          </button>
        )}
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {pendingStateId && canManage && (
        <section className="facebook-picker">
          <p className="card-label">授权完成</p>
          <h2>选择要连接的 Page</h2>
          {!pages ? (
            <p>正在加载可用 Page…</p>
          ) : pages.length ? (
            <form onSubmit={selectPages}>
              <div className="facebook-page-options">
                {pages.map((page) => (
                  <label key={page.id}>
                    <input
                      type="checkbox"
                      checked={selectedPageIds.includes(page.id)}
                      onChange={(event) =>
                        setSelectedPageIds((current) =>
                          event.target.checked
                            ? [...current, page.id]
                            : current.filter((id) => id !== page.id),
                        )
                      }
                    />
                    {page.name}
                  </label>
                ))}
              </div>
              <button className="primary" disabled={busy === 'select'} type="submit">
                {busy === 'select' ? '正在连接…' : '连接所选 Page'}
              </button>
            </form>
          ) : (
            <p>没有可连接的 Facebook Page。</p>
          )}
        </section>
      )}
      {!channels ? (
        <p>正在加载 Facebook 连接…</p>
      ) : channels.length ? (
        <div className="facebook-list">
          {channels.map((channel) => (
            <section className="facebook-card" key={channel.id}>
              <div>
                <p className="card-label">Facebook Page</p>
                <h2>{channel.displayName}</h2>
                <p className="facebook-meta">
                  {facebookStatusLabels[channel.connectionStatus]}
                  {channel.lastCheckedAt && ` · 最近检查 ${formatDate(channel.lastCheckedAt)}`}
                </p>
                {(channel.lastErrorCode || channel.lastErrorMessage) && (
                  <p className="form-error">
                    连接需要处理 · {channel.lastErrorCode ?? 'FACEBOOK_CHECK_FAILED'}
                  </p>
                )}
              </div>
              {canManage && (
                <div className="member-actions">
                  <button
                    className="secondary"
                    disabled={Boolean(busy)}
                    type="button"
                    onClick={() => void connect()}
                  >
                    重新连接
                  </button>
                  <button
                    className="secondary"
                    disabled={Boolean(busy)}
                    type="button"
                    onClick={() => void recheck(channel)}
                  >
                    重新检查
                  </button>
                  <button
                    className="danger-button"
                    disabled={Boolean(busy) || channel.connectionStatus === 'DISABLED'}
                    type="button"
                    onClick={() => void disable(channel)}
                  >
                    停用
                  </button>
                </div>
              )}
            </section>
          ))}
        </div>
      ) : (
        <section className="facebook-empty">
          <p className="card-label">尚未连接</p>
          <p>连接第一个 Facebook Page，开始接收 Messenger 对话。</p>
        </section>
      )}
    </main>
  )
}

function TeamPage({ workspace }: { workspace: Workspace }) {
  const [team, setTeam] = useState<Team>()
  const [loadError, setLoadError] = useState('')
  const [invite, setInvite] = useState<Invitation>()
  const [inviteCopied, setInviteCopied] = useState(false)
  const canManage = workspace.role !== 'AGENT'

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/workspaces/${workspace.id}/team`)
    if (!response.ok) throw await responseError(response)
    setTeam((await response.json()) as Team)
  }, [workspace.id])

  useEffect(() => {
    setLoadError('')
    void refresh().catch((cause) => setLoadError(teamErrorMessage(cause)))
  }, [refresh])

  async function inviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    try {
      const result = (await request(`/api/workspaces/${workspace.id}/invitations`, {
        email: data.get('email'),
        role: data.get('role'),
        displayName: data.get('displayName'),
        available: data.get('available') === 'on',
        autoAssignmentEnabled: data.get('autoAssignmentEnabled') === 'on',
        maxActiveConversations: Number(data.get('maxActiveConversations')),
        channelIds: data.getAll('channelId').map(String),
      })) as { invitation: Invitation }
      setInvite(result.invitation)
      setInviteCopied(false)
      form.reset()
    } catch (cause) {
      setLoadError(teamErrorMessage(cause))
    }
  }

  async function createAi(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    try {
      await request(`/api/workspaces/${workspace.id}/members`, {
        type: 'AI',
        displayName: data.get('displayName'),
      })
      form.reset()
      await refresh()
    } catch (cause) {
      setLoadError(teamErrorMessage(cause))
    }
  }

  if (loadError && !team) {
    return (
      <main className="team-page" role="alert">
        <p className="form-error">{loadError}</p>
      </main>
    )
  }
  if (!team) return <main className="team-page">正在加载团队…</main>

  return (
    <main className="team-page">
      <div className="team-heading">
        <div>
          <p className="eyebrow">工作区 / 成员</p>
          <h1>团队</h1>
          <p>人工与 AI 成员共享同一服务身份。</p>
        </div>
        <span className="role-pill">{roleLabel(workspace.role)}</span>
      </div>

      {canManage && (
        <div className="team-actions">
          <form className="team-card" onSubmit={inviteMember}>
            <p className="card-label">邀请团队成员</p>
            <Field label="工作邮箱" name="email" type="email" autoComplete="off" />
            <Field label="显示名称" name="displayName" autoComplete="off" required={false} />
            <label className="field">
              <span>工作区角色</span>
              <select name="role" defaultValue="AGENT">
                <option value="AGENT">客服</option>
                <option value="ADMIN">管理员</option>
              </select>
            </label>
            <Field
              label="同时处理数"
              name="maxActiveConversations"
              type="number"
              min="0"
              max="10000"
              defaultValue="10"
            />
            <label className="check-field">
              <input name="autoAssignmentEnabled" type="checkbox" defaultChecked />
              自动分配
            </label>
            <label className="check-field">
              <input name="available" type="checkbox" defaultChecked />
              当前可用
            </label>
            <fieldset className="channel-fields">
              <legend>渠道权限</legend>
              {team.channels.length ? (
                team.channels.map((channel) => (
                  <label className="check-field" key={channel.id}>
                    <input name="channelId" type="checkbox" value={channel.id} />
                    {channel.displayName}
                  </label>
                ))
              ) : (
                <span className="muted">尚未连接任何渠道。</span>
              )}
            </fieldset>
            <button className="primary" type="submit">
              创建邀请链接
            </button>
          </form>

          <form className="team-card" onSubmit={createAi}>
            <p className="card-label">添加 AI 成员</p>
            <p className="card-copy">AI 工作区将提供配置和发布功能。</p>
            <Field label="显示名称" name="displayName" autoComplete="off" />
            <button className="primary" type="submit">
              添加 AI 成员
            </button>
          </form>
        </div>
      )}

      {invite && (
        <section className="invite-result" aria-live="polite">
          <div>
            <p className="card-label">一次性邀请链接</p>
            <p>
              将此链接分享给 {invite.email}。有效期至{' '}
              {new Date(invite.expiresAt).toLocaleString('zh-CN')}。
            </p>
          </div>
          <div className="invite-copy">
            <input aria-label="邀请链接" readOnly value={invite.url} />
            <button
              className="secondary"
              type="button"
              onClick={() => {
                if (navigator.clipboard) {
                  void navigator.clipboard.writeText(invite.url).then(() => setInviteCopied(true))
                }
              }}
            >
              {inviteCopied ? '已复制' : '复制链接'}
            </button>
          </div>
        </section>
      )}

      {loadError && (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      )}
      <section aria-labelledby="members-title">
        <div className="section-heading">
          <p className="card-label" id="members-title">
            成员
          </p>
          <span>{team.members.length}</span>
        </div>
        <div className="member-list">
          {team.members.map((member) => (
            <MemberEditor
              key={member.id}
              workspaceId={workspace.id}
              member={member}
              channels={team.channels}
              canManage={canManage}
              onChanged={refresh}
            />
          ))}
        </div>
      </section>
    </main>
  )
}

function MemberEditor({
  workspaceId,
  member,
  channels,
  canManage,
  onChanged,
}: {
  workspaceId: string
  member: TeamMember
  channels: TeamChannel[]
  canManage: boolean
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const owner = member.role === 'OWNER'

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    const data = new FormData(event.currentTarget)
    try {
      await request(
        `/api/workspaces/${workspaceId}/members/${member.id}`,
        {
          displayName: data.get('displayName'),
          status: data.get('status'),
          autoAssignmentEnabled: data.get('autoAssignmentEnabled') === 'on',
          maxActiveConversations: Number(data.get('maxActiveConversations')),
          ...(member.type === 'HUMAN' && !owner
            ? { role: data.get('role'), available: data.get('available') === 'on' }
            : member.type === 'HUMAN'
              ? { available: data.get('available') === 'on' }
              : {}),
          channelIds: data.getAll('channelId').map(String),
        },
        'PATCH',
      )
      await onChanged()
    } catch (cause) {
      window.alert(teamErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm(`确定要移除“${member.displayName ?? '该成员'}”吗？`)) return
    setBusy(true)
    try {
      await request(`/api/workspaces/${workspaceId}/members/${member.id}`, {}, 'DELETE')
      await onChanged()
    } catch (cause) {
      window.alert(teamErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="member-card" onSubmit={save}>
      <div className="member-summary">
        <div>
          <span className={`type-badge ${member.type.toLowerCase()}`}>
            {memberTypeLabels[member.type]}
          </span>
          <h2>{member.displayName ?? '未命名成员'}</h2>
          {member.email && <p>{member.email}</p>}
        </div>
        <div className="member-state">
          <span>
            {member.type === 'AI'
              ? member.configurationStatus
                ? configurationStatusLabels[member.configurationStatus]
                : ''
              : roleLabel(member.role)}
          </span>
          <strong>{lifecycleLabels[member.status]}</strong>
        </div>
      </div>
      <div className="member-fields">
        <Field
          label="显示名称"
          name="displayName"
          defaultValue={member.displayName ?? ''}
          disabled={!canManage}
        />
        <label className="field">
          <span>成员状态</span>
          <select name="status" defaultValue={member.status} disabled={!canManage || owner}>
            <option value="ACTIVE">启用</option>
            <option value="DISABLED">停用</option>
          </select>
        </label>
        {member.type === 'HUMAN' && !owner && (
          <label className="field">
            <span>角色</span>
            <select name="role" defaultValue={member.role ?? 'AGENT'} disabled={!canManage}>
              <option value="AGENT">客服</option>
              <option value="ADMIN">管理员</option>
            </select>
          </label>
        )}
        <label className="field">
          <span>同时处理数</span>
          <input
            name="maxActiveConversations"
            type="number"
            min="0"
            max="10000"
            defaultValue={member.maxActiveConversations}
            disabled={!canManage}
            required
          />
        </label>
        <label className="check-field">
          <input
            name="autoAssignmentEnabled"
            type="checkbox"
            defaultChecked={member.autoAssignmentEnabled}
            disabled={!canManage}
          />
          自动分配
        </label>
        {member.type === 'HUMAN' && (
          <label className="check-field">
            <input
              name="available"
              type="checkbox"
              defaultChecked={member.availability ?? false}
              disabled={!canManage}
            />
            当前可用
          </label>
        )}
      </div>
      <fieldset className="channel-fields" disabled={!canManage}>
        <legend>渠道权限</legend>
        {channels.length ? (
          channels.map((channel) => (
            <label className="check-field" key={channel.id}>
              <input
                name="channelId"
                type="checkbox"
                value={channel.id}
                defaultChecked={member.channelIds.includes(channel.id)}
              />
              {channel.displayName}
            </label>
          ))
        ) : (
          <span className="muted">尚未连接任何渠道。</span>
        )}
      </fieldset>
      {canManage && (
        <div className="member-actions">
          <button className="secondary" disabled={busy} type="submit">
            {busy ? '保存中…' : '保存更改'}
          </button>
          {!owner && (
            <button
              className="danger-button"
              disabled={busy}
              type="button"
              onClick={() => void remove()}
            >
              移除成员
            </button>
          )}
        </div>
      )}
    </form>
  )
}

function SignalRail() {
  return (
    <aside className="signal-rail" aria-hidden="true">
      <span>收件箱信号</span>
      <i />
      <i />
      <i />
    </aside>
  )
}

function Loading() {
  return (
    <main className="loading" aria-live="polite">
      <span>DS</span> 正在打开收件箱…
    </main>
  )
}

function Unavailable({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) {
  return (
    <main className="loading" role="alert">
      <span>DS</span>
      {message}
      <button className="text-button" type="button" onClick={() => void onRetry()}>
        重试
      </button>
    </main>
  )
}

async function request(
  path: string,
  body: unknown,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST',
) {
  const response = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await responseError(response)
  return response.json().catch(() => ({}))
}

async function responseError(response: Response): Promise<ApiError> {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string }
  }
  return new ApiError(payload.error?.code ?? 'REQUEST_FAILED')
}

function authenticationErrorMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) return '身份验证失败'
  return (
    {
      INVALID_EMAIL_OR_PASSWORD: '邮箱或密码不正确。',
      NOT_READY: 'DeepSales 尚未就绪，请稍后重试。',
      RATE_LIMITED: '尝试次数过多，请稍后再试。',
      USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: '此邮箱已存在账户。',
      VALIDATION_ERROR: '请检查邮箱和密码。',
    }[cause.code] ?? '身份验证失败'
  )
}

function workspaceErrorMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) return '工作区创建失败'
  return (
    {
      INVALID_REQUEST: '请输入工作区名称。',
      NOT_READY: 'DeepSales 尚未就绪，请稍后重试。',
      UNAUTHORIZED: '请重新登录以创建工作区。',
    }[cause.code] ?? '工作区创建失败'
  )
}

function invitationErrorMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) return '接受邀请失败。'
  return (
    {
      INVITATION_EMAIL_MISMATCH: '请使用受邀工作邮箱登录。',
      INVITATION_EXPIRED: '此邀请已过期。',
      INVITATION_INVALID: '此邀请链接无效。',
      INVITATION_USED: '此邀请已被使用。',
      ALREADY_MEMBER: '你已属于此工作区。',
    }[cause.code] ?? '接受邀请失败。'
  )
}

function teamErrorMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) return '团队信息更新失败。'
  return (
    {
      FORBIDDEN: '你没有管理此团队的权限。',
      ALREADY_MEMBER: '此邮箱已属于该工作区。',
      INVALID_REQUEST: '请检查团队设置后重试。',
      NOT_FOUND: '该成员已不存在。',
    }[cause.code] ?? '团队信息更新失败。'
  )
}

function facebookErrorMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'Facebook 连接失败，请稍后重试。'
  return (
    {
      FORBIDDEN: '你没有管理 Facebook Page 的权限。',
      FACEBOOK_PAGE_ALREADY_CONNECTED: '此 Facebook Page 已连接到其他工作区。',
      FACEBOOK_OAUTH_STATE_INVALID: '授权状态无效，请重新连接。',
      FACEBOOK_OAUTH_STATE_EXPIRED: '授权已过期，请重新连接。',
      FACEBOOK_OAUTH_STATE_USED: '授权已使用，请重新连接。',
      FACEBOOK_SUBSCRIPTION_FAILED: 'Messenger 订阅失败，请检查 Page 权限。',
      FACEBOOK_PROVIDER_ERROR: 'Facebook 服务暂时不可用，请稍后重试。',
    }[cause.code] ?? 'Facebook 连接失败，请稍后重试。'
  )
}

function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN')
}

function inviteToken() {
  if (window.location.pathname !== '/invite') return null
  return new URLSearchParams(window.location.search).get('token')
}

const root = document.getElementById('root')
if (!root) throw new Error('Application root is missing')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
