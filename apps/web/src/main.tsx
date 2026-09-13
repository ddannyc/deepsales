import {
  StrictMode,
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
} from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

type Me = {
  user: { id: string; name: string; email: string }
  workspace: {
    id: string
    name: string
    role: 'OWNER' | 'ADMIN' | 'AGENT'
    memberId: string
  } | null
}

function App() {
  const [me, setMe] = useState<Me | null>()

  const refresh = useCallback(async () => {
    const response = await fetch('/api/me')
    if (response.status === 401) return setMe(null)
    if (!response.ok) throw new Error('DeepSales is not ready. Check the database connection.')
    setMe((await response.json()) as Me)
  }, [])

  useEffect(() => {
    refresh().catch(() => setMe(null))
  }, [refresh])

  if (me === undefined) return <Loading />
  if (!me) return <Auth onAuthenticated={refresh} />
  if (!me.workspace) return <WorkspaceSetup userName={me.user.name} onCreated={refresh} />
  return (
    <Shell
      me={me as Me & { workspace: NonNullable<Me['workspace']> }}
      onSignOut={() => setMe(null)}
    />
  )
}

function Auth({ onAuthenticated }: { onAuthenticated: () => Promise<void> }) {
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
      setError(cause instanceof Error ? cause.message : 'Authentication failed')
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
          {signingUp ? 'Start your team workspace.' : 'Return to your team inbox.'}
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
      setError(cause instanceof Error ? cause.message : 'Workspace creation failed')
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
}: {
  me: Me & { workspace: NonNullable<Me['workspace']> }
  onSignOut: () => void
}) {
  async function signOut() {
    await request('/api/auth/sign-out', {})
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
          <strong>{me.workspace.name}</strong>
        </div>
        <nav aria-label="Primary navigation">
          <a aria-current="page" href="/inbox">
            Inbox
          </a>
          <a href="/team">Team</a>
          <a href="/knowledge">Knowledge</a>
          <a href="/settings/facebook">Facebook</a>
        </nav>
        <button className="text-button" type="button" onClick={signOut}>
          Sign out
        </button>
      </header>
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
    </div>
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

async function request(path: string, body: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
  if (!response.ok) throw new Error(payload.error?.message ?? 'Request failed')
  return payload
}

const root = document.getElementById('root')
if (!root) throw new Error('Application root is missing')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
