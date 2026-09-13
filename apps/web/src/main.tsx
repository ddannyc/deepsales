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
          ? 'DeepSales is not ready. Check the database connection.'
          : 'The inbox could not be loaded. Try again.',
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
        <p className="eyebrow">Facebook shared inbox</p>
        <h1 id="welcome-title">Keep every customer conversation in view.</h1>
        <p className="intro-copy">
          DeepSales gives your human and AI team one calm place to pick up Messenger work.
        </p>
        <ol className="flow">
          <li>
            <span>Message arrives</span>
            <small>Facebook Messenger</small>
          </li>
          <li>
            <span>Best member responds</span>
            <small>Human or AI</small>
          </li>
          <li>
            <span>Team stays in control</span>
            <small>One shared record</small>
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
            aria-label="Sign in view"
            aria-pressed={!signingUp}
            onClick={() => setMode('sign-in')}
          >
            Sign in
          </button>
          <button
            type="button"
            aria-label="Create account view"
            aria-pressed={signingUp}
            onClick={() => setMode('sign-up')}
          >
            Create account
          </button>
        </div>
        <h2 id="auth-title">{signingUp ? 'Create account' : 'Sign in'}</h2>
        <p className="form-lede">
          {invited
            ? 'Sign in with the invited work email to join the team.'
            : signingUp
              ? 'Start your team workspace.'
              : 'Return to your team inbox.'}
        </p>
        <form onSubmit={submit}>
          {signingUp && <Field label="Full name" name="name" autoComplete="name" />}
          <Field label="Work email" name="email" type="email" autoComplete="email" />
          <Field
            label="Password"
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
            {busy ? 'Working…' : signingUp ? 'Create account' : 'Sign in'}
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
      {error || 'Joining your team…'}
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
        <p className="eyebrow">Welcome, {userName}</p>
        <h1>Name your workspace</h1>
        <p>This is the shared home for your team and connected Facebook Pages.</p>
        <form onSubmit={submit}>
          <Field label="Workspace name" name="name" maxLength={100} autoFocus />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy} type="submit">
            {busy ? 'Creating…' : 'Create workspace'}
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

  async function signOut() {
    await request('/api/auth/sign-out', {})
    localStorage.removeItem('activeWorkspaceId')
    history.replaceState(null, '', '/login')
    onSignOut()
  }

  return (
    <div className="shell">
      <header className="shell-header">
        <a className="shell-mark" href="/inbox" aria-label="DeepSales inbox">
          DS<span>●</span>
        </a>
        <div className="workspace-label">
          <small>Workspace</small>
          {me.workspaces.length > 1 ? (
            <select
              aria-label="Active workspace"
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
        <nav aria-label="Primary navigation">
          <a aria-current={teamPage ? undefined : 'page'} href="/inbox">
            Inbox
          </a>
          <a aria-current={teamPage ? 'page' : undefined} href="/team">
            Team
          </a>
          <a href="/knowledge">Knowledge</a>
          <a href="/settings/facebook">Facebook</a>
        </nav>
        <button className="text-button" type="button" onClick={signOut}>
          Sign out
        </button>
      </header>
      {teamPage ? (
        <TeamPage workspace={me.workspace} />
      ) : (
        <main className="inbox-empty">
          <div className="pulse" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <p className="eyebrow">Shared inbox · online</p>
          <h1>Inbox, ready when you are.</h1>
          <p>Connect a Facebook Page next. New customer conversations will land here.</p>
          <dl>
            <div>
              <dt>Your role</dt>
              <dd>{me.workspace.role}</dd>
            </div>
            <div>
              <dt>Signed in as</dt>
              <dd>{me.user.email}</dd>
            </div>
          </dl>
        </main>
      )}
    </div>
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
    const data = new FormData(event.currentTarget)
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
      event.currentTarget.reset()
    } catch (cause) {
      setLoadError(teamErrorMessage(cause))
    }
  }

  async function createAi(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      await request(`/api/workspaces/${workspace.id}/members`, {
        type: 'AI',
        displayName: data.get('displayName'),
      })
      event.currentTarget.reset()
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
  if (!team) return <main className="team-page">Loading team…</main>

  return (
    <main className="team-page">
      <div className="team-heading">
        <div>
          <p className="eyebrow">Workspace / people</p>
          <h1>Team</h1>
          <p>Human and AI members share one service identity.</p>
        </div>
        <span className="role-pill">{workspace.role}</span>
      </div>

      {canManage && (
        <div className="team-actions">
          <form className="team-card" onSubmit={inviteMember}>
            <p className="card-label">Invite a teammate</p>
            <Field label="Work email" name="email" type="email" autoComplete="off" />
            <Field label="Display name" name="displayName" autoComplete="off" required={false} />
            <label className="field">
              <span>Workspace role</span>
              <select name="role" defaultValue="AGENT">
                <option value="AGENT">Agent</option>
                <option value="ADMIN">Admin</option>
              </select>
            </label>
            <Field
              label="Capacity"
              name="maxActiveConversations"
              type="number"
              min="0"
              max="10000"
              defaultValue="10"
            />
            <label className="check-field">
              <input name="autoAssignmentEnabled" type="checkbox" defaultChecked />
              Auto-assignment
            </label>
            <label className="check-field">
              <input name="available" type="checkbox" defaultChecked />
              Available now
            </label>
            <fieldset className="channel-fields">
              <legend>Channel access</legend>
              {team.channels.length ? (
                team.channels.map((channel) => (
                  <label className="check-field" key={channel.id}>
                    <input name="channelId" type="checkbox" value={channel.id} />
                    {channel.displayName}
                  </label>
                ))
              ) : (
                <span className="muted">No channels connected yet.</span>
              )}
            </fieldset>
            <button className="primary" type="submit">
              Create invite link
            </button>
          </form>

          <form className="team-card" onSubmit={createAi}>
            <p className="card-label">Add an AI member</p>
            <p className="card-copy">Configuration and publishing arrive in the AI workspace.</p>
            <Field label="Display name" name="displayName" autoComplete="off" />
            <button className="primary" type="submit">
              Add AI member
            </button>
          </form>
        </div>
      )}

      {invite && (
        <section className="invite-result" aria-live="polite">
          <div>
            <p className="card-label">One-time invite link</p>
            <p>
              Share this link with {invite.email}. It expires{' '}
              {new Date(invite.expiresAt).toLocaleString()}.
            </p>
          </div>
          <div className="invite-copy">
            <input aria-label="Invite link" readOnly value={invite.url} />
            <button
              className="secondary"
              type="button"
              onClick={() => {
                if (navigator.clipboard) {
                  void navigator.clipboard.writeText(invite.url).then(() => setInviteCopied(true))
                }
              }}
            >
              {inviteCopied ? 'Copied' : 'Copy link'}
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
            Members
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
    if (!window.confirm(`Remove ${member.displayName ?? 'this member'}?`)) return
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
          <span className={`type-badge ${member.type.toLowerCase()}`}>{member.type}</span>
          <h2>{member.displayName ?? 'Unnamed member'}</h2>
          {member.email && <p>{member.email}</p>}
        </div>
        <div className="member-state">
          <span>{member.type === 'AI' ? member.configurationStatus : member.role}</span>
          <strong>{member.status}</strong>
        </div>
      </div>
      <div className="member-fields">
        <Field
          label="Display name"
          name="displayName"
          defaultValue={member.displayName ?? ''}
          disabled={!canManage}
        />
        <label className="field">
          <span>Lifecycle</span>
          <select name="status" defaultValue={member.status} disabled={!canManage || owner}>
            <option value="ACTIVE">Active</option>
            <option value="DISABLED">Disabled</option>
          </select>
        </label>
        {member.type === 'HUMAN' && !owner && (
          <label className="field">
            <span>Role</span>
            <select name="role" defaultValue={member.role ?? 'AGENT'} disabled={!canManage}>
              <option value="AGENT">Agent</option>
              <option value="ADMIN">Admin</option>
            </select>
          </label>
        )}
        <label className="field">
          <span>Capacity</span>
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
          Auto-assignment
        </label>
        {member.type === 'HUMAN' && (
          <label className="check-field">
            <input
              name="available"
              type="checkbox"
              defaultChecked={member.availability ?? false}
              disabled={!canManage}
            />
            Available now
          </label>
        )}
      </div>
      <fieldset className="channel-fields" disabled={!canManage}>
        <legend>Channel access</legend>
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
          <span className="muted">No channels connected yet.</span>
        )}
      </fieldset>
      {canManage && (
        <div className="member-actions">
          <button className="secondary" disabled={busy} type="submit">
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          {!owner && (
            <button
              className="danger-button"
              disabled={busy}
              type="button"
              onClick={() => void remove()}
            >
              Remove
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
      <span>INBOX SIGNAL</span>
      <i />
      <i />
      <i />
    </aside>
  )
}

function Loading() {
  return (
    <main className="loading" aria-live="polite">
      <span>DS</span> Opening inbox…
    </main>
  )
}

function Unavailable({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) {
  return (
    <main className="loading" role="alert">
      <span>DS</span>
      {message}
      <button className="text-button" type="button" onClick={() => void onRetry()}>
        Retry
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
  if (!(cause instanceof ApiError)) return 'Authentication failed'
  return (
    {
      INVALID_EMAIL_OR_PASSWORD: 'Email or password is incorrect.',
      NOT_READY: 'DeepSales is not ready. Try again shortly.',
      RATE_LIMITED: 'Too many attempts. Try again later.',
      USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'An account already exists for this email.',
      VALIDATION_ERROR: 'Check your email and password.',
    }[cause.code] ?? 'Authentication failed'
  )
}

function workspaceErrorMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'Workspace creation failed'
  return (
    {
      INVALID_REQUEST: 'Enter a workspace name.',
      NOT_READY: 'DeepSales is not ready. Try again shortly.',
      UNAUTHORIZED: 'Sign in again to create a workspace.',
    }[cause.code] ?? 'Workspace creation failed'
  )
}

function invitationErrorMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'Invitation acceptance failed.'
  return (
    {
      INVITATION_EMAIL_MISMATCH: 'Sign in with the invited work email.',
      INVITATION_EXPIRED: 'This invitation has expired.',
      INVITATION_INVALID: 'This invitation link is not valid.',
      INVITATION_USED: 'This invitation has already been used.',
      ALREADY_MEMBER: 'You already belong to this workspace.',
    }[cause.code] ?? 'Invitation acceptance failed.'
  )
}

function teamErrorMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'Team could not be updated.'
  return (
    {
      FORBIDDEN: 'You do not have permission to manage this team.',
      ALREADY_MEMBER: 'That email already belongs to this workspace.',
      INVALID_REQUEST: 'Check the team settings and try again.',
      NOT_FOUND: 'That member no longer exists.',
    }[cause.code] ?? 'Team could not be updated.'
  )
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
