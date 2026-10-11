import {
  AlertCircle,
  ArrowLeft,
  ArrowRightLeft,
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Copy,
  Inbox as InboxIcon,
  ListFilter,
  LogOut,
  type LucideIcon,
  MessageCircle,
  MoreHorizontal,
  RefreshCw,
  Send,
  Settings2,
  UserRound,
  UserRoundCheck,
  UserRoundX,
  UsersRound,
  XCircle,
} from 'lucide-react'
import {
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  StrictMode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
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
import { Avatar, AvatarFallback } from '#components/ui/avatar'
import { Badge } from '#components/ui/badge'
import { Button } from '#components/ui/button'
import { Checkbox } from '#components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu'
import { Input } from '#components/ui/input'
import { ScrollArea } from '#components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select'
import { Separator } from '#components/ui/separator'
import { Skeleton } from '#components/ui/skeleton'
import { Toaster } from '#components/ui/sonner'
import { StatusBadge } from '#components/ui/status-badge'
import { Switch } from '#components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#components/ui/table'
import { Textarea } from '#components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '#components/ui/tooltip'
import { AiOperations } from './ai-operations'
import { CustomerSidebar } from './customer-sidebar'
import { DemoPage } from './demo'
import { InboxFilterControls, type InboxFilters, inboxQuery } from './inbox-filters'
import { InternalNotes } from './internal-notes'
import { LandingPage } from './landing'
import { ReplyContent } from './reply-content'

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

type InvitationKind = 'WORKSPACE_MEMBER' | 'WORKSPACE_CREATOR'
type InvitationDetails = { type: InvitationKind; expiresAt: string; workspaceName?: string }

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
  configurationStatus: 'UNPUBLISHED' | 'USABLE' | 'UNHEALTHY' | null
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

type InboxView = InboxFilters['view']
type InboxConversation = {
  muted: boolean
  unread: boolean
  unanswered: boolean
  id: string
  status: 'OPEN' | 'CLOSED'
  routingConstraint: 'ANY_MEMBER' | 'HUMAN_ONLY'
  queueReason: string | null
  routingQueuedAt: string | null
  latestMessageAt: string | null
  lastCustomerMessageAt: string | null
  updatedAt: string
  customerId: string
  customerName: string | null
  channelId: string
  channelName: string
  assigneeMemberId: string | null
  assigneeName: string | null
  assigneeType: 'HUMAN' | 'AI' | null
  aiGenerating: boolean
  latestPreview: string | null
  replyWindowOpen: boolean
  replyWindowEligibleUntil: string | null
  failedMessage: boolean
}
type InboxMessage = {
  delivered: boolean
  read: boolean
  id: string
  direction: 'INBOUND' | 'OUTBOUND'
  senderType: 'CUSTOMER' | 'MEMBER' | 'EXTERNAL'
  senderMemberId: string | null
  messageType: 'TEXT' | 'ATTACHMENT'
  text: string | null
  externalMessageId: string | null
  providerSentAt: string | null
  deliveryState: 'PENDING' | 'SENT' | 'FAILED' | null
  failureCode: string | null
  failureMessage: string | null
  replyGroupId?: string | null
  replySegmentIndex?: number | null
  replySegmentCount?: number | null
  createdAt: string
  attachments: InboxAttachment[]
}
type InboxAttachment = {
  id: string
  kind: 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO'
  filename: string | null
  mimeType: string | null
  byteSize: number | null
  storageState: 'PENDING' | 'READY' | 'FAILED'
  failureCode: string | null
}
type InboxPageData = { conversations: InboxConversation[]; nextCursor: string | null }

function mergeInboxMessages(current: InboxMessage[], incoming: InboxMessage[]) {
  const messagesById = new Map(current.map((message) => [message.id, message]))
  let changed = false

  for (const message of incoming) {
    const previous = messagesById.get(message.id)
    if (previous && sameInboxMessage(previous, message)) continue
    messagesById.set(message.id, message)
    changed = true
  }

  return changed
    ? [...messagesById.values()].sort(
        (first, second) =>
          first.createdAt
            .slice(0, -1)
            .padEnd(26, '0')
            .localeCompare(second.createdAt.slice(0, -1).padEnd(26, '0')) ||
          first.id.localeCompare(second.id),
      )
    : current
}

function sameInboxMessage(first: InboxMessage, second: InboxMessage) {
  return (
    first.id === second.id &&
    first.direction === second.direction &&
    first.senderType === second.senderType &&
    first.senderMemberId === second.senderMemberId &&
    first.messageType === second.messageType &&
    first.text === second.text &&
    first.externalMessageId === second.externalMessageId &&
    first.providerSentAt === second.providerSentAt &&
    first.deliveryState === second.deliveryState &&
    first.delivered === second.delivered &&
    first.read === second.read &&
    first.failureCode === second.failureCode &&
    first.failureMessage === second.failureMessage &&
    first.replyGroupId === second.replyGroupId &&
    first.replySegmentIndex === second.replySegmentIndex &&
    first.replySegmentCount === second.replySegmentCount &&
    first.createdAt === second.createdAt &&
    first.attachments.length === second.attachments.length &&
    first.attachments.every((attachment, index) => {
      const next = second.attachments[index]
      return (
        next !== undefined &&
        attachment.id === next.id &&
        attachment.kind === next.kind &&
        attachment.filename === next.filename &&
        attachment.mimeType === next.mimeType &&
        attachment.byteSize === next.byteSize &&
        attachment.storageState === next.storageState &&
        attachment.failureCode === next.failureCode
      )
    })
  )
}

type Invitation = {
  url: string
  email: string
  role: 'ADMIN' | 'AGENT'
  expiresAt: string
}

type KnowledgeBase = {
  id: string
  workspaceId: string
  name: string
  createdAt: string
  updatedAt: string
}

type KnowledgeDocument = {
  mediaAvailable?: boolean
  mediaAssetId?: string | null
  id: string
  workspaceId: string
  knowledgeBaseId: string
  name: string
  sourceType: 'TEXT' | 'PDF' | 'DOCX' | 'TXT' | 'MARKDOWN'
  question: string | null
  answer: string | null
  revision: number
  status: 'UPLOADED' | 'PROCESSING' | 'READY' | 'FAILED'
  contentSha256: string | null
  failureCode: string | null
  failureMessage: string | null
  processingStartedAt: string | null
  createdAt: string
  updatedAt: string
}

type AiMemberRuntimeSnapshot = {
  splitRepliesEnabled?: boolean
  automaticLanguageEnabled?: boolean
  timeZone?: string
  naturalToneEnabled?: boolean
  replyWaitEnabled?: boolean
  adLearningEnabled?: boolean
  adMappings?: { adId: string; content: string }[]
  instructions: string
  responseLanguage: string
  knowledgeBaseId: string
  handoffOnCustomerRequest: boolean
  handoffOnNoKnowledge: boolean
  handoffOnNegativeSentiment: boolean
  handoffOnUnableToAnswer: boolean
  handoffKeywords: string[]
}

type AiMemberConfig = {
  splitRepliesEnabled: boolean
  automaticLanguageEnabled: boolean
  timeZone: string
  naturalToneEnabled: boolean
  replyWaitEnabled: boolean
  adLearningEnabled: boolean
  adMappings: { adId: string; content: string }[]
  memberId: string
  memberDisplayName: string | null
  memberStatus: 'ACTIVE' | 'DISABLED'
  instructions: string
  responseLanguage: string
  knowledgeBaseId: string | null
  handoffOnCustomerRequest: boolean
  handoffOnNoKnowledge: boolean
  handoffOnNegativeSentiment: boolean
  handoffOnUnableToAnswer: boolean
  handoffKeywords: string[]
  publishedSnapshot: AiMemberRuntimeSnapshot | null
  publishedAt: string | null
  publishedVersionId: string | null
  runtimeStatus: 'UNPUBLISHED' | 'USABLE' | 'UNHEALTHY'
  runtimeError: string | null
}

type AiMemberDraft = Pick<
  AiMemberConfig,
  | 'instructions'
  | 'responseLanguage'
  | 'knowledgeBaseId'
  | 'handoffOnCustomerRequest'
  | 'handoffOnNoKnowledge'
  | 'handoffOnNegativeSentiment'
  | 'handoffOnUnableToAnswer'
  | 'handoffKeywords'
  | 'adLearningEnabled'
  | 'adMappings'
  | 'naturalToneEnabled'
  | 'replyWaitEnabled'
  | 'automaticLanguageEnabled'
  | 'timeZone'
  | 'splitRepliesEnabled'
>

class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string = code,
  ) {
    super(message)
  }
}

const roleLabels: Record<Workspace['role'], string> = {
  OWNER: '所有者',
  ADMIN: '管理员',
  AGENT: '客服',
}
const lifecycleLabels: Record<TeamMember['status'], string> = {
  ACTIVE: '启用',
  DISABLED: '停用',
}
const runtimeStatusLabels: Record<AiMemberConfig['runtimeStatus'], string> = {
  UNPUBLISHED: '未发布',
  USABLE: '可用',
  UNHEALTHY: '需检查',
}

function roleLabel(role: Workspace['role'] | null) {
  return role ? roleLabels[role] : ''
}

function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  backHref,
}: {
  title: string
  description?: string
  eyebrow?: string
  actions?: ReactNode
  backHref?: string
}) {
  return (
    <header className="page-header">
      <div className="page-header-copy">
        {backHref && (
          <Button asChild className="page-back-link" size="sm" variant="ghost">
            <a href={backHref}>
              <ArrowLeft aria-hidden="true" />
              返回团队
            </a>
          </Button>
        )}
        {eyebrow && <p className="page-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  )
}

function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <section className="empty-state">
      <h2>{title}</h2>
      <p>{description}</p>
      {action && <div className="empty-state-action">{action}</div>}
    </section>
  )
}

function OperationalListSkeleton() {
  return (
    <div aria-hidden="true" className="operational-skeleton">
      {[0, 1, 2].map((row) => (
        <div className="operational-skeleton-row" key={row}>
          <Skeleton className="operational-skeleton-main" />
          <Skeleton className="operational-skeleton-meta" />
          <Skeleton className="operational-skeleton-action" />
        </div>
      ))}
    </div>
  )
}

function StateBadge({
  status,
  label,
  className,
  'data-runtime-status': runtimeStatus,
}: {
  status: string
  label: string
  className?: string
  'data-runtime-status'?: string
}) {
  return (
    <StatusBadge
      className={className}
      data-runtime-status={runtimeStatus}
      data-status={status}
      tone={statusTone(status)}
    >
      {label}
    </StatusBadge>
  )
}

function ConfirmActionDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  busyLabel,
  busy,
  error,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  busyLabel: string
  busy: boolean
  error: string
  onConfirm: () => Promise<void>
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            variant="destructive"
            onClick={(event) => {
              event.preventDefault()
              void onConfirm()
            }}
          >
            {busy ? busyLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function App() {
  const [me, setMe] = useState<Me | null>()
  const [loadError, setLoadError] = useState('')
  const [pendingInviteToken, setPendingInviteToken] = useState(() => inviteToken())
  const pathname = window.location.pathname
  const registrationPath = ['/sign-up', '/signup', '/register'].includes(pathname)
  const invitePath = pathname === '/invite' || (registrationPath && Boolean(pendingInviteToken))
  const publicPath =
    pathname === '/' ||
    pathname === '/en' ||
    pathname === '/demo' ||
    pathname === '/en/demo' ||
    invitePath ||
    registrationPath

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
      if (publicPath) {
        setMe(null)
        return
      }
      setLoadError(
        cause instanceof ApiError && cause.code === 'NOT_READY'
          ? 'DeepSales 尚未就绪，请检查数据库连接。'
          : '收件箱加载失败，请重试。',
      )
    }
  }, [publicPath, refresh])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (me === undefined) return
    if (me === null && !publicPath && pathname !== '/login') {
      history.replaceState(null, '', '/login')
    } else if (me && pathname === '/login') {
      history.replaceState(null, '', me.workspace ? '/inbox' : '/workspace/setup')
    }
  }, [me, pathname, publicPath])

  if (loadError) return <Unavailable message={loadError} onRetry={load} />
  if (me === undefined) {
    if (pathname === '/') return <LandingPage authenticated={false} locale="zh" />
    if (pathname === '/en') return <LandingPage authenticated={false} locale="en" />
    if (pathname === '/demo') return <DemoPage locale="zh" />
    if (pathname === '/en/demo') return <DemoPage locale="en" />
    if (registrationPath && !pendingInviteToken) return <PrivateBetaPage />
    return <Loading />
  }
  if (!me) {
    if (pathname === '/') return <LandingPage authenticated={false} locale="zh" />
    if (pathname === '/en') return <LandingPage authenticated={false} locale="en" />
    if (pathname === '/demo') return <DemoPage locale="zh" />
    if (pathname === '/en/demo') return <DemoPage locale="en" />
    if (invitePath) {
      return pendingInviteToken ? (
        <InvitationAuth
          token={pendingInviteToken}
          onAuthenticated={async (signedUp, invitationType) => {
            await refresh()
            if (signedUp) {
              setPendingInviteToken(null)
              history.replaceState(
                null,
                '',
                invitationType === 'WORKSPACE_CREATOR' ? '/workspace/setup' : '/team',
              )
            }
          }}
        />
      ) : (
        <InvitationState code="INVITATION_INVALID" />
      )
    }
    if (registrationPath) return <PrivateBetaPage />
    return <Auth onAuthenticated={refresh} invitationToken={null} />
  }
  if (registrationPath && !pendingInviteToken) return <PrivateBetaPage />
  if (invitePath && !pendingInviteToken) return <InvitationState code="INVITATION_INVALID" />
  if (pendingInviteToken) {
    return (
      <InviteAcceptance
        token={pendingInviteToken}
        onAccepted={async (accepted) => {
          setPendingInviteToken(null)
          if (accepted.type === 'WORKSPACE_MEMBER' && accepted.workspace) {
            localStorage.setItem('activeWorkspaceId', accepted.workspace.id)
            history.replaceState(null, '', '/team')
          } else {
            history.replaceState(null, '', '/workspace/setup')
          }
          await refresh()
        }}
      />
    )
  }
  if (pathname === '/') return <LandingPage authenticated locale="zh" />
  if (pathname === '/en') return <LandingPage authenticated locale="en" />
  if (pathname === '/demo') return <DemoPage locale="zh" />
  if (pathname === '/en/demo') return <DemoPage locale="en" />
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
  invitationToken,
  invitationType,
  workspaceName,
}: {
  onAuthenticated: (signedUp: boolean, invitationType?: InvitationKind) => Promise<void>
  invitationToken: string | null
  invitationType?: InvitationKind
  workspaceName?: string
}) {
  const invited = Boolean(invitationToken)
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>(invited ? 'sign-up' : 'sign-in')
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
        ...(signingUp && invitationToken ? { invitationToken } : {}),
      })
      await onAuthenticated(signingUp, invitationType)
    } catch (cause) {
      setError(authenticationErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const signingUp = mode === 'sign-up'
  return (
    <main className="auth-page">
      <section aria-labelledby="auth-title" className="auth-card">
        <div className="auth-brand">
          <span className="auth-brand-mark">DS</span>
          <span>DeepSales</span>
        </div>
        <div className="auth-heading">
          <h1 id="auth-title">{signingUp ? '创建账户' : '登录'}</h1>
          <p>
            {invitationType === 'WORKSPACE_CREATOR'
              ? signingUp
                ? '你已获得 DeepSales 邀请测试资格。注册后即可创建自己的工作区。'
                : '登录后即可继续创建自己的工作区。'
              : invited
                ? signingUp
                  ? workspaceName
                    ? `请使用受邀工作邮箱创建账户以加入 ${workspaceName}。`
                    : '请使用受邀工作邮箱创建账户以加入团队。'
                  : workspaceName
                    ? `请使用受邀工作邮箱登录以加入 ${workspaceName}。`
                    : '请使用受邀工作邮箱登录以加入团队。'
                : '登录 DeepSales 团队收件箱。'}
          </p>
          {!invited && (
            <p className="auth-notice" role="note">
              DeepSales 目前处于邀请测试阶段，仅限受邀用户注册。
              <br />
              <span lang="en">
                DeepSales is currently in private beta. Registration is available by invitation
                only.
              </span>
            </p>
          )}
        </div>
        {invited && (
          <fieldset className="auth-mode-switch">
            <legend className="sr-only">账户操作</legend>
            <Button
              aria-label="登录视图"
              aria-pressed={!signingUp}
              size="sm"
              variant={signingUp ? 'ghost' : 'secondary'}
              onClick={() => setMode('sign-in')}
            >
              登录
            </Button>
            <Button
              aria-label="创建账户视图"
              aria-pressed={signingUp}
              size="sm"
              variant={signingUp ? 'secondary' : 'ghost'}
              onClick={() => setMode('sign-up')}
            >
              创建账户
            </Button>
          </fieldset>
        )}
        <form className="auth-form" onSubmit={submit}>
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
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <Button aria-busy={busy} className="auth-submit" disabled={busy} type="submit">
            {busy ? '正在处理…' : signingUp ? '创建账户' : '登录'}
          </Button>
        </form>
      </section>
    </main>
  )
}

function PrivateBetaPage() {
  return (
    <main className="auth-page">
      <section aria-labelledby="private-beta-title" className="auth-card">
        <div className="auth-brand">
          <span className="auth-brand-mark">DS</span>
          <span>DeepSales</span>
        </div>
        <div className="auth-heading">
          <h1 id="private-beta-title">Private Beta</h1>
          <p>DeepSales is currently in private beta.</p>
          <p>Registration is available by invitation only.</p>
          <p className="auth-notice" role="note">
            DeepSales 目前处于邀请测试阶段，仅限受邀用户注册。
          </p>
        </div>
        <div className="auth-status-actions">
          <Button asChild>
            <a href="/login">Sign in / 登录</a>
          </Button>
        </div>
      </section>
    </main>
  )
}

function InvitationAuth({
  token,
  onAuthenticated,
}: {
  token: string
  onAuthenticated: (signedUp: boolean, invitationType?: InvitationKind) => Promise<void>
}) {
  const [status, setStatus] = useState<'checking' | 'valid' | 'invalid'>('checking')
  const [errorCode, setErrorCode] = useState('INVITATION_INVALID')
  const [invitation, setInvitation] = useState<InvitationDetails>()

  useEffect(() => {
    let active = true
    void fetch(`/api/invitations/${encodeURIComponent(token)}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw await responseError(response)
        const result = (await response.json()) as { invitation: InvitationDetails }
        if (active) {
          setInvitation(result.invitation)
          setStatus('valid')
        }
      })
      .catch((cause) => {
        if (!active) return
        setErrorCode(cause instanceof ApiError ? cause.code : 'INVITATION_INVALID')
        setStatus('invalid')
      })
    return () => {
      active = false
    }
  }, [token])

  if (status === 'checking') return <Loading />
  if (status === 'invalid') return <InvitationState code={errorCode} />
  return (
    <Auth
      invitationToken={token}
      invitationType={invitation?.type}
      workspaceName={invitation?.workspaceName}
      onAuthenticated={onAuthenticated}
    />
  )
}

function InvitationState({ code }: { code: string }) {
  const copy = {
    INVITATION_EXPIRED: {
      title: '邀请已过期',
      message: 'This invitation has expired.',
    },
    INVITATION_USED: {
      title: '邀请已使用',
      message: 'This invitation has already been used.',
    },
    INVITATION_EMAIL_MISMATCH: {
      title: '邀请邮箱不匹配',
      message: 'This invitation is for a different email address.',
    },
    WORKSPACE_ALREADY_EXISTS: {
      title: '账号已有工作区',
      message: 'This account already belongs to a workspace.',
    },
  }[code] ?? {
    title: '邀请无效',
    message: 'This invitation is invalid.',
  }

  return (
    <main className="auth-page">
      <section aria-labelledby="invitation-state-title" className="auth-card">
        <div className="auth-brand">
          <span className="auth-brand-mark">DS</span>
          <span>DeepSales</span>
        </div>
        <div className="auth-heading">
          <h1 id="invitation-state-title">{copy.title}</h1>
          <p role="alert">{copy.message}</p>
        </div>
        <div className="auth-status-actions">
          <Button asChild>
            <a href="/login">Sign in / 登录</a>
          </Button>
        </div>
      </section>
    </main>
  )
}

function InviteAcceptance({
  token,
  onAccepted,
}: {
  token: string
  onAccepted: (accepted: { type: InvitationKind; workspace?: { id: string } }) => Promise<void>
}) {
  const started = useRef(false)
  const [errorCode, setErrorCode] = useState<string>()

  useEffect(() => {
    if (started.current) return
    started.current = true
    void request('/api/invitations/accept', { token })
      .then((result) => onAccepted(result as { type: InvitationKind; workspace?: { id: string } }))
      .catch((cause) => setErrorCode(cause instanceof ApiError ? cause.code : 'INVITATION_INVALID'))
  }, [onAccepted, token])

  return errorCode ? <InvitationState code={errorCode} /> : <Loading />
}

function Field({
  label,
  name,
  type = 'text',
  id = name,
  description,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string
  name: string
  description?: string
}) {
  const descriptionId = description ? `${id}-description` : undefined

  return (
    <div className="form-field">
      <label className="form-field-label" htmlFor={id}>
        {label}
        {props.required === false && <span className="field-optional">可选</span>}
      </label>
      <Input aria-describedby={descriptionId} id={id} name={name} required type={type} {...props} />
      {description && (
        <span className="field-description" id={descriptionId}>
          {description}
        </span>
      )}
    </div>
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
      const result = (await request('/api/workspaces', {
        name: data.get('name'),
      })) as { workspace: { id: string } }
      localStorage.setItem('activeWorkspaceId', result.workspace.id)
      history.replaceState(null, '', '/inbox')
      await onCreated()
    } catch (cause) {
      setError(workspaceErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <section aria-labelledby="workspace-setup-title" className="auth-card">
        <div className="auth-brand">
          <span className="auth-brand-mark">DS</span>
          <span>DeepSales</span>
        </div>
        <p className="auth-greeting">欢迎，{userName}</p>
        <div className="auth-heading">
          <h1 id="workspace-setup-title">为工作区命名</h1>
          <p>设置团队共享 Messenger 收件箱的工作区名称。</p>
        </div>
        <form className="auth-form" onSubmit={submit}>
          <Field label="工作区名称" name="name" maxLength={100} autoFocus />
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <Button aria-busy={busy} className="auth-submit" disabled={busy} type="submit">
            {busy ? '创建中…' : '创建工作区'}
          </Button>
        </form>
      </section>
    </main>
  )
}
const appNavItems = [
  { href: '/inbox', label: '收件箱', icon: InboxIcon },
  { href: '/team', label: '团队', icon: UsersRound },
  { href: '/knowledge', label: '知识库', icon: BookOpen },
  { href: '/settings/facebook', label: 'Facebook 设置', icon: Settings2 },
] as const

function Shell({
  me,
  onSignOut,
  onWorkspaceChange,
}: {
  me: Me & { workspace: NonNullable<Me['workspace']> }
  onSignOut: () => void
  onWorkspaceChange: (workspaceId: string) => Promise<void>
}) {
  const pathname = window.location.pathname
  const aiMemberId = pathname.match(/^\/ai-member\/([^/]+)$/)?.[1] ?? null
  const teamPage = pathname === '/team' || Boolean(aiMemberId)
  const knowledgePage = pathname === '/knowledge'
  const facebookPage = pathname === '/settings/facebook'
  const activeHref = teamPage
    ? '/team'
    : knowledgePage
      ? '/knowledge'
      : facebookPage
        ? '/settings/facebook'
        : '/inbox'
  const inboxPage = activeHref === '/inbox'

  async function signOut() {
    await request('/api/auth/sign-out', {})
    localStorage.removeItem('activeWorkspaceId')
    history.replaceState(null, '', '/login')
    onSignOut()
  }

  return (
    <div className={`shell app-shell ${inboxPage ? 'app-shell-inbox' : ''}`}>
      <AppSidebar
        activeHref={activeHref}
        me={me}
        onSignOut={signOut}
        onWorkspaceChange={onWorkspaceChange}
      />
      <div className={`app-content ${inboxPage ? 'app-content-inbox' : ''}`}>
        {aiMemberId ? (
          <AiMemberPage workspace={me.workspace} memberId={aiMemberId} />
        ) : teamPage ? (
          <TeamPage workspace={me.workspace} />
        ) : knowledgePage ? (
          <KnowledgePage workspace={me.workspace} />
        ) : facebookPage ? (
          <FacebookSettingsPage workspace={me.workspace} />
        ) : (
          <InboxPage workspace={me.workspace} />
        )}
      </div>
    </div>
  )
}

function AppSidebar({
  activeHref,
  me,
  onSignOut,
  onWorkspaceChange,
}: {
  activeHref: string
  me: Me & { workspace: NonNullable<Me['workspace']> }
  onSignOut: () => Promise<void>
  onWorkspaceChange: (workspaceId: string) => Promise<void>
}) {
  const userInitial = (me.user.name || me.user.email).trim().charAt(0).toUpperCase() || 'U'

  return (
    <aside className="app-sidebar" aria-label="应用导航">
      <div className="app-sidebar-top">
        <a className="app-brand" href="/inbox" aria-label="DeepSales 收件箱">
          <span className="app-brand-mark" aria-hidden="true">
            DS<span>·</span>
          </span>
          <span className="app-brand-copy">
            <strong>DeepSales</strong>
            <small>共享收件箱</small>
          </span>
        </a>
        <div className="workspace-switcher">
          <span className="sidebar-kicker">工作区</span>
          <span className="workspace-initial" aria-hidden="true">
            {nameInitial(me.workspace.name, '工')}
          </span>
          {me.workspaces.length > 1 ? (
            <label className="workspace-select-wrap">
              <span className="sr-only">当前工作区</span>
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
              <ChevronDown aria-hidden="true" />
            </label>
          ) : (
            <strong>{me.workspace.name}</strong>
          )}
        </div>
      </div>
      <nav className="app-nav" aria-label="主要导航">
        {appNavItems.map((item) => {
          const Icon = item.icon
          const active = activeHref === item.href
          return (
            <Tooltip key={item.href}>
              <TooltipTrigger asChild>
                <a
                  aria-current={active ? 'page' : undefined}
                  aria-label={item.label}
                  className={active ? 'app-nav-link active' : 'app-nav-link'}
                  href={item.href}
                >
                  <Icon aria-hidden="true" />
                  <span className="app-sidebar-label">{item.label}</span>
                </a>
              </TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          )
        })}
      </nav>
      <div className="app-sidebar-footer">
        <Separator />
        <div className="user-profile">
          <Avatar size="sm">
            <AvatarFallback>{userInitial}</AvatarFallback>
          </Avatar>
          <div className="user-profile-copy">
            <strong>{me.user.name || '团队成员'}</strong>
            <span>{roleLabel(me.workspace.role)}</span>
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="退出登录"
              className="app-signout"
              type="button"
              variant="ghost"
              onClick={onSignOut}
            >
              <LogOut aria-hidden="true" />
              <span className="app-sidebar-label">退出登录</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">退出登录</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  )
}

const inboxViews: Array<{ id: InboxView; label: string; icon: LucideIcon }> = [
  { id: 'my', label: '我的对话', icon: UserRoundCheck },
  { id: 'waiting-human', label: '等待人工', icon: Clock3 },
  { id: 'ai-handling', label: 'AI处理中', icon: Bot },
  { id: 'unassigned', label: '未分配', icon: UserRoundX },
  { id: 'all-open', label: '全部进行中', icon: ListFilter },
]

function InboxPage({ workspace }: { workspace: Workspace }) {
  const [filters, setFilters] = useState<InboxFilters>({ view: 'all-open' })
  const [searchReady, setSearchReady] = useState(
    () => !new URL(window.location.href).searchParams.has('inboxView'),
  )
  const view = filters.view
  const attention = filters.attention ?? 'all'
  const setView = (view: InboxView) => setFilters((current) => ({ ...current, view }))
  const setAttention = (attention: 'all' | 'unread' | 'unanswered') =>
    setFilters((current) => ({
      ...current,
      attention: attention === 'all' ? undefined : attention,
    }))
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [olderCursor, setOlderCursor] = useState<string | null>(null)
  const [pageLoading, setPageLoading] = useState(false)
  const [olderLoading, setOlderLoading] = useState(false)
  const [readError, setReadError] = useState('')
  const [readRetry, setReadRetry] = useState(0)
  const [tagFilter, setTagFilter] = useState<{ id: string; name: string } | null>(null)
  const [conversations, setConversations] = useState<InboxConversation[]>([])
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<InboxMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [threadLoading, setThreadLoading] = useState(false)
  const [error, setError] = useState('')
  const [reply, setReply] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferTargetId, setTransferTargetId] = useState('')
  const [transferConfirmationOpen, setTransferConfirmationOpen] = useState(false)
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [notesRevision, setNotesRevision] = useState(0)
  const [transferAiOnly, setTransferAiOnly] = useState(false)
  const [aiTransferConfirmationOpen, setAiTransferConfirmationOpen] = useState(false)
  const [mobileThreadOpen, setMobileThreadOpen] = useState(false)
  const [clock, setClock] = useState(() => Date.now())
  const selectedIdRef = useRef<string | null>(null)
  const selectionEpoch = useRef(0)
  const readAcknowledgements = useRef({ epoch: -1, retry: -1, ids: new Set<string>() })
  if (selectedIdRef.current !== selectedId) {
    selectedIdRef.current = selectedId
    selectionEpoch.current += 1
  }
  const listRequest = useRef(0)
  const threadRequest = useRef(0)
  const listPages = useRef(1)
  const unreadSelectionCleared = useRef(false)
  const queryParams = inboxQuery({
    ...filters,
    tagIds: [...new Set([...(filters.tagIds ?? []), ...(tagFilter ? [tagFilter.id] : [])])],
  })
  const queryKey = `${workspace.id}:${queryParams}:${searchReady}`
  const applyFilters = useCallback((next: InboxFilters) => {
    setFilters(next)
    setTagFilter(null)
    setSearchReady(true)
  }, [])
  const readyFilters = useCallback((next?: InboxFilters) => {
    if (next) setFilters(next)
    setSearchReady(true)
  }, [])
  const currentQuery = useRef(queryKey)
  if (currentQuery.current !== queryKey) {
    currentQuery.current = queryKey
    listPages.current = 1
    unreadSelectionCleared.current = false
    listRequest.current += 1
  }
  const messagesRef = useRef<InboxMessage[]>([])
  const messageListRef = useRef<HTMLDivElement>(null)
  const shouldScrollToBottomRef = useRef(false)
  const selectedConversation = conversations.find(({ id }) => id === selectedId)
  const transferTargets =
    selectedConversation?.assigneeType === 'HUMAN'
      ? teamMembers.filter(
          (member) =>
            member.id !== selectedConversation.assigneeMemberId &&
            member.status === 'ACTIVE' &&
            member.channelIds.includes(selectedConversation.channelId) &&
            (member.type === 'HUMAN' || member.configurationStatus === 'USABLE'),
        )
      : []
  const canManageSelected = Boolean(
    selectedConversation?.status === 'OPEN' &&
      (workspace.role !== 'AGENT' || selectedConversation.assigneeMemberId === workspace.memberId),
  )
  const replyWindowEligibleUntil = selectedConversation?.replyWindowEligibleUntil ?? null
  const replyWindowOpen = Boolean(
    selectedConversation?.replyWindowOpen &&
      (!replyWindowEligibleUntil || Date.parse(replyWindowEligibleUntil) > clock),
  )

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useLayoutEffect(() => {
    if (!shouldScrollToBottomRef.current || threadLoading || !messages.length) return
    const viewport = messageListRef.current?.closest('[data-slot="scroll-area-viewport"]')
    if (!(viewport instanceof HTMLElement)) return
    shouldScrollToBottomRef.current = false
    viewport.scrollTop = viewport.scrollHeight
  }, [messages.length, threadLoading])

  const updateMessages = useCallback((incoming: InboxMessage[], followNewMessages = true) => {
    const current = messagesRef.current
    const next = mergeInboxMessages(current, incoming)
    if (next === current) return

    const currentIds = new Set(current.map(({ id }) => id))
    const hasNewMessage = incoming.some(({ id }) => !currentIds.has(id))
    const viewport = messageListRef.current?.closest('[data-slot="scroll-area-viewport"]')
    if (
      followNewMessages &&
      hasNewMessage &&
      viewport instanceof HTMLElement &&
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 80
    ) {
      shouldScrollToBottomRef.current = true
    }

    messagesRef.current = next
    setMessages(next)
  }, [])

  const refresh = useCallback(async () => {
    const generation = ++listRequest.current
    if (!searchReady) {
      setLoading(false)
      return
    }
    const base = `/api/workspaces/${workspace.id}/conversations?${queryParams}`
    const items = new Map<string, InboxConversation>()
    let cursor: string | null = null
    for (let page = 0; page < listPages.current; page += 1) {
      const response = await fetch(
        `${base}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )
      if (!response.ok) throw await responseError(response)
      const data = (await response.json()) as InboxPageData
      if (currentQuery.current !== queryKey || listRequest.current !== generation) return
      for (const item of data.conversations) items.set(item.id, item)
      cursor = data.nextCursor
      if (!cursor) break
    }
    const selected = selectedIdRef.current
    if (selected && !items.has(selected)) {
      const response = await fetch(`${base}&conversationId=${encodeURIComponent(selected)}`)
      if (!response.ok) throw await responseError(response)
      const data = (await response.json()) as InboxPageData
      if (currentQuery.current !== queryKey || listRequest.current !== generation) return
      if (data.conversations[0]) items.set(selected, data.conversations[0])
    }
    const visible = [...items.values()]
    setError('')
    setNextCursor(cursor)
    setConversations(visible)
    setSelectedId((current) => {
      if (current && !items.has(current) && attention === 'unread')
        unreadSelectionCleared.current = true
      if (!items.has(current ?? '') && attention === 'unread' && unreadSelectionCleared.current)
        return null
      return current && items.has(current) ? current : (visible[0]?.id ?? null)
    })
    setLoading(false)
  }, [workspace.id, attention, queryKey, queryParams, searchReady])

  const refreshThread = useCallback(
    async (conversationId: string, showLoading = false) => {
      const generation = ++threadRequest.current
      const epoch = selectionEpoch.current
      if (showLoading) setThreadLoading(true)
      try {
        const currentMessages = messagesRef.current
        const oldestId = !showLoading ? currentMessages[0]?.id : undefined
        const loaded: InboxMessage[] = []
        let oldestLoadedId: string | undefined
        let cursor: string | null = null
        do {
          const response = await fetch(
            `/api/workspaces/${workspace.id}/conversations/${conversationId}/messages${cursor ? `?before=${encodeURIComponent(cursor)}` : '?history=latest'}`,
          )
          if (!response.ok) throw await responseError(response)
          const data = (await response.json()) as {
            messages: InboxMessage[]
            olderCursor: string | null
          }
          if (
            selectedIdRef.current !== conversationId ||
            selectionEpoch.current !== epoch ||
            threadRequest.current !== generation
          )
            return
          loaded.push(...data.messages)
          oldestLoadedId = data.messages[0]?.id
          cursor = data.olderCursor
          if (!oldestId || data.messages.some((m) => m.id === oldestId)) break
        } while (cursor)
        updateMessages(loaded, !showLoading)
        if (messagesRef.current[0]?.id === oldestLoadedId) setOlderCursor(cursor)
        if (showLoading) shouldScrollToBottomRef.current = true
      } finally {
        if (showLoading && selectedIdRef.current === conversationId) setThreadLoading(false)
      }
    },
    [updateMessages, workspace.id],
  )

  async function loadOlder() {
    if (!selectedId || !olderCursor || olderLoading) return
    const epoch = selectionEpoch.current
    setOlderLoading(true)
    try {
      const response = await fetch(
        `/api/workspaces/${workspace.id}/conversations/${selectedId}/messages?before=${encodeURIComponent(olderCursor)}`,
      )
      if (!response.ok) throw await responseError(response)
      const data = (await response.json()) as {
        messages: InboxMessage[]
        olderCursor: string | null
      }
      if (selectionEpoch.current !== epoch) return
      const viewport = messageListRef.current?.closest('[data-slot="scroll-area-viewport"]')
      const anchor =
        viewport instanceof HTMLElement
          ? { viewport, height: viewport.scrollHeight, top: viewport.scrollTop }
          : null
      updateMessages(data.messages, false)
      if (messagesRef.current[0]?.id === data.messages[0]?.id) setOlderCursor(data.olderCursor)
      if (anchor)
        requestAnimationFrame(() => {
          if (selectionEpoch.current === epoch)
            anchor.viewport.scrollTop = anchor.top + anchor.viewport.scrollHeight - anchor.height
        })
    } catch (cause) {
      if (selectionEpoch.current === epoch) setError(inboxErrorMessage(cause))
    } finally {
      if (selectionEpoch.current === epoch) setOlderLoading(false)
    }
  }

  useEffect(() => {
    if (!selectedId || threadLoading || document.hidden) return
    const epoch = selectionEpoch.current
    if (
      readAcknowledgements.current.epoch !== epoch ||
      readAcknowledgements.current.retry !== readRetry
    )
      readAcknowledgements.current = { epoch, retry: readRetry, ids: new Set<string>() }
    const acknowledged = readAcknowledgements.current.ids
    let timer: number | undefined
    const pending = new Set<string>()
    const root = messageListRef.current?.closest('[data-slot="scroll-area-viewport"]')
    if (!(root instanceof HTMLElement)) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.customerMessageId
          if (entry.isIntersecting && id && !acknowledged.has(id)) {
            pending.add(id)
          }
        }
        if (!pending.size || timer !== undefined) return
        timer = window.setTimeout(() => {
          timer = undefined
          if (document.hidden || selectionEpoch.current !== epoch) return
          const ids = [...pending]
          pending.clear()
          for (const id of ids) acknowledged.add(id)
          void (async () => {
            for (let offset = 0; offset < ids.length; offset += 100) {
              if (selectionEpoch.current !== epoch || document.hidden) return
              await request(`/api/workspaces/${workspace.id}/conversations/${selectedId}/read`, {
                messageIds: ids.slice(offset, offset + 100),
              })
            }
          })()
            .then(() => {
              if (selectionEpoch.current === epoch) {
                setReadError('')
                return refresh()
              }
            })
            .catch(() => {
              if (selectionEpoch.current === epoch) setReadError('已读确认失败，请重试。')
            })
        }, 150)
      },
      { root, threshold: 0.1 },
    )
    const customerIds = new Set(
      messages.filter((message) => message.senderType === 'CUSTOMER').map((message) => message.id),
    )
    for (const element of root.querySelectorAll('[data-customer-message-id]')) {
      if (customerIds.has((element as HTMLElement).dataset.customerMessageId ?? ''))
        observer.observe(element)
    }
    return () => {
      observer.disconnect()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [messages, selectedId, workspace.id, threadLoading, refresh, readRetry])

  useEffect(() => {
    void fetch(`/api/workspaces/${workspace.id}/team`)
      .then(async (response) => {
        if (!response.ok) throw await responseError(response)
        setTeamMembers(((await response.json()) as Team).members)
      })
      .catch((cause) => setError(inboxErrorMessage(cause)))
  }, [workspace.id])

  const takeOver = useCallback(async () => {
    if (!selectedId) return
    setActionLoading(true)
    try {
      await request(`/api/workspaces/${workspace.id}/conversations/${selectedId}/takeover`, {})
      await refresh()
      await refreshThread(selectedId)
      setError('')
    } catch (cause) {
      setError(inboxErrorMessage(cause))
    } finally {
      setActionLoading(false)
    }
  }, [refresh, refreshThread, selectedId, workspace.id])

  const transfer = useCallback(
    async (confirmOverride = false) => {
      if (!selectedId || !transferTargetId) return
      setActionLoading(true)
      try {
        await request(`/api/workspaces/${workspace.id}/conversations/${selectedId}/transfer`, {
          targetMemberId: transferTargetId,
          ...(confirmOverride ? { confirmOverride: true } : {}),
        })
        setTransferOpen(false)
        setTransferTargetId('')
        setTransferConfirmationOpen(false)
        await refresh()
        await refreshThread(selectedId)
        setError('')
        toast.success('对话已转接')
      } catch (cause) {
        if (
          !confirmOverride &&
          cause instanceof ApiError &&
          cause.code === 'TRANSFER_CONFIRMATION_REQUIRED'
        ) {
          setTransferConfirmationOpen(true)
        } else {
          setError(inboxErrorMessage(cause))
        }
      } finally {
        setActionLoading(false)
      }
    },
    [refresh, refreshThread, selectedId, transferTargetId, workspace.id],
  )

  const unassign = useCallback(async () => {
    if (!selectedId) return
    setActionLoading(true)
    try {
      await request(`/api/workspaces/${workspace.id}/conversations/${selectedId}/unassign`, {})
      await refresh()
      await refreshThread(selectedId)
      setError('')
      toast.success('已取消分配')
    } catch (cause) {
      setError(inboxErrorMessage(cause))
    } finally {
      setActionLoading(false)
    }
  }, [refresh, refreshThread, selectedId, workspace.id])

  const closeConversation = useCallback(async () => {
    if (!selectedId) return
    setActionLoading(true)
    try {
      await request(`/api/workspaces/${workspace.id}/conversations/${selectedId}/close`, {})
      setTransferOpen(false)
      setTransferTargetId('')
      await refresh()
      setError('')
      toast.success('对话已关闭')
    } catch (cause) {
      setError(inboxErrorMessage(cause))
    } finally {
      setActionLoading(false)
    }
  }, [refresh, selectedId, workspace.id])

  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedId || !reply.trim()) return
    setActionLoading(true)
    try {
      const result = (await request(
        `/api/workspaces/${workspace.id}/conversations/${selectedId}/replies`,
        { text: reply },
      )) as { message: InboxMessage }
      updateMessages([result.message])
      setReply('')
      await refresh()
      await refreshThread(selectedId)
      setError('')
    } catch (cause) {
      setError(inboxErrorMessage(cause))
    } finally {
      setActionLoading(false)
    }
  }

  async function toggleMute() {
    if (!selectedConversation) return
    setActionLoading(true)
    try {
      await request(
        `/api/workspaces/${workspace.id}/conversations/${selectedConversation.id}/mute`,
        { muted: !selectedConversation.muted },
        'PUT',
      )
      await refresh()
    } catch (cause) {
      setError(inboxErrorMessage(cause))
    } finally {
      setActionLoading(false)
    }
  }

  useEffect(() => {
    setLoading(true)
    setConversations([])
    setSelectedId(null)
    void refresh().catch((cause) => {
      if (currentQuery.current !== queryKey) return
      setLoading(false)
      setError(inboxErrorMessage(cause))
    })
  }, [refresh, queryKey])

  useEffect(() => {
    if (!replyWindowEligibleUntil) return
    const expiresAt = Date.parse(replyWindowEligibleUntil)
    const refreshClock = () => setClock(Date.now())
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      refreshClock()
      return
    }
    const timer = window.setTimeout(refreshClock, expiresAt - Date.now() + 1)
    return () => window.clearTimeout(timer)
  }, [replyWindowEligibleUntil])

  useEffect(() => {
    selectedIdRef.current = selectedId
    setTransferOpen(false)
    setTransferTargetId('')
    setTransferConfirmationOpen(false)
    setAiTransferConfirmationOpen(false)
    setTransferAiOnly(false)
    if (!selectedId) {
      shouldScrollToBottomRef.current = false
      messagesRef.current = []
      setMessages([])
      setThreadLoading(false)
      return
    }
    shouldScrollToBottomRef.current = false
    setOlderCursor(null)
    setOlderLoading(false)
    setReadError('')
    messagesRef.current = []
    setMessages([])
    void refreshThread(selectedId, true).catch((cause) => setError(inboxErrorMessage(cause)))
  }, [refreshThread, selectedId])

  useEffect(() => {
    const refreshVisible = () => {
      if (document.hidden) return
      void refresh()
        .then(() => {
          if (selectedIdRef.current) return refreshThread(selectedIdRef.current)
        })
        .catch((cause) => setError(inboxErrorMessage(cause)))
    }
    window.addEventListener('focus', refreshVisible)
    const readVisible = () => {
      if (!document.hidden) setReadRetry((value) => value + 1)
    }
    document.addEventListener('visibilitychange', readVisible)
    return () => {
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', readVisible)
    }
  }, [refresh, refreshThread])

  useEffect(() => {
    let socket: WebSocket | undefined
    let retryTimer: number | undefined
    let stopped = false
    let connectedBefore = false
    let retryDelay = 1_000

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(
        `${protocol}//${window.location.host}/api/workspaces/${workspace.id}/realtime`,
      )
      socket.onopen = () => {
        retryDelay = 1_000
        if (connectedBefore) {
          void refresh()
            .then(() => (selectedIdRef.current ? refreshThread(selectedIdRef.current) : undefined))
            .catch((cause) => setError(inboxErrorMessage(cause)))
        }
        connectedBefore = true
      }
      socket.onmessage = () => {
        setNotesRevision((current) => current + 1)
        void refresh()
          .then(() => (selectedIdRef.current ? refreshThread(selectedIdRef.current) : undefined))
          .catch((cause) => setError(inboxErrorMessage(cause)))
      }
      socket.onclose = () => {
        if (!stopped) {
          retryTimer = window.setTimeout(connect, retryDelay)
          retryDelay = Math.min(retryDelay * 2, 30_000)
        }
      }
    }

    connect()
    return () => {
      stopped = true
      if (retryTimer) window.clearTimeout(retryTimer)
      socket?.close()
    }
  }, [refresh, refreshThread, workspace.id])

  const currentViewLabel =
    view === 'closed'
      ? '已关闭历史'
      : view === 'team'
        ? '团队对话'
        : (inboxViews.find((item) => item.id === view)?.label ?? '全部进行中')

  return (
    <main className={`inbox-page ${mobileThreadOpen ? 'mobile-thread-open' : ''}`}>
      <aside className="inbox-pane" aria-label="收件箱视图和对话列表">
        <div className="inbox-pane-header">
          <div className="inbox-title-row">
            <div>
              <p className="eyebrow">共享收件箱</p>
              <h1>对话</h1>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="刷新对话"
                  className="inbox-refresh"
                  disabled={loading}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    void refresh().catch((cause) => setError(inboxErrorMessage(cause)))
                  }
                >
                  <RefreshCw aria-hidden="true" className={loading ? 'spin' : ''} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>刷新对话</TooltipContent>
            </Tooltip>
          </div>
          <nav className="inbox-view-nav" aria-label="收件箱视图">
            {inboxViews.map((item) => {
              const Icon = item.icon
              const active = view === item.id
              return (
                <button
                  aria-pressed={active}
                  className={active ? 'inbox-view active' : 'inbox-view'}
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setMobileThreadOpen(false)
                    setView(item.id)
                  }}
                >
                  <Icon aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </nav>
          <Button
            type="button"
            variant="ghost"
            aria-pressed={view === 'closed'}
            onClick={() => setView('closed')}
          >
            已关闭历史
          </Button>
          <label htmlFor="inbox-attention">消息筛选</label>
          <Select
            value={attention}
            onValueChange={(value) => setAttention(value as typeof attention)}
          >
            <SelectTrigger id="inbox-attention" aria-label="消息筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部消息</SelectItem>
              <SelectItem value="unread">未读</SelectItem>
              <SelectItem value="unanswered">未回复</SelectItem>
            </SelectContent>
          </Select>
          <label htmlFor="inbox-mute-filter">个人免打扰筛选</label>
          <Select
            value={filters.mute ?? 'all'}
            onValueChange={(value) =>
              setFilters((current) => ({
                ...current,
                mute: value === 'all' ? undefined : (value as 'muted' | 'unmuted'),
              }))
            }
          >
            <SelectTrigger id="inbox-mute-filter" aria-label="个人免打扰筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部对话</SelectItem>
              <SelectItem value="unmuted">排除免打扰</SelectItem>
              <SelectItem value="muted">仅免打扰</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            aria-pressed={view === 'team'}
            onClick={() => setView('team')}
          >
            团队对话
          </Button>
          <InboxFilterControls
            workspaceId={workspace.id}
            manager={workspace.role !== 'AGENT'}
            filters={{
              ...filters,
              tagIds: [
                ...new Set([...(filters.tagIds ?? []), ...(tagFilter ? [tagFilter.id] : [])]),
              ],
            }}
            onApply={applyFilters}
            onReady={readyFilters}
          />
        </div>
        <Separator />
        <section className="conversation-list" aria-label="对话列表">
          {tagFilter && (
            <Button type="button" variant="ghost" onClick={() => setTagFilter(null)}>
              清除标签筛选：{tagFilter.name}
            </Button>
          )}
          <div className="conversation-list-heading">
            <div>
              <span className="list-kicker">当前视图</span>
              <h2>{currentViewLabel}</h2>
            </div>
            {conversations.length > 0 && (
              <span className="conversation-count">{conversations.length}</span>
            )}
          </div>
          {error && (
            <div className="inbox-error" role="alert">
              <AlertCircle aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
          {loading ? (
            <ConversationListSkeleton />
          ) : conversations.length ? (
            <div className="conversation-items">
              {conversations.map((item) => (
                <ConversationListItem
                  item={item}
                  key={item.id}
                  selected={selectedId === item.id}
                  onSelect={() => {
                    setSelectedId(item.id)
                    setMobileThreadOpen(true)
                  }}
                />
              ))}
              {nextCursor && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pageLoading}
                  onClick={() => {
                    listPages.current += 1
                    setPageLoading(true)
                    void refresh()
                      .catch((cause) => setError(inboxErrorMessage(cause)))
                      .finally(() => setPageLoading(false))
                  }}
                >
                  {pageLoading ? '加载中…' : '加载更多对话'}
                </Button>
              )}
            </div>
          ) : (
            <div className="inbox-placeholder inbox-empty-state">
              <MessageCircle aria-hidden="true" />
              <strong>{currentViewLabel}暂无对话</strong>
              <span>新的 Messenger 消息会根据视图显示在这里。</span>
            </div>
          )}
        </section>
      </aside>
      <section className="inbox-thread" aria-label="对话详情">
        {selectedId && selectedConversation ? (
          <div className="thread-layout">
            <ConversationHeader
              customerDetails={
                <>
                  <InternalNotes
                    workspaceId={workspace.id}
                    conversationId={selectedId}
                    closed={selectedConversation.status === 'CLOSED'}
                    revision={notesRevision}
                    key={`notes:${selectedId}`}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={actionLoading}
                    onClick={() => void toggleMute()}
                  >
                    {selectedConversation.muted ? '取消个人免打扰' : '个人免打扰'}
                  </Button>
                  <CustomerSidebar
                    workspaceId={workspace.id}
                    conversationId={selectedId}
                    key={selectedId}
                    manager={workspace.role !== 'AGENT'}
                    canEdit={canManageSelected}
                    members={teamMembers}
                    onSaved={refresh}
                    onFilter={setTagFilter}
                    onFilterCustomer={(customerId) => applyFilters({ ...filters, customerId })}
                  />
                </>
              }
              actionLoading={actionLoading}
              canManage={canManageSelected}
              conversation={selectedConversation}
              replyWindowOpen={replyWindowOpen}
              transferTargets={transferTargets}
              onBack={() => setMobileThreadOpen(false)}
              onClose={() => setCloseDialogOpen(true)}
              onOpenTransfer={() => {
                setTransferAiOnly(false)
                setTransferOpen(true)
              }}
              onResumeAi={() => {
                setTransferAiOnly(true)
                setTransferTargetId('')
                setTransferOpen(true)
              }}
              onTakeOver={() => void takeOver()}
              onUnassign={() => void unassign()}
            />
            <div className="thread-context">
              {selectedConversation.muted && (
                <p>
                  个人免打扰已开启，仅影响你的列表筛选。当前未提供声音或系统通知；消息接收与接待继续。
                </p>
              )}
              {readError && (
                <div role="alert">
                  {readError}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setReadRetry((value) => value + 1)}
                  >
                    重试已读确认
                  </Button>
                </div>
              )}
              {error && (
                <div className="thread-error" role="alert">
                  <AlertCircle aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}
              {transferOpen && canManageSelected && (
                <div className="transfer-controls">
                  <div className="transfer-copy">
                    <strong>{transferAiOnly ? '交给 AI 托管' : '转接对话'}</strong>
                    <span>选择一个有权限处理此频道的成员。</span>
                  </div>
                  <label htmlFor="transfer-target">转接给</label>
                  <select
                    id="transfer-target"
                    aria-label="选择转接成员"
                    value={transferTargetId}
                    onChange={(event) => setTransferTargetId(event.currentTarget.value)}
                    disabled={actionLoading}
                  >
                    <option value="">选择成员</option>
                    {transferTargets
                      .filter((member) => !transferAiOnly || member.type === 'AI')
                      .map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.displayName ?? '未命名成员'}
                          {member.type === 'AI' ? '（AI）' : ''}
                        </option>
                      ))}
                  </select>
                  <Button
                    disabled={!transferTargetId || actionLoading}
                    type="button"
                    variant="outline"
                    onClick={() => {
                      if (
                        teamMembers.find((member) => member.id === transferTargetId)?.type === 'AI'
                      )
                        setAiTransferConfirmationOpen(true)
                      else void transfer()
                    }}
                  >
                    确认转接
                  </Button>
                  <Button
                    disabled={actionLoading}
                    type="button"
                    variant="ghost"
                    onClick={() => setTransferOpen(false)}
                  >
                    取消
                  </Button>
                </div>
              )}
            </div>
            <ScrollArea className="message-scroll">
              {threadLoading ? (
                <MessageThreadSkeleton />
              ) : (
                <div ref={messageListRef} className="message-list" aria-live="polite">
                  {olderCursor && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={olderLoading}
                      onClick={() => void loadOlder()}
                    >
                      {olderLoading ? '加载中…' : '加载更早消息'}
                    </Button>
                  )}
                  {messages.length ? (
                    messages.map((message) => (
                      <MessageBubble
                        key={message.id}
                        message={message}
                        teamMembers={teamMembers}
                        workspaceId={workspace.id}
                        canDiagnose={workspace.role !== 'AGENT'}
                        onRetry={
                          message.deliveryState === 'FAILED' &&
                          message.failureCode !== 'AMBIGUOUS_DELIVERY' &&
                          message.senderMemberId === workspace.memberId &&
                          selectedConversation.assigneeMemberId === workspace.memberId &&
                          replyWindowOpen &&
                          !actionLoading
                            ? async () => {
                                setActionLoading(true)
                                try {
                                  await request(
                                    `/api/workspaces/${workspace.id}/conversations/${selectedId}/messages/${message.id}/retry`,
                                    {},
                                  )
                                  await refreshThread(selectedId)
                                  await refresh()
                                } catch (cause) {
                                  setError(inboxErrorMessage(cause))
                                } finally {
                                  setActionLoading(false)
                                }
                              }
                            : undefined
                        }
                      />
                    ))
                  ) : (
                    <p className="inbox-placeholder">暂无消息。</p>
                  )}
                </div>
              )}
            </ScrollArea>
            <div className="reply-composer-dock">
              <ReplyContent
                key={`content:${selectedId}`}
                workspaceId={workspace.id}
                conversationId={selectedId}
                canSend={
                  !actionLoading &&
                  selectedConversation.status === 'OPEN' &&
                  selectedConversation.assigneeMemberId === workspace.memberId &&
                  selectedConversation.assigneeType === 'HUMAN' &&
                  replyWindowOpen
                }
                onText={setReply}
                onEmoji={() => setReply((current) => `${current}😊`)}
                onSent={async () => {
                  await refresh()
                  await refreshThread(selectedId)
                }}
              />
              <ConversationComposer
                closed={selectedConversation.status === 'CLOSED'}
                actionLoading={actionLoading}
                canReply={
                  selectedConversation.assigneeMemberId === workspace.memberId &&
                  selectedConversation.assigneeType === 'HUMAN'
                }
                reply={reply}
                replyWindowOpen={replyWindowOpen}
                setReply={setReply}
                onSubmit={sendReply}
              />
            </div>
          </div>
        ) : selectedId ? (
          <div className="thread-empty">
            <p>正在打开对话…</p>
          </div>
        ) : (
          <div className="thread-empty">
            <MessageCircle aria-hidden="true" />
            <p className="eyebrow">Messenger</p>
            <h2>选择一个对话</h2>
            <p>从对话列表打开客户消息。</p>
          </div>
        )}
      </section>
      <AlertDialog open={transferConfirmationOpen} onOpenChange={setTransferConfirmationOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>仍要转接？</AlertDialogTitle>
            <AlertDialogDescription>
              目标成员当前不可自动接收这段对话。确认后将跳过自动分配限制，直接转接给该成员。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void transfer(true)}>继续转接</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={aiTransferConfirmationOpen} onOpenChange={setAiTransferConfirmationOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>交给此 AI 托管？</AlertDialogTitle>
            <AlertDialogDescription>
              AI 将成为当前负责人并自动接待；此次明确转交会解除仅人工接待限制。你仍可接管以停止 AI
              托管。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void transfer()}>确认 AI 托管</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={closeDialogOpen} onOpenChange={setCloseDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>关闭这段对话？</AlertDialogTitle>
            <AlertDialogDescription>
              关闭后，这段对话会从进行中的视图移除。客户再次发消息时，系统会创建新的对话。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void closeConversation()}>
              关闭对话
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}

type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'destructive'

function statusTone(status: string): StatusTone {
  if (['ACTIVE', 'USABLE', 'READY'].includes(status)) return 'success'
  if (['ACTION_REQUIRED', 'UNHEALTHY', 'FAILED'].includes(status)) return 'destructive'
  if (['PROCESSING', 'UPLOADED', 'PENDING'].includes(status)) return 'warning'
  if (status === 'AI') return 'info'
  return 'neutral'
}

function conversationHandling(conversation: InboxConversation) {
  if (conversation.assigneeType === 'AI') return { label: 'AI处理中', tone: 'info' as const }
  if (conversation.assigneeMemberId) {
    return { label: `由 ${conversation.assigneeName ?? '团队成员'} 负责`, tone: 'neutral' as const }
  }
  if (
    conversation.routingConstraint === 'HUMAN_ONLY' ||
    conversation.queueReason === 'AI_HANDOFF'
  ) {
    return { label: '等待人工', tone: 'warning' as const }
  }
  return { label: '未分配', tone: 'neutral' as const }
}

function nameInitial(name: string | null, fallback: string) {
  return (name?.trim().charAt(0) || fallback).toUpperCase()
}

function ConversationListItem({
  item,
  selected,
  onSelect,
}: {
  item: InboxConversation
  selected: boolean
  onSelect: () => void
}) {
  const handling = conversationHandling(item)
  return (
    <button
      aria-pressed={selected}
      className={selected ? 'conversation-item selected' : 'conversation-item'}
      type="button"
      onClick={onSelect}
    >
      <Avatar size="sm">
        <AvatarFallback>{nameInitial(item.customerName, '新')}</AvatarFallback>
      </Avatar>
      <span className="conversation-item-body">
        <span className="conversation-item-topline">
          <strong>{item.customerName ?? '新客户'}</strong>
          <time dateTime={item.updatedAt} title={formatExactDate(item.updatedAt)}>
            {formatDate(item.updatedAt)}
          </time>
        </span>
        <span className="conversation-item-preview">{item.latestPreview ?? '暂无消息'}</span>
        <span className="conversation-item-meta">
          <span className="conversation-item-channel">
            <MessageCircle aria-hidden="true" />
            Messenger
          </span>
          <StatusBadge tone={handling.tone}>{handling.label}</StatusBadge>
          {item.aiGenerating && <StatusBadge tone="info">AI 正在生成</StatusBadge>}
          {item.failedMessage && <StatusBadge tone="destructive">发送失败</StatusBadge>}
          {item.unread && <StatusBadge tone="info">未读</StatusBadge>}
          {item.unanswered && <StatusBadge tone="warning">未回复</StatusBadge>}
          {item.muted && <StatusBadge tone="neutral">个人免打扰</StatusBadge>}
        </span>
      </span>
    </button>
  )
}

function ConversationListSkeleton() {
  return (
    <div className="conversation-items" aria-hidden="true">
      {['one', 'two', 'three', 'four', 'five', 'six'].map((key) => (
        <div className="conversation-skeleton" key={key}>
          <Skeleton className="conversation-skeleton-avatar" />
          <div className="conversation-skeleton-copy">
            <Skeleton className="conversation-skeleton-name" />
            <Skeleton className="conversation-skeleton-preview" />
            <Skeleton className="conversation-skeleton-meta" />
          </div>
        </div>
      ))}
    </div>
  )
}

function MessageThreadSkeleton() {
  return (
    <div className="message-list" aria-hidden="true">
      <div className="message-skeleton inbound">
        <Skeleton className="message-skeleton-label" />
        <Skeleton className="message-skeleton-line wide" />
        <Skeleton className="message-skeleton-line" />
      </div>
      <div className="message-skeleton outbound">
        <Skeleton className="message-skeleton-label" />
        <Skeleton className="message-skeleton-line" />
        <Skeleton className="message-skeleton-line short" />
      </div>
      <div className="message-skeleton inbound">
        <Skeleton className="message-skeleton-label" />
        <Skeleton className="message-skeleton-line wide" />
      </div>
    </div>
  )
}

function ConversationHeader({
  customerDetails,
  actionLoading,
  canManage,
  conversation,
  replyWindowOpen,
  transferTargets,
  onBack,
  onClose,
  onOpenTransfer,
  onTakeOver,
  onUnassign,
  onResumeAi,
}: {
  customerDetails: ReactNode
  actionLoading: boolean
  canManage: boolean
  conversation: InboxConversation
  replyWindowOpen: boolean
  transferTargets: TeamMember[]
  onBack: () => void
  onClose: () => void
  onOpenTransfer: () => void
  onTakeOver: () => void
  onUnassign: () => void
  onResumeAi: () => void
}) {
  const handling = conversationHandling(conversation)
  const canTakeOver =
    conversation.status === 'OPEN' &&
    (conversation.assigneeMemberId === null || conversation.assigneeType === 'AI')

  return (
    <header className="thread-heading">
      <div className="thread-identity">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="返回对话列表"
              className="thread-back"
              size="icon-sm"
              type="button"
              variant="ghost"
              onClick={onBack}
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>返回对话列表</TooltipContent>
        </Tooltip>
        <Avatar size="lg">
          <AvatarFallback>{nameInitial(conversation.customerName, '新')}</AvatarFallback>
        </Avatar>
        <div className="thread-identity-copy">
          <h2>{conversation.customerName ?? '新客户'}</h2>
          <div className="thread-channel">
            <MessageCircle aria-hidden="true" />
            <span>Messenger</span>
            <span aria-hidden="true">·</span>
            <span>{conversation.channelName}</span>
          </div>
          <div className="thread-statuses">
            <StatusBadge tone={conversation.status === 'OPEN' ? 'success' : 'neutral'}>
              {conversation.status}
            </StatusBadge>
            <StatusBadge tone={handling.tone}>{handling.label}</StatusBadge>
            <ReplyWindowStatus open={replyWindowOpen} />
          </div>
        </div>
      </div>
      <div className="thread-actions">
        {customerDetails}
        {conversation.aiGenerating && (
          <StatusBadge className="ai-generating" role="status" tone="info">
            <Bot aria-hidden="true" />
            AI 正在生成
          </StatusBadge>
        )}
        {canTakeOver && (
          <Button disabled={actionLoading} type="button" onClick={onTakeOver}>
            <UserRoundCheck aria-hidden="true" />
            接管
          </Button>
        )}
        {canManage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button aria-label="更多对话操作" size="icon" type="button" variant="outline">
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {transferTargets.some((member) => member.type === 'AI') && (
                <DropdownMenuItem disabled={actionLoading} onSelect={onResumeAi}>
                  <Bot aria-hidden="true" />
                  交给 AI 托管
                </DropdownMenuItem>
              )}
              {transferTargets.length > 0 && (
                <DropdownMenuItem disabled={actionLoading} onSelect={onOpenTransfer}>
                  <ArrowRightLeft aria-hidden="true" />
                  转接
                </DropdownMenuItem>
              )}
              {conversation.assigneeMemberId && (
                <DropdownMenuItem disabled={actionLoading} onSelect={onUnassign}>
                  <UserRoundX aria-hidden="true" />
                  取消分配
                </DropdownMenuItem>
              )}
              {(transferTargets.length > 0 || conversation.assigneeMemberId) && (
                <DropdownMenuSeparator />
              )}
              <DropdownMenuItem disabled={actionLoading} variant="destructive" onSelect={onClose}>
                <XCircle aria-hidden="true" />
                关闭对话
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </header>
  )
}

function ReplyWindowStatus({ open }: { open: boolean }) {
  const Icon = open ? CheckCircle2 : CircleAlert
  return (
    <StatusBadge tone={open ? 'success' : 'warning'}>
      <Icon aria-hidden="true" />
      回复窗口{open ? '开放' : '已关闭'}
    </StatusBadge>
  )
}

function MessageBubble({
  message,
  teamMembers,
  workspaceId,
  onRetry,
  canDiagnose,
}: {
  message: InboxMessage
  teamMembers: TeamMember[]
  workspaceId: string
  onRetry?: () => Promise<void>
  canDiagnose?: boolean
}) {
  const inbound = message.direction === 'INBOUND'
  const senderMember = message.senderMemberId
    ? teamMembers.find(({ id }) => id === message.senderMemberId)
    : undefined
  const senderName = inbound ? '客户' : (senderMember?.displayName ?? '团队成员')
  const isAi = !inbound && senderMember?.type === 'AI'

  return (
    <article
      aria-label={`${senderName}的消息`}
      className={`message-bubble ${message.direction.toLowerCase()}`}
      data-customer-message-id={message.senderType === 'CUSTOMER' ? message.id : undefined}
    >
      <div className="message-bubble-header">
        <span className="message-sender">
          {isAi ? <Bot aria-hidden="true" /> : <UserRound aria-hidden="true" />}
          <strong>{senderName}</strong>
          {isAi && <StatusBadge tone="info">AI</StatusBadge>}
          {message.replySegmentIndex && (message.replySegmentCount ?? 0) > 1 && (
            <StatusBadge tone="neutral">
              回复分段 {message.replySegmentIndex}/{message.replySegmentCount}
            </StatusBadge>
          )}
        </span>
        <time dateTime={message.createdAt} title={formatExactDate(message.createdAt)}>
          {formatDate(message.createdAt)}
        </time>
      </div>
      {message.text ? <p>{message.text}</p> : !message.attachments.length && <p>附件消息</p>}
      {message.attachments?.map((attachment) => (
        <AttachmentPreview attachment={attachment} key={attachment.id} workspaceId={workspaceId} />
      ))}
      {message.deliveryState && <DeliveryStatus state={message.deliveryState} />}
      {message.deliveryState === 'SENT' && (
        <StatusBadge tone={message.read || message.delivered ? 'success' : 'neutral'}>
          {message.read ? '客户已读' : message.delivered ? '已送达' : '送达状态未知'}
        </StatusBadge>
      )}
      {message.deliveryState === 'FAILED' && (
        <span className="delivery-failure">{deliveryFailureLabel(message.failureCode)}</span>
      )}
      {onRetry && (
        <Button type="button" variant="ghost" onClick={() => void onRetry()}>
          检查并重试发送
        </Button>
      )}
      {isAi && canDiagnose && (
        <a href={`/ai-member/${senderMember.id}?diagnosticMessage=${message.id}`}>反馈与诊断</a>
      )}
    </article>
  )
}

const deliveryStatusMeta: Record<
  NonNullable<InboxMessage['deliveryState']>,
  { label: string; tone: StatusTone; icon: LucideIcon }
> = {
  PENDING: { label: '发送中', tone: 'warning', icon: Clock3 },
  SENT: { label: '已发送', tone: 'success', icon: CheckCircle2 },
  FAILED: { label: '发送失败', tone: 'destructive', icon: CircleAlert },
}

function DeliveryStatus({ state }: { state: NonNullable<InboxMessage['deliveryState']> }) {
  const meta = deliveryStatusMeta[state]
  const Icon = meta.icon
  return (
    <StatusBadge className="message-delivery-status" tone={meta.tone}>
      <Icon aria-hidden="true" />
      {meta.label}
    </StatusBadge>
  )
}

function ConversationComposer({
  closed = false,
  actionLoading,
  canReply,
  reply,
  replyWindowOpen,
  setReply,
  onSubmit,
}: {
  closed?: boolean
  actionLoading: boolean
  canReply: boolean
  reply: string
  replyWindowOpen: boolean
  setReply: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  const disabled = closed || actionLoading || !canReply || !replyWindowOpen
  const hint = actionLoading
    ? '正在处理，请稍候。'
    : closed
      ? '该对话已关闭。客户再次发来消息时会创建新的进行中对话。'
      : !canReply
        ? '接管对话后即可回复客户。'
        : !replyWindowOpen
          ? 'Messenger 回复窗口已关闭，暂时无法发送新消息。'
          : ''

  return (
    <div>
      {hint && (
        <p className="reply-hint" id="reply-help" role="status">
          <CircleAlert aria-hidden="true" />
          {hint}
        </p>
      )}
      <form className="reply-composer" onSubmit={onSubmit}>
        <div className="reply-composer-heading">
          <label htmlFor="reply-text">回复客户</label>
          <span>Enter 发送 · Shift+Enter 换行</span>
        </div>
        <Textarea
          aria-describedby={hint ? 'reply-help' : undefined}
          className="reply-textarea"
          disabled={disabled}
          id="reply-text"
          maxLength={2_000}
          placeholder="输入文字回复"
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            if (!disabled) event.currentTarget.form?.requestSubmit()
          }}
        />
        <div className="reply-composer-footer">
          <span>{reply.length.toLocaleString('zh-CN')}/2,000</span>
          <Button disabled={disabled || !reply.trim()} type="submit">
            <Send aria-hidden="true" />
            {actionLoading ? '发送中…' : '发送回复'}
          </Button>
        </div>
      </form>
    </div>
  )
}

function deliveryFailureLabel(code: string | null) {
  if (code === 'REPLY_SEGMENT_BLOCKED') return '前段发送失败，后续分段已暂停'
  if (code === 'AMBIGUOUS_DELIVERY') return '发送结果不明，已暂停；请核实后处理'
  return code === 'REPLY_WINDOW_CLOSED' ? '回复窗口已关闭' : '发送失败，请稍后重试'
}

function AttachmentPreview({
  attachment,
  workspaceId,
}: {
  attachment: InboxAttachment
  workspaceId: string
}) {
  const label = attachment.filename ?? attachmentKindLabel(attachment.kind)
  if (attachment.storageState === 'PENDING') {
    return (
      <StatusBadge className="attachment-state" role="status" tone="warning" aria-busy="true">
        <Clock3 aria-hidden="true" />
        附件加载中…
      </StatusBadge>
    )
  }
  if (attachment.storageState === 'FAILED') {
    return (
      <StatusBadge
        className="attachment-state attachment-state-failed"
        role="status"
        tone="destructive"
      >
        <CircleAlert aria-hidden="true" />
        附件加载失败
      </StatusBadge>
    )
  }

  const href = `/api/workspaces/${workspaceId}/attachments/${attachment.id}`
  if (attachment.kind === 'IMAGE') {
    return (
      <a className="attachment-image-link" href={href} aria-label={label}>
        <img src={href} alt={label} />
      </a>
    )
  }
  return (
    <a className="attachment-download" href={href} download={attachment.filename ?? true}>
      <span>{label}</span>
      <span>下载</span>
    </a>
  )
}

function attachmentKindLabel(kind: InboxAttachment['kind']) {
  return { IMAGE: '图片', FILE: '文件', AUDIO: '音频', VIDEO: '视频' }[kind]
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
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState('')
  const [disablingChannel, setDisablingChannel] = useState<FacebookChannel | null>(null)
  const canManage = workspace.role !== 'AGENT'

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/workspaces/${workspace.id}/channels`)
    if (!response.ok) throw await responseError(response)
    setChannels(((await response.json()) as { channels: FacebookChannel[] }).channels)
    setLoadError('')
  }, [workspace.id])

  useEffect(() => {
    void refresh().catch((cause) => setLoadError(facebookErrorMessage(cause)))
  }, [refresh])

  const loadPageOptions = useCallback(async () => {
    if (!pendingStateId) return
    setPages(undefined)
    setSelectedPageIds([])
    setError('')
    try {
      const response = await fetch(
        `/api/workspaces/${workspace.id}/facebook/oauth/${pendingStateId}/pages`,
      )
      if (!response.ok) throw await responseError(response)
      setPages(((await response.json()) as { pages: FacebookPageOption[] }).pages)
    } catch (cause) {
      setError(facebookErrorMessage(cause))
    }
  }, [pendingStateId, workspace.id])

  useEffect(() => {
    if (!canManage || !pendingStateId) return
    void loadPageOptions()
  }, [canManage, loadPageOptions, pendingStateId])

  async function connect() {
    setBusy('connect')
    setError('')
    try {
      const result = (await request(
        `/api/workspaces/${workspace.id}/facebook/oauth/start`,
        {},
      )) as {
        authorizationUrl: string
      }
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
      toast.success('Page 连接状态已更新')
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
      closePagePicker()
      toast.success('Facebook Page 已连接')
    } catch (cause) {
      setError(facebookErrorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  function closePagePicker() {
    setPages(undefined)
    setSelectedPageIds([])
    setError('')
    setPendingStateId(null)
    history.replaceState(null, '', '/settings/facebook')
  }

  async function disable(channel: FacebookChannel) {
    setBusy(channel.id)
    setError('')
    try {
      await request(`/api/workspaces/${workspace.id}/channels/${channel.id}/disable`, {})
      await refresh()
      setDisablingChannel(null)
      toast.success('Facebook Page 已停用')
    } catch (cause) {
      setError(facebookErrorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  return (
    <main className="workspace-page facebook-page">
      <PageHeader
        actions={
          canManage && (
            <Button disabled={busy === 'connect'} onClick={() => void connect()}>
              {busy === 'connect' ? '正在打开…' : '连接 Page'}
            </Button>
          )
        }
        description="管理已连接的 Messenger Page 与连接状态。"
        eyebrow="工作区设置"
        title="Facebook / Messenger"
      />

      {loadError && (
        <div className="page-error" role="alert">
          <p>{loadError}</p>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            重试
          </Button>
        </div>
      )}
      {error && !pendingStateId && !disablingChannel && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}

      <section aria-labelledby="facebook-pages-title">
        <div className="list-heading">
          <h2 id="facebook-pages-title">已连接的 Page</h2>
          {channels && <span>{channels.length} 个</span>}
        </div>
        {!channels ? (
          <OperationalListSkeleton />
        ) : channels.length ? (
          <Table aria-labelledby="facebook-pages-title" className="ops-table facebook-table">
            <TableHeader>
              <TableRow>
                <TableHead>Page</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>最近检查</TableHead>
                <TableHead>连接信息</TableHead>
                {canManage && <TableHead className="actions-column">操作</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {channels.map((channel) => (
                <TableRow className="facebook-row" key={channel.id}>
                  <TableCell data-column="page" data-label="Page">
                    <strong>{channel.displayName}</strong>
                    <span className="table-subtitle">Facebook Messenger</span>
                  </TableCell>
                  <TableCell data-column="status" data-label="状态">
                    <StateBadge
                      status={channel.connectionStatus}
                      label={facebookStatusLabels[channel.connectionStatus]}
                    />
                  </TableCell>
                  <TableCell data-column="checked" data-label="最近检查">
                    {channel.lastCheckedAt ? (
                      <time
                        dateTime={channel.lastCheckedAt}
                        title={formatExactDate(channel.lastCheckedAt)}
                      >
                        {formatDate(channel.lastCheckedAt)}
                      </time>
                    ) : (
                      <span className="table-muted">尚未检查</span>
                    )}
                  </TableCell>
                  <TableCell data-column="message" data-label="连接信息">
                    {channel.connectionStatus === 'ACTION_REQUIRED' ? (
                      <div className="connection-failure">
                        <span>
                          {channel.lastErrorMessage ?? '连接需要处理，请重新连接或检查 Page 权限。'}
                        </span>
                        {channel.lastErrorCode && (
                          <span className="table-muted">代码：{channel.lastErrorCode}</span>
                        )}
                      </div>
                    ) : (
                      <span className="table-muted">—</span>
                    )}
                  </TableCell>
                  {canManage && (
                    <TableCell data-column="actions" data-label="操作">
                      <div className="facebook-row-actions">
                        {channel.connectionStatus === 'ACTIVE' ? (
                          <Button
                            disabled={Boolean(busy)}
                            size="sm"
                            variant="outline"
                            onClick={() => void recheck(channel)}
                          >
                            {busy === channel.id ? '检查中…' : '重新检查'}
                          </Button>
                        ) : (
                          <Button
                            disabled={busy === 'connect'}
                            size="sm"
                            onClick={() => void connect()}
                          >
                            重新连接
                          </Button>
                        )}
                        {channel.connectionStatus !== 'DISABLED' && (
                          <DropdownMenu>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    aria-label={`${channel.displayName} 的更多操作`}
                                    disabled={Boolean(busy)}
                                    size="icon-sm"
                                    variant="ghost"
                                  >
                                    <MoreHorizontal aria-hidden="true" />
                                  </Button>
                                </DropdownMenuTrigger>
                              </TooltipTrigger>
                              <TooltipContent>更多 Page 操作</TooltipContent>
                            </Tooltip>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                className="text-destructive"
                                onSelect={() => setDisablingChannel(channel)}
                              >
                                停用 Page
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState
            description="连接 Facebook Page 后，团队即可在收件箱中处理 Messenger 对话。"
            title="还没有连接 Page"
          />
        )}
      </section>

      <Dialog
        open={Boolean(pendingStateId && canManage)}
        onOpenChange={(open) => {
          if (!open) closePagePicker()
        }}
      >
        <DialogContent className="ui-dialog-content">
          <DialogHeader>
            <DialogTitle>选择要连接的 Page</DialogTitle>
            <DialogDescription>
              选择要接收 Messenger 对话的 Page。访问凭据会由 DeepSales 安全保存。
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {!pages ? (
            <>
              <div aria-hidden="true" className="dialog-loading">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
              {error && (
                <Button size="sm" variant="outline" onClick={() => void loadPageOptions()}>
                  重试
                </Button>
              )}
            </>
          ) : pages.length ? (
            <form className="dialog-form" onSubmit={selectPages}>
              <div className="facebook-page-options">
                {pages.map((page) => (
                  <div className="facebook-page-option" key={page.id}>
                    <Checkbox
                      aria-label={page.name}
                      checked={selectedPageIds.includes(page.id)}
                      onCheckedChange={(checked) =>
                        setSelectedPageIds((current) =>
                          checked === true
                            ? [...current, page.id]
                            : current.filter((id) => id !== page.id),
                        )
                      }
                    />
                    <span>{page.name}</span>
                  </div>
                ))}
              </div>
              <DialogFooter>
                <Button disabled={!selectedPageIds.length || busy === 'select'} type="submit">
                  {busy === 'select' ? '正在连接…' : '连接所选 Page'}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <>
              <p className="table-muted">此 Facebook 账户下没有可连接的 Page。</p>
              <DialogFooter>
                <Button variant="outline" onClick={closePagePicker}>
                  关闭
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        busy={busy === disablingChannel?.id}
        busyLabel="正在停用…"
        confirmLabel="停用 Page"
        description={`停用“${disablingChannel?.displayName ?? ''}”后，它将不再接收新的 Messenger 对话。`}
        error={error}
        onConfirm={async () => {
          if (disablingChannel) await disable(disablingChannel)
        }}
        onOpenChange={(open) => {
          if (!open) setDisablingChannel(null)
        }}
        open={Boolean(disablingChannel)}
        title="停用 Facebook Page？"
      />
    </main>
  )
}
const knowledgeStatusLabels: Record<KnowledgeDocument['status'], string> = {
  UPLOADED: '已上传',
  PROCESSING: '处理中',
  READY: '已就绪',
  FAILED: '失败',
}
const knowledgeSourceLabels: Record<KnowledgeDocument['sourceType'], string> = {
  TEXT: '文本',
  PDF: 'PDF',
  DOCX: 'DOCX',
  TXT: 'TXT',
  MARKDOWN: 'Markdown',
}
const knowledgeFailureLabels: Record<string, string> = {
  EMPTY_CONTENT: '文本内容为空',
  TOO_LARGE: '文本内容过大',
  MIME_MISMATCH: '文件类型与扩展名不一致',
  INVALID_FILE_SIGNATURE: '文件格式无效',
  INVALID_UTF8: '文件编码无效',
  FILE_EXTRACTION_FAILED: '文件无法解析',
  UPLOAD_READ_FAILED: '文件读取失败',
  DOCUMENT_CONTENT_MISSING: '文档内容不可用',
  INVALID_EMBEDDING: '嵌入结果无效',
  AI_PROVIDER_ERROR: 'AI 服务返回了无效结果',
  QUOTA_EXHAUSTED: 'AI 用量已达上限；请联系管理员调整预算后重新提交内容。',
  OPERATION_PAUSED: '索引任务已暂停；请联系管理员检查 AI 运行状态。',
}

function KnowledgePage({ workspace }: { workspace: Workspace }) {
  const [knowledgeAssets, setKnowledgeAssets] = useState<{ id: string; title: string }[]>()
  const [bases, setBases] = useState<KnowledgeBase[]>()
  const [selectedBaseId, setSelectedBaseId] = useState<string | null>(null)
  const [documents, setDocuments] = useState<KnowledgeDocument[]>()
  const [loadError, setLoadError] = useState('')
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState('')
  const [addBaseOpen, setAddBaseOpen] = useState(false)
  const [addTextOpen, setAddTextOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [deletingDocument, setDeletingDocument] = useState<KnowledgeDocument | null>(null)
  const [questionDraft, setQuestionDraft] = useState<{
    id: string
    question: string
    answer: string
    revision?: number
  } | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importItems, setImportItems] = useState<
    { id: string; question: string; answer: string }[]
  >([])
  const canManage = workspace.role !== 'AGENT'
  const selectedBase = bases?.find(({ id }) => id === selectedBaseId)
  useEffect(() => {
    if (!addTextOpen) return
    let cancelled = false
    setKnowledgeAssets(undefined)
    void fetch(`/api/workspaces/${workspace.id}/media-assets`)
      .then(async (response) => {
        if (!response.ok) throw await responseError(response)
        const result = (await response.json()) as { assets: { id: string; title: string }[] }
        if (!cancelled) setKnowledgeAssets(result.assets)
      })
      .catch((cause) => {
        if (!cancelled) {
          setKnowledgeAssets([])
          setFormError(knowledgeErrorMessage(cause))
        }
      })
    return () => {
      cancelled = true
    }
  }, [addTextOpen, workspace.id])

  const refreshBases = useCallback(async () => {
    const response = await fetch(`/api/workspaces/${workspace.id}/knowledge-bases`)
    if (!response.ok) throw await responseError(response)
    const next = ((await response.json()) as { knowledgeBases: KnowledgeBase[] }).knowledgeBases
    setBases(next)
    setLoadError('')
    setSelectedBaseId((current) =>
      current && next.some(({ id }) => id === current) ? current : (next[0]?.id ?? null),
    )
  }, [workspace.id])

  const refreshDocuments = useCallback(
    async (knowledgeBaseId: string) => {
      const response = await fetch(
        `/api/workspaces/${workspace.id}/knowledge-bases/${knowledgeBaseId}/documents`,
      )
      if (!response.ok) throw await responseError(response)
      setDocuments(((await response.json()) as { documents: KnowledgeDocument[] }).documents)
      setLoadError('')
    },
    [workspace.id],
  )

  useEffect(() => {
    void refreshBases().catch((cause) => setLoadError(knowledgeErrorMessage(cause)))
  }, [refreshBases])

  useEffect(() => {
    if (!selectedBaseId) {
      setDocuments([])
      return
    }
    setDocuments(undefined)
    void refreshDocuments(selectedBaseId).catch((cause) =>
      setLoadError(knowledgeErrorMessage(cause)),
    )
  }, [refreshDocuments, selectedBaseId])

  const processingDocuments = documents?.some(
    ({ status }) => status === 'UPLOADED' || status === 'PROCESSING',
  )
  useEffect(() => {
    if (!selectedBaseId) return
    let timer: number | undefined
    const refresh = () => {
      if (document.hidden) return
      void refreshDocuments(selectedBaseId).catch((cause) =>
        setLoadError(knowledgeErrorMessage(cause)),
      )
    }
    const updatePolling = () => {
      window.clearInterval(timer)
      timer = undefined
      if (!document.hidden && processingDocuments) timer = window.setInterval(refresh, 2_000)
    }
    const visibilityChanged = () => {
      refresh()
      updatePolling()
    }
    updatePolling()
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [processingDocuments, refreshDocuments, selectedBaseId])

  async function createBase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    setBusy('base')
    setFormError('')
    try {
      const data = new FormData(form)
      const result = (await request(`/api/workspaces/${workspace.id}/knowledge-bases`, {
        name: data.get('name'),
      })) as { knowledgeBase: KnowledgeBase }
      form.reset()
      await refreshBases()
      setSelectedBaseId(result.knowledgeBase.id)
      setAddBaseOpen(false)
      toast.success('知识库已创建')
    } catch (cause) {
      setFormError(knowledgeErrorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function addText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedBaseId) return
    const form = event.currentTarget
    setBusy('document')
    setFormError('')
    try {
      const data = new FormData(form)
      const result = (await request(
        '/api/workspaces/' +
          workspace.id +
          '/knowledge-bases/' +
          selectedBaseId +
          '/documents/text',
        {
          name: data.get('name'),
          text: data.get('text'),
          ...(data.get('mediaAssetId') && data.get('mediaAssetId') !== 'NONE'
            ? { mediaAssetId: data.get('mediaAssetId') }
            : {}),
        },
      )) as { document: KnowledgeDocument }
      form.reset()
      setDocuments((current) => (current ? [...current, result.document] : [result.document]))
      setAddTextOpen(false)
      toast.success('文本已添加，正在处理')
    } catch (cause) {
      setFormError(knowledgeErrorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function addFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedBaseId) return
    const form = event.currentTarget
    const data = new FormData(form)
    if (!(data.get('file') instanceof File)) return
    setBusy('document')
    setFormError('')
    try {
      const response = await fetch(
        '/api/workspaces/' +
          workspace.id +
          '/knowledge-bases/' +
          selectedBaseId +
          '/documents/upload',
        { method: 'POST', body: data },
      )
      if (!response.ok) throw await responseError(response)
      const result = (await response.json()) as { document: KnowledgeDocument }
      form.reset()
      setDocuments((current) => (current ? [...current, result.document] : [result.document]))
      setUploadOpen(false)
      toast.success('文档已上传，正在处理')
    } catch (cause) {
      setFormError(knowledgeErrorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function removeDocument(document: KnowledgeDocument) {
    if (!selectedBaseId) return
    setBusy(document.id)
    setFormError('')
    try {
      await request(
        '/api/workspaces/' +
          workspace.id +
          '/knowledge-bases/' +
          selectedBaseId +
          '/documents/' +
          document.id,
        {},
        'DELETE',
      )
      await refreshDocuments(selectedBaseId)
      setDeletingDocument(null)
      toast.success('文档已删除')
    } catch (cause) {
      setFormError(knowledgeErrorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  function openDocumentDialog(kind: 'text' | 'upload') {
    setFormError('')
    if (kind === 'text') setAddTextOpen(true)
    else setUploadOpen(true)
  }

  function openQuestion(document?: KnowledgeDocument) {
    setFormError('')
    setQuestionDraft({
      id: document?.id ?? crypto.randomUUID(),
      question: document?.question ?? '',
      answer: document?.answer ?? '',
      revision: document?.revision,
    })
  }

  async function saveQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canManage || !selectedBaseId || !questionDraft) return
    setBusy('question')
    setFormError('')
    const path = `/api/workspaces/${workspace.id}/knowledge-bases/${selectedBaseId}/documents/questions`
    try {
      if (questionDraft.revision) {
        await request(
          `${path}/${questionDraft.id}`,
          {
            question: questionDraft.question,
            answer: questionDraft.answer,
            expectedRevision: questionDraft.revision,
          },
          'PATCH',
        )
      } else {
        await request(path, { items: [questionDraft] })
      }
      await refreshDocuments(selectedBaseId)
      setQuestionDraft(null)
      toast.success('问答已保存，正在处理')
    } catch (cause) {
      setFormError(knowledgeErrorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function readQuestions(file?: File) {
    setImportItems([])
    setFormError('')
    if (!file) return
    setBusy('reading')
    try {
      if (file.size > 1024 * 1024) throw new Error('文件不能超过 1 MiB。')
      const items: unknown = JSON.parse(await file.text())
      if (!Array.isArray(items) || !items.length || items.length > 100) {
        throw new Error('文件必须包含 1–100 条问答。')
      }
      const parsed = items.map((item: unknown) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new Error('每条问答必须包含 question 和 answer。')
        }
        const entry = item as Record<string, unknown>
        if (
          typeof entry.question !== 'string' ||
          typeof entry.answer !== 'string' ||
          Object.keys(entry).some((key) => key !== 'question' && key !== 'answer')
        ) {
          throw new Error('每条问答只能包含 question 和 answer 两个文本字段。')
        }
        return { id: crypto.randomUUID(), question: entry.question, answer: entry.answer }
      })
      setImportItems(parsed)
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : '文件无法读取，请重新选择。')
    } finally {
      setBusy('')
    }
  }

  async function importQuestions(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedBaseId || !importItems.length) return
    setBusy('questions')
    setFormError('')
    try {
      await request(
        `/api/workspaces/${workspace.id}/knowledge-bases/${selectedBaseId}/documents/questions`,
        { items: importItems },
      )
      await refreshDocuments(selectedBaseId)
      setImportOpen(false)
      toast.success('问答已导入；相同内容已合并')
    } catch (cause) {
      setFormError(knowledgeErrorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  return (
    <main className="workspace-page knowledge-page">
      <PageHeader
        actions={
          canManage &&
          selectedBase && (
            <>
              <Button variant="outline" onClick={() => openQuestion()}>
                添加问答
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setFormError('')
                  setImportItems([])
                  setImportOpen(true)
                }}
              >
                导入问答
              </Button>
              <Button variant="outline" onClick={() => openDocumentDialog('upload')}>
                上传文档
              </Button>
              <Button onClick={() => openDocumentDialog('text')}>添加文本</Button>
              <Button variant="outline" onClick={() => openDocumentDialog('text')}>
                引用素材
              </Button>
            </>
          )
        }
        description="维护供 AI 回复使用的业务文本与文件。"
        eyebrow="工作区"
        title="知识库"
      />

      {loadError && (
        <div className="page-error" role="alert">
          <p>{loadError}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void (selectedBaseId ? refreshDocuments(selectedBaseId) : refreshBases()).catch(
                (cause) => setLoadError(knowledgeErrorMessage(cause)),
              )
            }
          >
            重试
          </Button>
        </div>
      )}

      {!bases ? (
        loadError ? null : (
          <OperationalListSkeleton />
        )
      ) : !bases.length ? (
        <EmptyState
          action={
            canManage ? <Button onClick={() => setAddBaseOpen(true)}>创建知识库</Button> : undefined
          }
          description="创建知识库后，可添加文本或 PDF、DOCX、TXT、Markdown 文档。"
          title="还没有知识库"
        />
      ) : (
        <>
          <div className="knowledge-base-toolbar">
            <div className="form-field">
              <label className="form-field-label" htmlFor="knowledge-base-select">
                知识库
              </label>
              <Select
                value={selectedBaseId ?? ''}
                onValueChange={(value) => setSelectedBaseId(value)}
              >
                <SelectTrigger aria-label="知识库" id="knowledge-base-select">
                  <SelectValue placeholder="选择知识库" />
                </SelectTrigger>
                <SelectContent>
                  {bases.map((base) => (
                    <SelectItem key={base.id} value={base.id}>
                      {base.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {canManage && (
              <Button size="sm" variant="outline" onClick={() => setAddBaseOpen(true)}>
                新建知识库
              </Button>
            )}
          </div>
          {selectedBase && (
            <section aria-labelledby="knowledge-documents-title" className="knowledge-documents">
              <div className="list-heading">
                <h2 id="knowledge-documents-title">{selectedBase.name} 的文档</h2>
                {documents && <span>{documents.length} 个</span>}
              </div>
              {!documents ? (
                <OperationalListSkeleton />
              ) : documents.length ? (
                <Table
                  aria-labelledby="knowledge-documents-title"
                  className="ops-table knowledge-table"
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead>文档</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>更新时间</TableHead>
                      {canManage && <TableHead className="actions-column">操作</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {documents.map((document) => (
                      <TableRow
                        className="knowledge-document"
                        data-source-type={document.sourceType}
                        data-status={document.status}
                        key={document.id}
                      >
                        <TableCell data-column="document" data-label="文档">
                          {document.question ? (
                            <Button
                              variant="link"
                              className="h-auto justify-start p-0 text-left whitespace-normal"
                              aria-label={`查看问答：${document.name}`}
                              onClick={() => openQuestion(document)}
                            >
                              <strong>{document.name}</strong>
                            </Button>
                          ) : (
                            <strong>{document.name}</strong>
                          )}
                          {document.answer && (
                            <span className="table-subtitle">{document.answer.slice(0, 120)}</span>
                          )}
                          {document.status === 'FAILED' && (
                            <span className="document-failure">
                              {knowledgeFailureLabels[document.failureCode ?? ''] ??
                                '处理失败，请重试或重新上传。'}
                            </span>
                          )}
                        </TableCell>
                        <TableCell data-column="type" data-label="类型">
                          {document.mediaAssetId
                            ? '素材描述'
                            : document.question
                              ? '问答'
                              : knowledgeSourceLabels[document.sourceType]}
                        </TableCell>
                        <TableCell data-column="status" data-label="状态">
                          <StateBadge
                            status={document.status}
                            label={knowledgeStatusLabels[document.status]}
                          />
                          {document.mediaAvailable === false && (
                            <StatusBadge tone="warning">引用素材已失效</StatusBadge>
                          )}
                          {document.status === 'PROCESSING' && (
                            <span className="table-subtitle">后台处理中</span>
                          )}
                        </TableCell>
                        <TableCell data-column="updated" data-label="更新时间">
                          <time
                            dateTime={document.updatedAt}
                            title={formatExactDate(document.updatedAt)}
                          >
                            {formatDate(document.updatedAt)}
                          </time>
                        </TableCell>
                        {canManage && (
                          <TableCell data-column="actions" data-label="操作">
                            <DropdownMenu>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      aria-label={`${document.name} 的更多操作`}
                                      disabled={Boolean(busy)}
                                      size="icon-sm"
                                      variant="ghost"
                                    >
                                      <MoreHorizontal aria-hidden="true" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                </TooltipTrigger>
                                <TooltipContent>更多文档操作</TooltipContent>
                              </Tooltip>
                              <DropdownMenuContent align="end">
                                {document.question && (
                                  <DropdownMenuItem onSelect={() => openQuestion(document)}>
                                    编辑问答
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onSelect={() => {
                                    setFormError('')
                                    setDeletingDocument(document)
                                  }}
                                >
                                  删除文档
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState
                  description="添加业务文本或上传受支持的文件，供 AI 回复时检索。"
                  title="此知识库还没有文档"
                />
              )}
            </section>
          )}
        </>
      )}

      <Dialog
        open={Boolean(questionDraft)}
        onOpenChange={(open) => {
          if (!open && !busy) setQuestionDraft(null)
        }}
      >
        <DialogContent className="ui-dialog-content">
          <DialogHeader>
            <DialogTitle>
              {!canManage ? '查看问答' : questionDraft?.revision ? '编辑问答' : '添加问答'}
            </DialogTitle>
            <DialogDescription>
              问题最多 400 字，答案最多 1,500 字。保存后重新处理；新内容就绪前不会检索旧答案。
            </DialogDescription>
          </DialogHeader>
          <form className="dialog-form" onSubmit={saveQuestion}>
            <div className="form-field">
              <label className="form-field-label" htmlFor="knowledge-question">
                问题
              </label>
              <Textarea
                id="knowledge-question"
                aria-describedby="knowledge-question-count"
                required
                rows={3}
                maxLength={800}
                disabled={Boolean(busy)}
                readOnly={!canManage}
                value={questionDraft?.question ?? ''}
                onChange={(event) =>
                  setQuestionDraft(
                    (current) =>
                      current && {
                        ...current,
                        question: event.target.value,
                      },
                  )
                }
              />
              <span className="table-subtitle" id="knowledge-question-count">
                {Array.from(questionDraft?.question ?? '').length} / 400 字
              </span>
            </div>
            <div className="form-field">
              <label className="form-field-label" htmlFor="knowledge-answer">
                答案
              </label>
              <Textarea
                id="knowledge-answer"
                aria-describedby="knowledge-answer-count"
                required
                rows={8}
                maxLength={3000}
                disabled={Boolean(busy)}
                readOnly={!canManage}
                value={questionDraft?.answer ?? ''}
                onChange={(event) =>
                  setQuestionDraft(
                    (current) =>
                      current && {
                        ...current,
                        answer: event.target.value,
                      },
                  )
                }
              />
              <span className="table-subtitle" id="knowledge-answer-count">
                {Array.from(questionDraft?.answer ?? '').length} / 1,500 字
              </span>
            </div>
            {formError && (
              <p className="inline-error" role="alert">
                {formError}
              </p>
            )}
            {canManage && (
              <DialogFooter>
                <Button
                  type="submit"
                  disabled={
                    Boolean(busy) ||
                    Array.from(questionDraft?.question ?? '').length > 400 ||
                    Array.from(questionDraft?.answer ?? '').length > 1500
                  }
                >
                  {busy ? '正在保存…' : '保存问答'}
                </Button>
              </DialogFooter>
            )}
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          if (!busy) setImportOpen(open)
        }}
      >
        <DialogContent className="ui-dialog-content">
          <DialogHeader>
            <DialogTitle>导入问答</DialogTitle>
            <DialogDescription>
              选择 JSON 数组文件，最多 100 条、1 MiB。每条只包含 question 和 answer；问题最多 400
              字，答案最多 1,500 字。 相同内容自动合并；相同问题的不同答案会使整个文件导入失败。
            </DialogDescription>
          </DialogHeader>
          <form className="dialog-form" onSubmit={importQuestions}>
            <label className="form-field" htmlFor="knowledge-questions-file">
              <span className="form-field-label">问答文件</span>
              <Input
                id="knowledge-questions-file"
                type="file"
                accept=".json,application/json"
                required
                disabled={Boolean(busy)}
                onChange={(event) => void readQuestions(event.target.files?.[0])}
              />
            </label>
            <p className="table-subtitle">
              {
                '示例：[{"question":"How do I clean the lamp?","answer":"Disconnect power and use a dry cloth."}]'
              }
            </p>
            {importItems.length > 0 && <p>已读取 {importItems.length} 条问答</p>}
            {formError && (
              <p className="inline-error" role="alert">
                {formError}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={Boolean(busy) || !importItems.length}>
                {busy ? '正在读取或导入…' : '导入问答'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={addBaseOpen}
        onOpenChange={(open) => {
          setAddBaseOpen(open)
          if (open) setFormError('')
        }}
      >
        <DialogContent className="ui-dialog-content">
          <DialogHeader>
            <DialogTitle>创建知识库</DialogTitle>
            <DialogDescription>知识库会收纳供 AI 成员检索的业务文档。</DialogDescription>
          </DialogHeader>
          <form className="dialog-form" onSubmit={createBase}>
            <Field label="知识库名称" name="name" maxLength={100} />
            {formError && (
              <p className="inline-error" role="alert">
                {formError}
              </p>
            )}
            <DialogFooter>
              <Button disabled={busy === 'base'} type="submit">
                {busy === 'base' ? '正在创建…' : '创建知识库'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={addTextOpen}
        onOpenChange={(open) => {
          setAddTextOpen(open)
          if (open) setFormError('')
        }}
      >
        <DialogContent className="ui-dialog-content">
          <DialogHeader>
            <DialogTitle>添加文本</DialogTitle>
            <DialogDescription>
              文本提交后会在后台处理。选择私有素材时，文本用作可检索描述，AI
              可按授权引用发送；不会读取文件全文。
            </DialogDescription>
          </DialogHeader>
          <form className="dialog-form" onSubmit={addText}>
            <Field label="文档名称" name="name" maxLength={100} />
            <div className="form-field">
              <span id="knowledge-asset-label" className="form-field-label">
                引用私有素材（可选）
              </span>
              <Select name="mediaAssetId" defaultValue="NONE" disabled={!knowledgeAssets}>
                <SelectTrigger aria-labelledby="knowledge-asset-label">
                  <SelectValue placeholder="正在读取素材…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">无（普通文本）</SelectItem>
                  {knowledgeAssets?.map((asset) => (
                    <SelectItem key={asset.id} value={asset.id}>
                      {asset.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="field-description">
                素材需先在收件箱素材库保存。描述最多 2,000
                字；删除知识条目或停用素材后，新回复不能再引用。
              </p>
            </div>
            <label className="form-field" htmlFor="knowledge-document-text">
              <span className="form-field-label">文本内容</span>
              <Textarea id="knowledge-document-text" name="text" required rows={8} />
            </label>
            {formError && (
              <p className="inline-error" role="alert">
                {formError}
              </p>
            )}
            <DialogFooter>
              <Button disabled={busy === 'document'} type="submit">
                {busy === 'document' ? '正在提交…' : '添加文本'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={uploadOpen}
        onOpenChange={(open) => {
          setUploadOpen(open)
          if (open) setFormError('')
        }}
      >
        <DialogContent className="ui-dialog-content">
          <DialogHeader>
            <DialogTitle>上传文档</DialogTitle>
            <DialogDescription>支持 PDF、DOCX、TXT 和 Markdown，最大 10 MiB。</DialogDescription>
          </DialogHeader>
          <form className="dialog-form" onSubmit={addFile}>
            <label className="form-field" htmlFor="knowledge-document-file">
              <span className="form-field-label">文件</span>
              <Input
                accept=".pdf,.docx,.txt,.md,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
                id="knowledge-document-file"
                name="file"
                required
                type="file"
              />
            </label>
            {formError && (
              <p className="inline-error" role="alert">
                {formError}
              </p>
            )}
            <DialogFooter>
              <Button disabled={busy === 'document'} type="submit">
                {busy === 'document' ? '正在上传…' : '上传文档'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        busy={busy === deletingDocument?.id}
        busyLabel="正在删除…"
        confirmLabel="删除文档"
        description={`删除“${deletingDocument?.name ?? ''}”后，AI 将无法再检索其中内容。`}
        error={formError}
        onConfirm={async () => {
          if (deletingDocument) await removeDocument(deletingDocument)
        }}
        onOpenChange={(open) => {
          if (!open) setDeletingDocument(null)
        }}
        open={Boolean(deletingDocument)}
        title="删除此文档？"
      />
    </main>
  )
}
function AiMemberPage({ workspace, memberId }: { workspace: Workspace; memberId: string }) {
  const [config, setConfig] = useState<AiMemberConfig>()
  const [draft, setDraft] = useState<AiMemberDraft>()
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [memberChannels, setMemberChannels] = useState<string[]>([])
  const [loadError, setLoadError] = useState('')
  const [formError, setFormError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const canManage = workspace.role !== 'AGENT'

  const load = useCallback(async () => {
    const [configResponse, basesResponse, teamResponse] = await Promise.all([
      fetch(`/api/workspaces/${workspace.id}/ai-members/${memberId}/config`),
      fetch(`/api/workspaces/${workspace.id}/knowledge-bases`),
      fetch(`/api/workspaces/${workspace.id}/team`),
    ])
    if (!configResponse.ok) throw await responseError(configResponse)
    if (!basesResponse.ok) throw await responseError(basesResponse)
    if (!teamResponse.ok) throw await responseError(teamResponse)
    const nextConfig = ((await configResponse.json()) as { config: AiMemberConfig }).config
    const bases = (await basesResponse.json()) as { knowledgeBases: KnowledgeBase[] }
    const team = (await teamResponse.json()) as Team
    const aiMember = team.members.find((member) => member.id === memberId)
    setConfig(nextConfig)
    setDraft(aiDraftFromConfig(nextConfig))
    setKnowledgeBases(bases.knowledgeBases)
    setMemberChannels(
      team.channels
        .filter((channel) => aiMember?.channelIds.includes(channel.id))
        .map(({ displayName }) => displayName),
    )
  }, [memberId, workspace.id])

  useEffect(() => {
    if (!canManage) return
    setLoadError('')
    void load().catch((cause) => setLoadError(aiMemberErrorMessage(cause)))
  }, [canManage, load])

  const draftDirty = Boolean(config && draft && !sameAiDraft(draft, aiDraftFromConfig(config)))
  const draftUnpublished = Boolean(
    config?.publishedSnapshot && !sameAiDraft(aiDraftFromConfig(config), config.publishedSnapshot),
  )

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft) return
    setBusy(true)
    setFormError('')
    setFeedback('')
    try {
      const result = (await request(
        `/api/workspaces/${workspace.id}/ai-members/${memberId}/config`,
        { ...draft },
        'PATCH',
      )) as { config: AiMemberConfig }
      setConfig(result.config)
      setDraft(aiDraftFromConfig(result.config))
      setFeedback('草稿已保存')
      toast.success('草稿已保存')
    } catch (cause) {
      setFormError(aiMemberErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function publish() {
    if (!config || !draft || draftDirty) return
    setBusy(true)
    setFormError('')
    setFeedback('')
    try {
      const result = (await request(
        `/api/workspaces/${workspace.id}/ai-members/${memberId}/publish`,
        {},
      )) as { config: AiMemberConfig }
      setConfig(result.config)
      setDraft(aiDraftFromConfig(result.config))
      setFeedback('运行配置已发布')
      toast.success('运行配置已发布')
    } catch (cause) {
      setFormError(aiMemberErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!canManage) {
    return (
      <main className="workspace-page ai-member-page">
        <PageHeader backHref="/team" eyebrow="AI 成员" title="无权查看配置" />
        <p className="inline-error" role="alert">
          你没有管理 AI 成员配置的权限。
        </p>
      </main>
    )
  }
  if (loadError && !config) {
    return (
      <main className="workspace-page ai-member-page">
        <PageHeader backHref="/team" eyebrow="AI 成员" title="配置加载失败" />
        <div className="page-error" role="alert">
          <p>{loadError}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void load().catch((cause) => setLoadError(aiMemberErrorMessage(cause)))}
          >
            重试
          </Button>
        </div>
      </main>
    )
  }
  if (!config || !draft) {
    return (
      <main className="workspace-page ai-member-page">
        <PageHeader backHref="/team" eyebrow="AI 成员" title="正在加载…" />
        <div aria-hidden="true" className="ai-skeleton">
          <Skeleton className="ai-skeleton-title" />
          <Skeleton className="ai-skeleton-field" />
          <Skeleton className="ai-skeleton-field" />
          <Skeleton className="ai-skeleton-field" />
        </div>
      </main>
    )
  }

  const draftStateLabel = draftDirty
    ? '有未保存的草稿更改'
    : !config.publishedSnapshot
      ? '尚未发布'
      : draftUnpublished
        ? '草稿尚未发布'
        : '草稿与运行配置一致'

  return (
    <main className="workspace-page ai-member-page">
      <PageHeader
        actions={
          <>
            <StateBadge
              data-runtime-status={config.runtimeStatus}
              status={config.runtimeStatus}
              label={runtimeStatusLabels[config.runtimeStatus]}
            />
            <Button disabled={busy || draftDirty} onClick={() => void publish()}>
              {busy ? '正在处理…' : '发布'}
            </Button>
          </>
        }
        backHref="/team"
        description="编辑草稿并单独发布。已发布运行配置保持不变，直到再次发布。"
        eyebrow="AI 成员"
        title={config.memberDisplayName ?? '未命名成员'}
      />

      <div className="ai-member-status-line">
        <StateBadge
          status={config.memberStatus}
          label={config.memberStatus === 'ACTIVE' ? '成员已启用' : '成员已停用'}
        />
        <Badge variant="outline">{draftStateLabel}</Badge>
      </div>

      <div className="ai-member-layout">
        <form className="ai-config-form" onSubmit={save}>
          <section aria-labelledby="ai-draft-title" className="ai-config-section">
            <div className="section-heading">
              <div>
                <h2 id="ai-draft-title">可编辑草稿</h2>
                <p>这些设置只有在发布后才会影响 AI 回复。</p>
              </div>
              <Badge variant="outline">草稿</Badge>
            </div>
            <label className="form-field" htmlFor="ai-instructions">
              <span className="form-field-label">指令</span>
              <Textarea
                id="ai-instructions"
                name="instructions"
                value={draft.instructions}
                maxLength={20_000}
                onChange={(event) => {
                  const value = event.currentTarget.value
                  setDraft((current) => (current ? { ...current, instructions: value } : current))
                }}
              />
              <span className="field-description">
                发布前需要填写。说明 AI 应如何回答客户问题。
              </span>
            </label>
            <div className="switch-field">
              <div>
                <span className="form-field-label" id="ai-auto-language-label">
                  自动回复语言
                </span>
                <p className="field-description" id="ai-auto-language-help">
                  从早期有效客户文字确定语言并沿用；客户明确要求时切换。数字、表情或简短问候不改变语言，无法识别时使用下方回复语言。
                </p>
              </div>
              <Switch
                aria-labelledby="ai-auto-language-label"
                aria-describedby="ai-auto-language-help"
                checked={draft.automaticLanguageEnabled}
                disabled={busy}
                onCheckedChange={(value) =>
                  setDraft((current) =>
                    current ? { ...current, automaticLanguageEnabled: value } : current,
                  )
                }
              />
            </div>
            <label className="form-field" htmlFor="ai-time-zone">
              <span className="form-field-label">当前时间时区</span>
              <Input
                id="ai-time-zone"
                disabled={busy}
                name="timeZone"
                value={draft.timeZone}
                maxLength={100}
                onChange={(event) => {
                  const value = event.currentTarget.value
                  setDraft((current) => (current ? { ...current, timeZone: value } : current))
                }}
              />
              <span className="field-description">
                使用服务端当前时间。填写 UTC 或 Asia/Hong_Kong 等时区；保存并发布后生效。
              </span>
            </label>
            <div className="form-grid-two">
              <label className="form-field" htmlFor="ai-response-language">
                <span className="form-field-label">回复语言</span>
                <Input
                  id="ai-response-language"
                  name="responseLanguage"
                  value={draft.responseLanguage}
                  maxLength={100}
                  onChange={(event) => {
                    const value = event.currentTarget.value
                    setDraft((current) =>
                      current ? { ...current, responseLanguage: value } : current,
                    )
                  }}
                />
                <span className="field-description">
                  发布前需要填写。固定模式使用此语言；自动模式在尚未确定语言时使用此回退。
                </span>
              </label>
              <div className="form-field">
                <span className="form-field-label" id="ai-knowledge-base-label">
                  知识库
                </span>
                <Select
                  name="knowledgeBaseId"
                  value={draft.knowledgeBaseId ?? ''}
                  onValueChange={(value) =>
                    setDraft((current) =>
                      current ? { ...current, knowledgeBaseId: value || null } : current,
                    )
                  }
                >
                  <SelectTrigger aria-labelledby="ai-knowledge-base-label" id="ai-knowledge-base">
                    <SelectValue placeholder="选择知识库" />
                  </SelectTrigger>
                  <SelectContent>
                    {knowledgeBases.map((knowledgeBase) => (
                      <SelectItem key={knowledgeBase.id} value={knowledgeBase.id}>
                        {knowledgeBase.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="field-description">
                  {knowledgeBases.length ? (
                    '发布前需要选择一个知识库。'
                  ) : (
                    <a href="/knowledge">先创建知识库</a>
                  )}
                </span>
              </div>
            </div>
          </section>

          <Separator />

          <section aria-labelledby="ai-handoff-title" className="ai-config-section">
            <div className="section-heading">
              <div>
                <h2 id="ai-handoff-title">转人工策略</h2>
                <p>选择 AI 在这些情况下应交由人工客服继续处理。</p>
              </div>
            </div>
            <div className="handoff-switch-grid">
              {(
                [
                  ['handoffOnCustomerRequest', '客户要求人工时转接'],
                  ['handoffOnNoKnowledge', '缺少相关知识时转接'],
                  ['handoffOnNegativeSentiment', '检测到负面情绪时转接'],
                  ['handoffOnUnableToAnswer', '无法回答时转接'],
                ] as const
              ).map(([key, label]) => (
                <div className="switch-field" key={key}>
                  <span>{label}</span>
                  <Switch
                    aria-label={label}
                    checked={draft[key]}
                    disabled={busy}
                    name={key}
                    onCheckedChange={(checked) =>
                      setDraft((current) => (current ? { ...current, [key]: checked } : current))
                    }
                  />
                </div>
              ))}
            </div>
            <Field
              description="用逗号分隔多个关键词。客户消息包含关键词时会触发转人工。"
              id="ai-handoff-keywords"
              label="转人工关键词"
              name="handoffKeywords"
              value={draft.handoffKeywords.join(', ')}
              maxLength={10_000}
              placeholder="人工, 客服"
              required={false}
              onChange={(event) => {
                const handoffKeywords = event.currentTarget.value.split(/[,\n]/)
                setDraft((current) => (current ? { ...current, handoffKeywords } : current))
              }}
            />
          </section>

          <Separator />
          <section aria-labelledby="ai-style-title" className="ai-config-section">
            <div className="section-heading">
              <div>
                <h2 id="ai-style-title">回复语气与等待</h2>
                <p>保存为草稿，发布后生效。AI 身份和转人工策略保持明确。</p>
              </div>
            </div>
            <div className="switch-field">
              <span id="ai-natural-label">自然语气</span>
              <Switch
                aria-labelledby="ai-natural-label"
                aria-describedby="ai-natural-description"
                checked={draft.naturalToneEnabled}
                disabled={busy}
                onCheckedChange={(checked) =>
                  setDraft((current) =>
                    current ? { ...current, naturalToneEnabled: checked } : current,
                  )
                }
              />
            </div>
            <p id="ai-natural-description" className="field-description">
              使用清晰、简洁的对话语气，不冒充真人客服；回答仍须依据知识库。
            </p>
            <div className="switch-field">
              <span id="ai-wait-label">等待合并输入</span>
              <Switch
                aria-labelledby="ai-wait-label"
                aria-describedby="ai-wait-description"
                checked={draft.replyWaitEnabled}
                disabled={busy}
                onCheckedChange={(checked) =>
                  setDraft((current) =>
                    current ? { ...current, replyWaitEnabled: checked } : current,
                  )
                }
              />
            </div>
            <p id="ai-wait-description" className="field-description">
              启用时等待 2 秒收齐连续输入，最多等待 30
              秒后尝试处理。关闭后立即进入处理队列；新输入和人工接管仍会阻止旧回复。
            </p>
            <div className="switch-field">
              <span id="ai-split-label">拆分长回复</span>
              <Switch
                aria-labelledby="ai-split-label"
                aria-describedby="ai-split-description"
                checked={draft.splitRepliesEnabled}
                disabled={busy}
                onCheckedChange={(checked) =>
                  setDraft((current) =>
                    current ? { ...current, splitRepliesEnabled: checked } : current,
                  )
                }
              />
            </div>
            <p id="ai-split-description" className="field-description">
              默认停用。启用后约每 500 字拆分，最多 3 段，保留全部内容。前段发送成功后至少等待 1
              秒发送下一段；前段失败时后续暂停。拆分不增加逻辑回复用量。
            </p>
          </section>
          <Separator />
          <section aria-labelledby="ai-ad-title" className="ai-config-section">
            <div className="section-heading">
              <div>
                <h2 id="ai-ad-title">广告 ID 映射</h2>
                <p>使用客户的广告来源理解咨询；公司事实仍需知识库支持。</p>
              </div>
            </div>
            <div className="switch-field">
              <span>启用广告学习</span>
              <Switch
                aria-label="启用广告学习"
                checked={draft.adLearningEnabled}
                disabled={busy}
                onCheckedChange={(checked) =>
                  setDraft((current) =>
                    current ? { ...current, adLearningEnabled: checked } : current,
                  )
                }
              />
            </div>
            <label className="form-field" htmlFor="ai-ad-upload">
              <span className="form-field-label">上传映射表</span>
              <Input
                id="ai-ad-upload"
                type="file"
                accept=".json,application/json"
                disabled={busy}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0]
                  event.currentTarget.value = ''
                  if (!file) return
                  setBusy(true)
                  setFormError('')
                  void (async () => {
                    try {
                      if (file.size > 1024 * 1024) throw new Error()
                      const mappings: unknown = JSON.parse(await file.text())
                      if (
                        !Array.isArray(mappings) ||
                        mappings.length > 100 ||
                        mappings.some(
                          (row) =>
                            !row ||
                            typeof row !== 'object' ||
                            Array.isArray(row) ||
                            typeof row.adId !== 'string' ||
                            typeof row.content !== 'string' ||
                            Object.keys(row).some((key) => !['adId', 'content'].includes(key)),
                        )
                      )
                        throw new Error()
                      setDraft((current) =>
                        current ? { ...current, adMappings: mappings } : current,
                      )
                      setFeedback('映射表已载入草稿。保存时校验，发布后生效。')
                    } catch {
                      setFormError(
                        '无法读取映射表。请上传不超过 1 MiB 的 JSON 数组，每行只包含 adId 和 content；原表已保留。',
                      )
                    } finally {
                      setBusy(false)
                    }
                  })()
                }}
              />
              <span className="field-description">
                整表替换，最多 100 行。广告 ID 为唯一数字字符串，每条资料最多 2,000 字。格式示例：
                {'[{"adId":"123456","content":"产品参考资料"}]'}。空数组可清除。
              </span>
            </label>
            <label className="form-field" htmlFor="ai-ad-preview">
              <span className="form-field-label">草稿映射表（{draft.adMappings.length} 条）</span>
              <Textarea
                id="ai-ad-preview"
                readOnly
                value={JSON.stringify(draft.adMappings, null, 2)}
              />
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !draft.adMappings.length}
              onClick={() =>
                setDraft((current) => (current ? { ...current, adMappings: [] } : current))
              }
            >
              清空草稿映射表
            </Button>
          </section>

          {formError && (
            <p className="inline-error" role="alert">
              {formError}
            </p>
          )}
          {feedback && (
            <p className="inline-feedback" role="status">
              {feedback}
            </p>
          )}
          {draftDirty && (
            <p className="field-description" role="status">
              保存草稿后才能发布这些更改。
            </p>
          )}
          <div className="ai-form-actions">
            <Button disabled={busy || !draftDirty} type="submit" variant="outline">
              {busy ? '正在保存…' : '保存草稿'}
            </Button>
          </div>
        </form>

        <aside className="ai-runtime-column">
          <section aria-labelledby="ai-runtime-title" className="runtime-panel ai-published-panel">
            <div className="runtime-panel-heading">
              <div>
                <h2 id="ai-runtime-title">已发布运行配置</h2>
                <p>AI 正在使用的设置。</p>
              </div>
              <StateBadge
                data-runtime-status={config.runtimeStatus}
                status={config.runtimeStatus}
                label={runtimeStatusLabels[config.runtimeStatus]}
              />
            </div>
            {config.publishedAt ? (
              <p className="runtime-published-time">
                发布于{' '}
                <time dateTime={config.publishedAt} title={formatExactDate(config.publishedAt)}>
                  {formatDate(config.publishedAt)}
                </time>
              </p>
            ) : (
              <p className="runtime-published-time">尚未发布</p>
            )}
            {config.runtimeError && (
              <p className="inline-error" role="alert">
                {config.runtimeError}
              </p>
            )}
            {config.publishedSnapshot ? (
              <dl className="runtime-details">
                <div>
                  <dt>指令</dt>
                  <dd>{config.publishedSnapshot.instructions}</dd>
                </div>
                <div>
                  <dt>回复语言</dt>
                  <dd>{config.publishedSnapshot.responseLanguage}</dd>
                </div>
                <div>
                  <dt>自动回复语言</dt>
                  <dd>{config.publishedSnapshot.automaticLanguageEnabled ? '启用' : '停用'}</dd>
                </div>
                <div>
                  <dt>当前时间时区</dt>
                  <dd>{config.publishedSnapshot.timeZone ?? 'UTC'}</dd>
                </div>
                <div>
                  <dt>知识库</dt>
                  <dd>
                    {knowledgeBases.find(
                      ({ id }) => id === config.publishedSnapshot?.knowledgeBaseId,
                    )?.name ?? '已选择知识库'}
                  </dd>
                </div>
                <div>
                  <dt>客户要求人工时转接</dt>
                  <dd>{config.publishedSnapshot.handoffOnCustomerRequest ? '启用' : '停用'}</dd>
                </div>
                <div>
                  <dt>缺少知识时转接</dt>
                  <dd>{config.publishedSnapshot.handoffOnNoKnowledge ? '启用' : '停用'}</dd>
                </div>
                <div>
                  <dt>负面情绪时转接</dt>
                  <dd>{config.publishedSnapshot.handoffOnNegativeSentiment ? '启用' : '停用'}</dd>
                </div>
                <div>
                  <dt>无法回答时转接</dt>
                  <dd>{config.publishedSnapshot.handoffOnUnableToAnswer ? '启用' : '停用'}</dd>
                </div>
                <div>
                  <dt>转人工关键词</dt>
                  <dd>{config.publishedSnapshot.handoffKeywords.join('、') || '未设置'}</dd>
                </div>
                <div>
                  <dt>广告学习</dt>
                  <dd>
                    {config.publishedSnapshot.adLearningEnabled ? '启用' : '停用'} ·{' '}
                    {config.publishedSnapshot.adMappings?.length ?? 0} 条映射
                  </dd>
                </div>
                <div>
                  <dt>自然语气</dt>
                  <dd>{config.publishedSnapshot.naturalToneEnabled ? '启用' : '停用'}</dd>
                </div>
                <div>
                  <dt>拆分长回复</dt>
                  <dd>{config.publishedSnapshot.splitRepliesEnabled ? '启用' : '停用'}</dd>
                </div>
                <div>
                  <dt>等待合并输入</dt>
                  <dd>
                    {config.publishedSnapshot.replyWaitEnabled !== false
                      ? '启用（2 秒，最多 30 秒）'
                      : '停用'}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="table-muted">
                发布草稿后，运行时配置会显示在这里。未发布的草稿不会影响客户回复。
              </p>
            )}
          </section>

          <section aria-labelledby="ai-channels-title" className="runtime-section">
            <h2 id="ai-channels-title">渠道访问</h2>
            {memberChannels.length ? (
              <div className="member-channel-list">
                {memberChannels.map((channelName) => (
                  <Badge key={channelName} variant="outline">
                    {channelName}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="table-muted">
                尚未授予渠道访问。可以在 <a href="/team">团队成员设置</a> 中配置。
              </p>
            )}
          </section>
        </aside>
      </div>
      <AiOperations
        workspaceId={workspace.id}
        memberId={memberId}
        publishedVersionId={config.publishedVersionId}
        onRestored={load}
      />
    </main>
  )
}

function sameAiDraft(left: AiMemberDraft, right: AiMemberDraft | AiMemberRuntimeSnapshot) {
  return (
    JSON.stringify([
      left.instructions,
      left.responseLanguage,
      left.knowledgeBaseId,
      left.handoffOnCustomerRequest,
      left.handoffOnNoKnowledge,
      left.handoffOnNegativeSentiment,
      left.handoffOnUnableToAnswer,
      left.handoffKeywords,
      left.adLearningEnabled ?? false,
      left.adMappings ?? [],
      left.naturalToneEnabled ?? false,
      left.replyWaitEnabled ?? true,
      left.automaticLanguageEnabled ?? false,
      left.timeZone ?? 'UTC',
      left.splitRepliesEnabled ?? false,
    ]) ===
    JSON.stringify([
      right.instructions,
      right.responseLanguage,
      right.knowledgeBaseId,
      right.handoffOnCustomerRequest,
      right.handoffOnNoKnowledge,
      right.handoffOnNegativeSentiment,
      right.handoffOnUnableToAnswer,
      right.handoffKeywords,
      right.adLearningEnabled ?? false,
      right.adMappings ?? [],
      right.naturalToneEnabled ?? false,
      right.replyWaitEnabled ?? true,
      right.automaticLanguageEnabled ?? false,
      right.timeZone ?? 'UTC',
      right.splitRepliesEnabled ?? false,
    ])
  )
}

function aiDraftFromConfig(config: AiMemberConfig): AiMemberDraft {
  return {
    instructions: config.instructions,
    naturalToneEnabled: config.naturalToneEnabled ?? false,
    replyWaitEnabled: config.replyWaitEnabled ?? true,
    automaticLanguageEnabled: config.automaticLanguageEnabled ?? false,
    timeZone: config.timeZone ?? 'UTC',
    splitRepliesEnabled: config.splitRepliesEnabled ?? false,
    adLearningEnabled: config.adLearningEnabled ?? false,
    adMappings: config.adMappings ?? [],
    responseLanguage: config.responseLanguage,
    knowledgeBaseId: config.knowledgeBaseId,
    handoffOnCustomerRequest: config.handoffOnCustomerRequest,
    handoffOnNoKnowledge: config.handoffOnNoKnowledge,
    handoffOnNegativeSentiment: config.handoffOnNegativeSentiment,
    handoffOnUnableToAnswer: config.handoffOnUnableToAnswer,
    handoffKeywords: config.handoffKeywords,
  }
}

function TeamPage({ workspace }: { workspace: Workspace }) {
  const [team, setTeam] = useState<Team>()
  const [loadError, setLoadError] = useState('')
  const [invite, setInvite] = useState<Invitation>()
  const [inviteCopied, setInviteCopied] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [addAiOpen, setAddAiOpen] = useState(false)
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null)
  const [removingMember, setRemovingMember] = useState<TeamMember | null>(null)
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState('')
  const canManage = workspace.role !== 'AGENT'

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/workspaces/${workspace.id}/team`)
    if (!response.ok) throw await responseError(response)
    setTeam((await response.json()) as Team)
    setLoadError('')
  }, [workspace.id])

  useEffect(() => {
    setLoadError('')
    void refresh().catch((cause) => setLoadError(teamErrorMessage(cause)))
  }, [refresh])

  async function inviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    setBusy('invite')
    setFormError('')
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
      toast.success('邀请链接已创建')
    } catch (cause) {
      setFormError(teamErrorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function createAi(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setBusy('ai')
    setFormError('')
    try {
      await request(`/api/workspaces/${workspace.id}/members`, {
        type: 'AI',
        displayName: data.get('displayName'),
      })
      await refresh()
      setAddAiOpen(false)
      toast.success('AI 成员已添加')
    } catch (cause) {
      setFormError(teamErrorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function saveMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingMember) return
    const member = editingMember
    const data = new FormData(event.currentTarget)
    setBusy(member.id)
    setFormError('')
    try {
      await request(
        `/api/workspaces/${workspace.id}/members/${member.id}`,
        {
          displayName: data.get('displayName'),
          status: String(data.get('status') ?? member.status),
          autoAssignmentEnabled: data.get('autoAssignmentEnabled') === 'on',
          maxActiveConversations: Number(data.get('maxActiveConversations')),
          ...(member.type === 'HUMAN'
            ? {
                ...(member.role !== 'OWNER' ? { role: data.get('role') } : {}),
                available: data.get('available') === 'on',
              }
            : {}),
          channelIds: data.getAll('channelId').map(String),
        },
        'PATCH',
      )
      await refresh()
      setEditingMember(null)
      toast.success('成员设置已保存')
    } catch (cause) {
      setFormError(teamErrorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function updateMember(
    member: TeamMember,
    update: { autoAssignmentEnabled: boolean } | { available: boolean },
  ) {
    setBusy(member.id)
    setLoadError('')
    try {
      await request(`/api/workspaces/${workspace.id}/members/${member.id}`, update, 'PATCH')
      await refresh()
      toast.success('成员设置已更新')
    } catch (cause) {
      toast.error(teamErrorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function removeMember() {
    if (!removingMember) return
    setBusy(removingMember.id)
    setFormError('')
    try {
      await request(`/api/workspaces/${workspace.id}/members/${removingMember.id}`, {}, 'DELETE')
      await refresh()
      setRemovingMember(null)
      toast.success('成员已移除')
    } catch (cause) {
      setFormError(teamErrorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function copyInvite() {
    if (!invite) return
    try {
      await navigator.clipboard.writeText(invite.url)
      setInviteCopied(true)
      toast.success('邀请链接已复制')
    } catch {
      setFormError('无法访问剪贴板，请手动复制邀请链接。')
    }
  }

  function openInviteDialog() {
    setInvite(undefined)
    setFormError('')
    setInviteOpen(true)
  }

  function openMemberEditor(member: TeamMember) {
    setFormError('')
    setEditingMember(member)
  }

  const headerActions = canManage ? (
    <>
      <Button variant="outline" onClick={() => setAddAiOpen(true)}>
        添加 AI 成员
      </Button>
      <Button onClick={openInviteDialog}>邀请成员</Button>
    </>
  ) : null

  return (
    <main className="workspace-page team-page">
      <PageHeader
        actions={headerActions}
        description="管理可以处理 Messenger 对话的成员、分配能力与渠道访问。"
        eyebrow="工作区成员"
        title="团队"
      />
      {loadError && (
        <div className="page-error" role="alert">
          <p>{loadError}</p>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            重试
          </Button>
        </div>
      )}
      {!team ? (
        loadError ? null : (
          <OperationalListSkeleton />
        )
      ) : (
        <section aria-labelledby="members-title">
          <div className="list-heading">
            <h2 id="members-title">成员</h2>
            <span>{team.members.length} 位</span>
          </div>
          {team.members.length ? (
            <Table aria-labelledby="members-title" className="ops-table team-table">
              <TableHeader>
                <TableRow>
                  <TableHead>成员</TableHead>
                  <TableHead>分配设置</TableHead>
                  <TableHead>渠道访问</TableHead>
                  {canManage && <TableHead className="actions-column">操作</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {team.members.map((member) => {
                  const name = member.displayName ?? '未命名成员'
                  const memberChannels = team.channels
                    .filter((channel) => member.channelIds.includes(channel.id))
                    .map(({ displayName }) => displayName)

                  return (
                    <TableRow className="member-row" data-member-id={member.id} key={member.id}>
                      <TableCell data-column="member" data-label="成员">
                        <div className="member-identity">
                          <Avatar size="sm">
                            <AvatarFallback>{nameInitial(name, '成')}</AvatarFallback>
                          </Avatar>
                          <div className="member-identity-copy">
                            <div className="member-identity-line">
                              <strong>{name}</strong>
                              <Badge variant="outline">
                                {member.type === 'AI' ? 'AI 成员' : '人工成员'}
                              </Badge>
                              <StateBadge
                                status={member.status}
                                label={lifecycleLabels[member.status]}
                              />
                            </div>
                            <div className="member-meta">
                              {member.email && <span>{member.email}</span>}
                              {member.role && <span>{roleLabel(member.role)}</span>}
                              {member.type === 'AI' && (
                                <StateBadge
                                  status={member.configurationStatus ?? 'UNPUBLISHED'}
                                  label={
                                    runtimeStatusLabels[member.configurationStatus ?? 'UNPUBLISHED']
                                  }
                                />
                              )}
                            </div>
                            {member.role === 'OWNER' && (
                              <span className="member-protection-note">所有者不可停用或移除</span>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell data-column="routing" data-label="分配设置">
                        <div className="member-routing">
                          <div className="member-switch-row">
                            <span>自动分配</span>
                            <Switch
                              aria-label={`${name} 自动分配`}
                              checked={member.autoAssignmentEnabled}
                              disabled={!canManage || Boolean(busy)}
                              onCheckedChange={(checked) =>
                                void updateMember(member, { autoAssignmentEnabled: checked })
                              }
                            />
                          </div>
                          {member.type === 'HUMAN' && (
                            <div className="member-switch-row">
                              <span>{member.availability ? '当前可用' : '当前不可用'}</span>
                              <Switch
                                aria-label={`${name} 当前可用`}
                                checked={member.availability ?? false}
                                disabled={!canManage || Boolean(busy)}
                                onCheckedChange={(checked) =>
                                  void updateMember(member, { available: checked })
                                }
                              />
                            </div>
                          )}
                          <span className="member-capacity">
                            最多 {member.maxActiveConversations} 段进行中对话
                          </span>
                        </div>
                      </TableCell>
                      <TableCell data-column="channels" data-label="渠道访问">
                        {memberChannels.length ? (
                          <div className="member-channel-list">
                            {memberChannels.map((channelName) => (
                              <span key={channelName}>{channelName}</span>
                            ))}
                          </div>
                        ) : (
                          <span className="table-muted">未授权渠道</span>
                        )}
                      </TableCell>
                      {canManage && (
                        <TableCell data-column="actions" data-label="操作">
                          <div className="row-actions">
                            <DropdownMenu>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      aria-label={`${name} 的更多操作`}
                                      size="icon-sm"
                                      variant="ghost"
                                    >
                                      <MoreHorizontal aria-hidden="true" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                </TooltipTrigger>
                                <TooltipContent>更多成员操作</TooltipContent>
                              </Tooltip>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => openMemberEditor(member)}>
                                  编辑成员设置
                                </DropdownMenuItem>
                                {member.type === 'AI' && (
                                  <DropdownMenuItem
                                    onSelect={() =>
                                      window.location.assign(`/ai-member/${member.id}`)
                                    }
                                  >
                                    配置 AI 成员
                                  </DropdownMenuItem>
                                )}
                                {member.role !== 'OWNER' && (
                                  <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      className="text-destructive"
                                      onSelect={() => {
                                        setFormError('')
                                        setRemovingMember(member)
                                      }}
                                    >
                                      移除成员
                                    </DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              action={canManage ? <Button onClick={openInviteDialog}>邀请成员</Button> : undefined}
              description="邀请人工客服，或添加 AI 成员来处理 Messenger 对话。"
              title="还没有团队成员"
            />
          )}
        </section>
      )}

      <Dialog
        open={inviteOpen}
        onOpenChange={(open) => {
          setInviteOpen(open)
          if (!open) setInvite(undefined)
        }}
      >
        <DialogContent className="ui-dialog-content">
          {invite ? (
            <>
              <DialogHeader>
                <DialogTitle>一次性邀请链接</DialogTitle>
                <DialogDescription>
                  邀请已发送给 {invite.email}。请复制链接并分享给受邀成员。
                </DialogDescription>
              </DialogHeader>
              <p className="invite-expiry">
                {roleLabel(invite.role)} · 有效期至{' '}
                <time dateTime={invite.expiresAt} title={formatExactDate(invite.expiresAt)}>
                  {formatDate(invite.expiresAt)}
                </time>
              </p>
              <div className="form-field">
                <label className="form-field-label" htmlFor="invite-url">
                  邀请链接
                </label>
                <Input id="invite-url" readOnly value={invite.url} />
              </div>
              {formError && (
                <p className="inline-error" role="alert">
                  {formError}
                </p>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => void copyInvite()}>
                  <Copy aria-hidden="true" />
                  {inviteCopied ? '已复制' : '复制链接'}
                </Button>
                <Button onClick={() => setInviteOpen(false)}>完成</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>邀请团队成员</DialogTitle>
                <DialogDescription>
                  创建一个仅可使用一次、24 小时后过期的邀请链接。
                </DialogDescription>
              </DialogHeader>
              <form className="dialog-form" onSubmit={inviteMember}>
                <Field label="工作邮箱" name="email" type="email" autoComplete="email" />
                <Field label="显示名称" name="displayName" autoComplete="name" required={false} />
                <div className="form-field">
                  <span className="form-field-label" id="invite-role-label">
                    工作区角色
                  </span>
                  <Select defaultValue="AGENT" name="role">
                    <SelectTrigger aria-labelledby="invite-role-label">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="AGENT">客服</SelectItem>
                      <SelectItem value="ADMIN">管理员</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Field
                  label="最大并行对话数"
                  name="maxActiveConversations"
                  type="number"
                  min="0"
                  max="10000"
                  defaultValue="10"
                />
                <div className="switch-field">
                  <span>自动分配</span>
                  <Switch aria-label="自动分配" defaultChecked name="autoAssignmentEnabled" />
                </div>
                <div className="switch-field">
                  <span>当前可用</span>
                  <Switch aria-label="当前可用" defaultChecked name="available" />
                </div>
                <fieldset className="selection-group">
                  <legend>渠道访问</legend>
                  {team?.channels.length ? (
                    team.channels.map((channel) => (
                      <div className="selection-option" key={channel.id}>
                        <Checkbox
                          aria-label={channel.displayName}
                          name="channelId"
                          value={channel.id}
                        />
                        <span>{channel.displayName}</span>
                      </div>
                    ))
                  ) : (
                    <p className="field-description">
                      尚未连接 Facebook Page。可以稍后在成员设置中配置渠道访问。
                    </p>
                  )}
                </fieldset>
                {formError && (
                  <p className="inline-error" role="alert">
                    {formError}
                  </p>
                )}
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setInviteOpen(false)}>
                    取消
                  </Button>
                  <Button disabled={busy === 'invite'} type="submit">
                    {busy === 'invite' ? '正在创建…' : '创建邀请链接'}
                  </Button>
                </DialogFooter>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={addAiOpen}
        onOpenChange={(open) => {
          setAddAiOpen(open)
          if (!open) setFormError('')
        }}
      >
        <DialogContent className="ui-dialog-content">
          <DialogHeader>
            <DialogTitle>添加 AI 成员</DialogTitle>
            <DialogDescription>
              先创建 AI 成员，再配置渠道访问和草稿。AI 不需要登录账户。
            </DialogDescription>
          </DialogHeader>
          <form className="dialog-form" onSubmit={createAi}>
            <Field label="显示名称" name="displayName" autoComplete="off" />
            {formError && (
              <p className="inline-error" role="alert">
                {formError}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddAiOpen(false)}>
                取消
              </Button>
              <Button disabled={busy === 'ai'} type="submit">
                {busy === 'ai' ? '正在添加…' : '添加 AI 成员'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(editingMember)}
        onOpenChange={(open) => {
          if (!open && !busy) setEditingMember(null)
        }}
      >
        {editingMember && (
          <DialogContent className="ui-dialog-content ui-dialog-wide">
            <DialogHeader>
              <DialogTitle>编辑成员设置</DialogTitle>
              <DialogDescription>
                {editingMember.displayName ?? '未命名成员'} 的成员状态、分配能力和渠道访问。
              </DialogDescription>
            </DialogHeader>
            <form className="dialog-form" key={editingMember.id} onSubmit={saveMember}>
              <Field
                label="显示名称"
                name="displayName"
                defaultValue={editingMember.displayName ?? ''}
              />
              <div className="form-grid-two">
                <div className="form-field">
                  <span className="form-field-label" id="member-lifecycle-label">
                    成员状态
                  </span>
                  <Select defaultValue={editingMember.status} name="status">
                    <SelectTrigger
                      aria-labelledby="member-lifecycle-label"
                      disabled={editingMember.role === 'OWNER'}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ACTIVE">启用</SelectItem>
                      <SelectItem value="DISABLED">停用</SelectItem>
                    </SelectContent>
                  </Select>
                  {editingMember.role === 'OWNER' && (
                    <span className="field-description">所有者成员不能停用。</span>
                  )}
                </div>
                {editingMember.type === 'HUMAN' && editingMember.role !== 'OWNER' && (
                  <div className="form-field">
                    <span className="form-field-label" id="member-role-label">
                      工作区角色
                    </span>
                    <Select defaultValue={editingMember.role ?? 'AGENT'} name="role">
                      <SelectTrigger aria-labelledby="member-role-label">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="AGENT">客服</SelectItem>
                        <SelectItem value="ADMIN">管理员</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              <Field
                label="最大并行对话数"
                name="maxActiveConversations"
                type="number"
                min="0"
                max="10000"
                defaultValue={editingMember.maxActiveConversations}
              />
              <div className="form-grid-two">
                <div className="switch-field">
                  <span>自动分配</span>
                  <Switch
                    aria-label="自动分配"
                    defaultChecked={editingMember.autoAssignmentEnabled}
                    name="autoAssignmentEnabled"
                  />
                </div>
                {editingMember.type === 'HUMAN' && (
                  <div className="switch-field">
                    <span>当前可用</span>
                    <Switch
                      aria-label="当前可用"
                      defaultChecked={editingMember.availability ?? false}
                      name="available"
                    />
                  </div>
                )}
              </div>
              <fieldset className="selection-group">
                <legend>渠道访问</legend>
                {team?.channels.length ? (
                  team.channels.map((channel) => (
                    <div className="selection-option" key={channel.id}>
                      <Checkbox
                        aria-label={channel.displayName}
                        defaultChecked={editingMember.channelIds.includes(channel.id)}
                        name="channelId"
                        value={channel.id}
                      />
                      <span>{channel.displayName}</span>
                    </div>
                  ))
                ) : (
                  <p className="field-description">尚未连接 Facebook Page。</p>
                )}
              </fieldset>
              {formError && (
                <p className="inline-error" role="alert">
                  {formError}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditingMember(null)}>
                  取消
                </Button>
                <Button disabled={busy === editingMember.id} type="submit">
                  {busy === editingMember.id ? '正在保存…' : '保存更改'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>

      <ConfirmActionDialog
        busy={Boolean(removingMember && busy === removingMember.id)}
        busyLabel="正在移除…"
        confirmLabel="移除成员"
        description={
          removingMember?.type === 'HUMAN'
            ? `移除“${removingMember.displayName ?? '该成员'}”会删除其成员设置，并撤销该用户的工作区访问。此操作无法撤销。`
            : `移除“${removingMember?.displayName ?? '该成员'}”会永久删除其成员设置。此操作无法撤销。`
        }
        error={formError}
        onConfirm={removeMember}
        onOpenChange={(open) => {
          if (!open) setRemovingMember(null)
        }}
        open={Boolean(removingMember)}
        title="移除此成员？"
      />
    </main>
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
  return new ApiError(payload.error?.code ?? 'REQUEST_FAILED', payload.error?.message)
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
      WORKSPACE_SETUP_REQUIRED: '此账号没有创建工作区的授权。',
      WORKSPACE_ALREADY_EXISTS: '此账号已经属于一个工作区。',
    }[cause.code] ?? '工作区创建失败'
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

function aiMemberErrorMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'AI 成员配置加载失败，请稍后重试。'
  return (
    {
      FORBIDDEN: '你没有管理 AI 成员配置的权限。',
      NOT_FOUND: '该 AI 成员不存在。',
      INVALID_REQUEST: '请检查配置内容后重试。',
      INVALID_CONFIGURATION:
        '配置不完整，无法发布。请检查渠道、知识库、指令、回复语言和 AI 服务配置。',
    }[cause.code] ?? 'AI 成员配置操作失败，请稍后重试。'
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

function inboxErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError && cause.message === 'Filter references need repair')
    return '筛选条件引用的标签、成员、客户或属性已失效，请打开筛选面板修复。'
  if (cause instanceof ApiError && cause.code === 'TRANSFER_CONFIRMATION_REQUIRED') {
    return '目标成员暂不可用，请确认是否继续转接。'
  }
  if (cause instanceof ApiError && cause.code === 'INVALID_TARGET') {
    return '请选择有效的人工成员。'
  }
  if (!(cause instanceof ApiError)) return '收件箱加载失败，请稍后重试。'
  if (cause.code === 'FORBIDDEN' && cause.message === 'Channel access is required') {
    return '请到“团队”页面，为你的成员勾选此 Facebook Page 的频道权限。'
  }
  return (
    {
      FORBIDDEN: '你没有查看此工作区收件箱的权限。',
      NOT_FOUND: '该对话已不存在。',
      INVALID_REQUEST: '收件箱请求无效，请刷新后重试。',
      ALREADY_ASSIGNED: '该对话已被其他成员接管。',
      CONVERSATION_CLOSED: '该对话已关闭。',
      REPLY_WINDOW_CLOSED: 'Messenger 回复窗口已关闭。',
      RETRY_NOT_READY: '重试间隔至少为首次 30 秒、再次 120 秒；渠道要求更长时请继续等待。',
      RETRY_LIMIT_REACHED: '该消息已用完两次重试机会，请检查渠道配置。',
    }[cause.code] ?? '收件箱加载失败，请稍后重试。'
  )
}

function knowledgeErrorMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) return '知识库加载失败，请稍后重试。'
  return (
    {
      FORBIDDEN: '你没有管理此知识库的权限。',
      NOT_FOUND: '知识库或文档不存在。',
      INVALID_REQUEST: '请检查知识库或文档内容后重试。',
      CONFLICT:
        '问答存在冲突：相同问题已有不同答案，或问答已被其他人修改。草稿已保留；请关闭后重新打开最新问答进行编辑。',
      RATE_LIMITED: '操作过于频繁，请稍后重试。',
      UNSUPPORTED_FILE_TYPE: '请上传 PDF、DOCX、TXT 或 Markdown 文件。',
      STORAGE_UNAVAILABLE: '文件存储暂时不可用，请稍后再试。',
    }[cause.code] ?? '知识库操作失败，请稍后重试。'
  )
}

const compactTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
})
const compactDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  day: 'numeric',
  month: 'short',
})
const exactDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  month: '2-digit',
  second: '2-digit',
  year: 'numeric',
})

function formatDate(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '未知时间'
  const now = new Date()
  const time = compactTimeFormatter.format(date)
  if (date.toDateString() === now.toDateString()) return time
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`
  const day = compactDateFormatter.format(date)
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${time}`
    : `${date.getFullYear()}年${day} ${time}`
}

function formatExactDate(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? exactDateFormatter.format(date) : value
}

function inviteToken() {
  const params = new URLSearchParams(window.location.search)
  if (window.location.pathname === '/invite') return params.get('token')
  if (['/sign-up', '/signup', '/register'].includes(window.location.pathname)) {
    return params.get('invite') ?? params.get('token')
  }
  return null
}

const root = document.getElementById('root')
if (!root) throw new Error('Application root is missing')

createRoot(root).render(
  <StrictMode>
    <TooltipProvider>
      <Toaster />
      <App />
    </TooltipProvider>
  </StrictMode>,
)
