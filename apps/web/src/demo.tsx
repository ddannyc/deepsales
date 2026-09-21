import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleHelp,
  Inbox,
  MessageCircle,
  Send,
  Sparkles,
  UserRound,
  X,
} from 'lucide-react'
import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Avatar, AvatarFallback } from '#components/ui/avatar'
import { Badge } from '#components/ui/badge'
import { Button } from '#components/ui/button'
import {
  type DemoConversation,
  type DemoConversationId,
  type DemoMessage,
  demoFixtures,
} from './demo-data'

export type DemoLocale = 'zh' | 'en'

type DemoCopy = {
  htmlLang: string
  title: string
  description: string
  header: {
    experience: string
    sample: string
    reset: string
    freeTrial: string
    switchLanguage: string
  }
  notice: string
  noticeCta: string
  workspace: {
    live: string
    inbox: string
    allOpen: string
    unassigned: string
    aiHandling: string
    waitingHuman: string
    assigned: string
    team: string
    page: string
    conversations: string
    memberRoles: { support: string; sales: string; ai: string }
  }
  thread: {
    conversation: string
    open: string
    today: string
    facebookMessenger: string
    system: string
    aiCustomerService: string
    handoffSystem: string
    you: string
    details: string
    back: string
    aiWorking: string
    handoffReason: string
    handoffExplanation: string
    takeover: string
    takenOver: string
    takeoverNotice: string
    composerLocked: string
    placeholder: string
    send: string
    simulated: string
    suggestion: string
    suggestionLoading: string
    useSuggestion: string
    suggestionText: string
  }
  context: {
    title: string
    customer: string
    assignee: string
    unassigned: string
    you: string
    aiContext: string
    knowledgeUsed: string
    knowledge: string[]
    canHandle: string
    canHandleItems: string[]
    handsOff: string
    handsOffItems: string[]
    close: string
  }
  checklist: {
    title: string
    ai: string
    handoff: string
    takeover: string
    suggestion: string
    complete: string
    cta: string
  }
  tour: Array<{ title: string; description: string; action: string }>
  tourSkip: string
  tourStep: string
}

const demoCopy: Record<DemoLocale, DemoCopy> = {
  zh: {
    htmlLang: 'zh-CN',
    title: 'DeepSales — 在线体验',
    description: '体验 DeepSales 如何集中处理 Facebook 客户消息，让 AI 先回答，复杂问题转交团队。',
    header: {
      experience: '在线体验',
      sample: '示例工作区 · 所有数据均为虚构',
      reset: '重新开始',
      freeTrial: '仅限邀请',
      switchLanguage: 'English',
    },
    notice: '这是一个使用虚构数据的产品演示，不会发送真实 Facebook 消息。',
    noticeCta: '仅限邀请 →',
    workspace: {
      live: '在线演示',
      inbox: '收件箱',
      allOpen: '全部待处理',
      unassigned: '未分配',
      aiHandling: 'AI 处理中',
      waitingHuman: '等待人工',
      assigned: '已分配',
      team: '团队成员',
      page: 'Facebook Page',
      conversations: '个会话',
      memberRoles: { support: '客服', sales: '销售', ai: 'AI 客服' },
    },
    thread: {
      conversation: '会话',
      open: '进行中',
      today: '今天',
      facebookMessenger: 'Facebook Messenger',
      system: '系统',
      aiCustomerService: 'AI 客服',
      handoffSystem: 'Nova 已将该会话转交给人工处理。',
      you: '你',
      details: '客户详情',
      back: '返回收件箱',
      aiWorking: 'Nova 正在根据业务知识自动处理这条会话。',
      handoffReason: '转人工原因',
      handoffExplanation: '订单状态需要团队成员查看具体订单信息。',
      takeover: '接管会话',
      takenOver: '你',
      takeoverNotice: '你已从 Nova 接管该会话。',
      composerLocked: '接管会话后，你可以直接回复客户。',
      placeholder: '输入回复…',
      send: '发送',
      simulated: '演示模式 · 消息未真实发送',
      suggestion: 'AI 生成回复',
      suggestionLoading: 'AI 正在生成建议...',
      useSuggestion: '使用回复',
      suggestionText:
        'Thanks for checking in. I’ll look into your order status and get back to you shortly.',
    },
    context: {
      title: 'AI 上下文',
      customer: '客户',
      assignee: '负责人',
      unassigned: '未分配',
      you: '你',
      aiContext: 'AI 上下文',
      knowledgeUsed: '使用的知识',
      knowledge: ['商品常见问题', '商品规格', '配送政策'],
      canHandle: 'Nova 可以处理',
      canHandleItems: ['商品咨询', '配送规则', '退换货政策'],
      handsOff: '自动转人工',
      handsOffItems: ['订单状态', '特殊折扣', '复杂投诉'],
      close: '关闭客户详情',
    },
    checklist: {
      title: '体验 DeepSales',
      ai: '查看 AI 自动回复',
      handoff: '查看 AI 转人工',
      takeover: '接管客户会话',
      suggestion: '生成一条 AI 回复',
      complete: '你已经体验了 DeepSales 的核心流程。',
      cta: '仅限邀请 →',
    },
    tour: [
      {
        title: '所有客户消息集中处理',
        description: '团队成员在同一个工作台查看和处理 Facebook 客户咨询。',
        action: '下一步',
      },
      {
        title: 'AI 客服先处理重复问题',
        description: 'Nova 可以根据业务知识自动回答商品、物流和退换货等常见问题。',
        action: '下一步',
      },
      {
        title: '复杂问题自动转人工',
        description: 'AI 无法安全处理时，会把会话交给团队成员。',
        action: '开始体验',
      },
    ],
    tourSkip: '跳过',
    tourStep: '步骤',
  },
  en: {
    htmlLang: 'en',
    title: 'DeepSales — Interactive demo',
    description: 'See how DeepSales brings Facebook customer messages, AI, and your team together.',
    header: {
      experience: 'Interactive demo',
      sample: 'Sample workspace · All data is fictional',
      reset: 'Restart',
      freeTrial: 'Private Beta',
      switchLanguage: '中文',
    },
    notice: 'This is a fictional product demo. No real Facebook messages will be sent.',
    noticeCta: 'Private Beta →',
    workspace: {
      live: 'Live demo',
      inbox: 'Inbox',
      allOpen: 'All open',
      unassigned: 'Unassigned',
      aiHandling: 'AI handling',
      waitingHuman: 'Waiting for human',
      assigned: 'Assigned',
      team: 'Team',
      page: 'Facebook Page',
      conversations: 'conversations',
      memberRoles: { support: 'Support', sales: 'Sales', ai: 'AI customer service' },
    },
    thread: {
      conversation: 'Conversation',
      open: 'Open',
      today: 'Today',
      facebookMessenger: 'Facebook Messenger',
      system: 'System',
      aiCustomerService: 'AI customer service',
      handoffSystem: 'Nova handed this conversation to a team member.',
      you: 'You',
      details: 'Customer details',
      back: 'Back to inbox',
      aiWorking: 'Nova is handling this conversation using the team knowledge base.',
      handoffReason: 'Why it was handed off',
      handoffExplanation: 'A team member needs to check the customer’s specific order details.',
      takeover: 'Take over',
      takenOver: 'You',
      takeoverNotice: 'You took over this conversation from Nova.',
      composerLocked: 'Take over the conversation to reply directly to the customer.',
      placeholder: 'Write a reply…',
      send: 'Send',
      simulated: 'Demo mode · Message was not actually sent',
      suggestion: 'AI generate reply',
      suggestionLoading: 'AI is generating a suggestion...',
      useSuggestion: 'Use reply',
      suggestionText:
        'Thanks for checking in. I’ll look into your order status and get back to you shortly.',
    },
    context: {
      title: 'AI context',
      customer: 'Customer',
      assignee: 'Assignee',
      unassigned: 'Unassigned',
      you: 'You',
      aiContext: 'AI context',
      knowledgeUsed: 'Knowledge used',
      knowledge: ['Product FAQ', 'Product specifications', 'Shipping policy'],
      canHandle: 'Nova can handle',
      canHandleItems: ['Product questions', 'Shipping rules', 'Returns policy'],
      handsOff: 'Automatically hands off',
      handsOffItems: ['Order status', 'Special discounts', 'Complex complaints'],
      close: 'Close customer details',
    },
    checklist: {
      title: 'Try DeepSales',
      ai: 'View an AI reply',
      handoff: 'View an AI handoff',
      takeover: 'Take over a customer conversation',
      suggestion: 'Generate an AI reply',
      complete: 'You have experienced the core DeepSales flow.',
      cta: 'Private Beta →',
    },
    tour: [
      {
        title: 'Every customer message in one place',
        description:
          'Your team can view and handle Facebook customer questions from the same workspace.',
        action: 'Next',
      },
      {
        title: 'AI handles repetitive questions first',
        description:
          'Nova uses your business knowledge to answer common product, shipping, and returns questions.',
        action: 'Next',
      },
      {
        title: 'Complex questions go to a human',
        description:
          'When AI cannot safely continue, the conversation is handed back to your team.',
        action: 'Start exploring',
      },
    ],
    tourSkip: 'Skip',
    tourStep: 'Step',
  },
}

type DemoState = {
  selectedId: DemoConversationId
  takenOver: boolean
  sentMessage: string
  draft: string
  suggestion: string
  generatingSuggestion: boolean
  demoNotice: boolean
  tourStep: number | null
  checklist: { handoff: boolean; takeover: boolean; suggestion: boolean }
}

function createInitialDemoState(): DemoState {
  return {
    selectedId: 'emily',
    takenOver: false,
    sentMessage: '',
    draft: '',
    suggestion: '',
    generatingSuggestion: false,
    demoNotice: false,
    tourStep: 0,
    checklist: { handoff: false, takeover: false, suggestion: false },
  }
}

function DemoHeader({
  locale,
  copy,
  onReset,
}: {
  locale: DemoLocale
  copy: DemoCopy
  onReset: () => void
}) {
  return (
    <header className="demo-header">
      <a className="demo-brand" href={locale === 'zh' ? '/' : '/en'}>
        <span className="demo-brand-mark" aria-hidden="true">
          DS
        </span>
        <span>
          <strong>DeepSales</strong>
          <small>{copy.header.experience}</small>
        </span>
      </a>
      <span className="demo-header-sample">{copy.header.sample}</span>
      <div className="demo-header-actions">
        <a className="demo-language-link" href={locale === 'zh' ? '/en/demo' : '/demo'}>
          {copy.header.switchLanguage}
        </a>
        <Button variant="ghost" size="sm" onClick={onReset}>
          {copy.header.reset}
        </Button>
        <Button asChild size="sm">
          <a href="/login">{copy.header.freeTrial}</a>
        </Button>
      </div>
    </header>
  )
}

function DemoNotice({ copy }: { copy: DemoCopy }) {
  return (
    <div className="demo-notice" role="note">
      <span>{copy.notice}</span>
      <a href="/login">{copy.noticeCta}</a>
    </div>
  )
}

function DemoSidebar({ copy, tourStep }: { copy: DemoCopy; tourStep: number | null }) {
  return (
    <aside
      className={`demo-sidebar ${tourStep === 0 ? 'demo-tour-target' : ''}`}
      aria-label={copy.workspace.inbox}
    >
      <div className="demo-sidebar-workspace">
        <span className="demo-sidebar-kicker">{copy.workspace.page}</span>
        <strong>{demoFixtures.workspace}</strong>
        <span>{demoFixtures.page}</span>
      </div>
      <div className="demo-team-strip">
        <span className="demo-sidebar-kicker">{copy.workspace.team}</span>
        <div>
          {demoFixtures.members.map((member) => (
            <span className="demo-team-member" key={member.name}>
              <Avatar size="sm">
                <AvatarFallback>{member.initials}</AvatarFallback>
              </Avatar>
              <span className="demo-team-member-copy">
                <strong>{member.name}</strong>
                <small>
                  {
                    copy.workspace.memberRoles[
                      member.role as keyof typeof copy.workspace.memberRoles
                    ]
                  }
                </small>
              </span>
            </span>
          ))}
        </div>
      </div>
      <nav className="demo-inbox-nav" aria-label={copy.workspace.inbox}>
        <button className="demo-inbox-nav-item selected" type="button">
          <Inbox aria-hidden="true" />
          <span>{copy.workspace.inbox}</span>
        </button>
        <button className="demo-inbox-nav-item" type="button">
          <span className="demo-nav-dot" aria-hidden="true" />
          <span>{copy.workspace.allOpen}</span>
          <small>2</small>
        </button>
        <button className="demo-inbox-nav-item" type="button">
          <span className="demo-nav-dot demo-nav-dot-warning" aria-hidden="true" />
          <span>{copy.workspace.unassigned}</span>
          <small>1</small>
        </button>
        <button className="demo-inbox-nav-item" type="button">
          <Sparkles aria-hidden="true" />
          <span>{copy.workspace.aiHandling}</span>
          <small>1</small>
        </button>
        <button className="demo-inbox-nav-item" type="button">
          <UserRound aria-hidden="true" />
          <span>{copy.workspace.waitingHuman}</span>
          <small>1</small>
        </button>
      </nav>
    </aside>
  )
}

function ConversationList({
  copy,
  selectedId,
  tourStep,
  onSelect,
}: {
  copy: DemoCopy
  selectedId: DemoConversationId
  tourStep: number | null
  onSelect: (id: DemoConversationId) => void
}) {
  return (
    <section className="demo-conversation-list" aria-label={copy.workspace.inbox}>
      <div className="demo-list-heading">
        <div>
          <span className="demo-sidebar-kicker">{demoFixtures.workspace}</span>
          <h1>{copy.workspace.inbox}</h1>
        </div>
        <span className="demo-list-count">2</span>
      </div>
      <div className="demo-list-filter">
        <span>{copy.workspace.allOpen}</span>
        <span>2 {copy.workspace.conversations}</span>
      </div>
      <div className="demo-conversation-items">
        {demoFixtures.conversations.map((conversation) => {
          const selected = selectedId === conversation.id
          const highlight =
            (tourStep === 1 && conversation.id === 'emily') ||
            (tourStep === 2 && conversation.id === 'lucas')
          return (
            <button
              className={`demo-conversation-item ${selected ? 'selected' : ''} ${highlight ? 'demo-tour-target' : ''}`}
              data-conversation-id={conversation.id}
              key={conversation.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(conversation.id)}
            >
              <Avatar>
                <AvatarFallback>{conversation.initials}</AvatarFallback>
              </Avatar>
              <span className="demo-conversation-copy">
                <span className="demo-conversation-topline">
                  <strong>{conversation.name}</strong>
                  <time>{conversation.time}</time>
                </span>
                <span className="demo-conversation-preview">{conversation.preview}</span>
                <span className={`demo-status demo-status-${conversation.status}`}>
                  <span aria-hidden="true" />
                  {conversation.status === 'ai'
                    ? copy.workspace.aiHandling
                    : copy.workspace.waitingHuman}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

type RenderedMessage = Omit<DemoMessage, 'sender'> & { sender: DemoMessage['sender'] | 'you' }

function MessageBubble({
  message,
  copy,
  customerName,
}: {
  message: RenderedMessage
  copy: DemoCopy
  customerName: string
}) {
  const senderLabel =
    message.sender === 'ai'
      ? 'Nova'
      : message.sender === 'you'
        ? copy.thread.you
        : message.sender === 'customer'
          ? customerName
          : copy.thread.system
  if (message.sender === 'system') {
    return (
      <div className="demo-system-message" role="status">
        <CircleHelp aria-hidden="true" />
        <strong>{copy.thread.system}</strong>
        <span>
          {message.id === 'lucas-system-handoff' ? copy.thread.handoffSystem : message.text}
        </span>
      </div>
    )
  }
  return (
    <article className={`demo-message demo-message-${message.sender}`}>
      <div className="demo-message-meta">
        <strong>
          {message.sender === 'ai' && <Sparkles aria-hidden="true" />}
          {message.sender === 'you' && <UserRound aria-hidden="true" />}
          {senderLabel}
        </strong>
        {message.sender === 'ai' && (
          <Badge variant="outline">{copy.thread.aiCustomerService}</Badge>
        )}
        <time>{message.time}</time>
      </div>
      <p>{message.text}</p>
    </article>
  )
}

function ConversationThread({
  copy,
  conversation,
  state,
  onBack,
  onTakeover,
  onGenerateSuggestion,
  onUseSuggestion,
  onDraftChange,
  onSend,
  onOpenContext,
}: {
  copy: DemoCopy
  conversation: DemoConversation
  state: DemoState
  onBack: () => void
  onTakeover: () => void
  onGenerateSuggestion: () => void
  onUseSuggestion: () => void
  onDraftChange: (value: string) => void
  onSend: (event: FormEvent<HTMLFormElement>) => void
  onOpenContext: () => void
}) {
  const messages: RenderedMessage[] = [...conversation.messages]
  if (conversation.id === 'lucas' && state.takenOver) {
    messages.push({
      id: 'lucas-system-takeover',
      sender: 'system',
      text: copy.thread.takeoverNotice,
      time: '09:37',
    })
  }
  if (conversation.id === 'lucas' && state.sentMessage) {
    messages.push({
      id: 'lucas-you-reply',
      sender: 'you',
      text: state.sentMessage,
      time: '09:38',
    })
  }

  return (
    <section
      className="demo-thread"
      aria-label={`${copy.thread.conversation}: ${conversation.name}`}
    >
      <header className="demo-thread-header">
        <Button className="demo-mobile-back" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          {copy.thread.back}
        </Button>
        <div className="demo-thread-identity">
          <Avatar size="lg">
            <AvatarFallback>{conversation.initials}</AvatarFallback>
          </Avatar>
          <div>
            <strong>{conversation.name}</strong>
            <span>
              <MessageCircle aria-hidden="true" /> {copy.thread.facebookMessenger}
            </span>
          </div>
        </div>
        <div className="demo-thread-actions">
          <span className={`demo-thread-status demo-thread-status-${conversation.status}`}>
            <span aria-hidden="true" />
            {conversation.status === 'ai' ? copy.workspace.aiHandling : copy.workspace.waitingHuman}
          </span>
          {conversation.id === 'lucas' && !state.takenOver && (
            <Button size="sm" onClick={onTakeover}>
              {copy.thread.takeover}
            </Button>
          )}
          <Button
            className="demo-context-toggle"
            variant="outline"
            size="sm"
            onClick={onOpenContext}
          >
            {copy.thread.details}
          </Button>
        </div>
      </header>
      <div className="demo-message-list">
        <div className="demo-date-divider">{copy.thread.today}</div>
        {messages.map((message) => (
          <MessageBubble
            copy={copy}
            customerName={conversation.name}
            key={message.id}
            message={message}
          />
        ))}
      </div>
      {conversation.id === 'emily' ? (
        <div className="demo-composer demo-composer-ai" role="status">
          <Sparkles aria-hidden="true" />
          <span>{copy.thread.aiWorking}</span>
        </div>
      ) : state.takenOver ? (
        <div className="demo-composer-wrap">
          <div className="demo-suggestion-area">
            {state.generatingSuggestion ? (
              <span className="demo-suggestion-loading" role="status">
                <Sparkles aria-hidden="true" />
                {copy.thread.suggestionLoading}
              </span>
            ) : state.suggestion ? (
              <div className="demo-suggestion-card">
                <div>
                  <span className="demo-suggestion-label">
                    <Sparkles aria-hidden="true" />
                    {copy.thread.suggestion}
                  </span>
                  <p>{state.suggestion}</p>
                </div>
                <Button variant="outline" size="sm" onClick={onUseSuggestion}>
                  {copy.thread.useSuggestion}
                </Button>
              </div>
            ) : (
              <Button
                className="demo-suggestion-button"
                variant="outline"
                size="sm"
                onClick={onGenerateSuggestion}
              >
                <Sparkles aria-hidden="true" />
                {copy.thread.suggestion}
              </Button>
            )}
          </div>
          <form className="demo-composer" onSubmit={onSend}>
            <label className="demo-sr-only" htmlFor="demo-reply">
              {copy.thread.placeholder}
            </label>
            <textarea
              id="demo-reply"
              value={state.draft}
              placeholder={copy.thread.placeholder}
              rows={2}
              onChange={(event) => onDraftChange(event.currentTarget.value)}
            />
            <Button type="submit" disabled={!state.draft.trim()}>
              <Send aria-hidden="true" />
              {copy.thread.send}
            </Button>
          </form>
          {state.demoNotice && (
            <p className="demo-simulated-note" role="status">
              {copy.thread.simulated}
            </p>
          )}
        </div>
      ) : (
        <div className="demo-composer demo-composer-locked">
          <span>{copy.thread.composerLocked}</span>
          <UserRound aria-hidden="true" />
        </div>
      )}
    </section>
  )
}

function DemoContext({
  copy,
  conversation,
  takenOver,
  onTakeover,
  open,
  onClose,
}: {
  copy: DemoCopy
  conversation: DemoConversation
  takenOver: boolean
  onTakeover: () => void
  open: boolean
  onClose: () => void
}) {
  const assignee =
    conversation.id === 'emily'
      ? `Nova · ${copy.workspace.memberRoles.ai}`
      : takenOver
        ? copy.context.you
        : copy.context.unassigned
  return (
    <aside className={`demo-context ${open ? 'is-open' : ''}`} aria-label={copy.context.title}>
      <div className="demo-context-header">
        <div>
          <span className="demo-sidebar-kicker">{copy.context.title}</span>
          <strong>{conversation.name}</strong>
        </div>
        <Button
          className="demo-context-close"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={copy.context.close}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="demo-context-customer">
        <Avatar size="lg">
          <AvatarFallback>{conversation.initials}</AvatarFallback>
        </Avatar>
        <strong>{conversation.name}</strong>
        <span>{copy.thread.facebookMessenger}</span>
      </div>
      <dl className="demo-context-details">
        <div>
          <dt>{copy.context.customer}</dt>
          <dd>{conversation.name}</dd>
        </div>
        <div>
          <dt>{copy.context.assignee}</dt>
          <dd className={conversation.id === 'lucas' && !takenOver ? 'is-unassigned' : ''}>
            <span className="demo-assignee-dot" aria-hidden="true" />
            {assignee}
          </dd>
        </div>
      </dl>
      {conversation.id === 'lucas' && !takenOver && (
        <Button className="demo-context-takeover" onClick={onTakeover}>
          {copy.thread.takeover}
          <ChevronRight aria-hidden="true" />
        </Button>
      )}
      {conversation.id === 'emily' ? (
        <div className="demo-ai-context">
          <div className="demo-context-section-heading">
            <Sparkles aria-hidden="true" />
            <strong>{copy.context.aiContext}</strong>
          </div>
          <div className="demo-context-block">
            <span className="demo-context-label">{copy.context.knowledgeUsed}</span>
            {copy.context.knowledge.map((item) => (
              <span className="demo-context-check" key={item}>
                <Check aria-hidden="true" /> {item}
              </span>
            ))}
          </div>
          <div className="demo-context-block">
            <span className="demo-context-label">{copy.context.canHandle}</span>
            {copy.context.canHandleItems.map((item) => (
              <span className="demo-context-tag" key={item}>
                {item}
              </span>
            ))}
          </div>
          <div className="demo-context-block">
            <span className="demo-context-label">{copy.context.handsOff}</span>
            {copy.context.handsOffItems.map((item) => (
              <span className="demo-context-tag is-warning" key={item}>
                {item}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="demo-handoff-context">
          <div className="demo-context-section-heading">
            <CircleHelp aria-hidden="true" />
            <strong>{copy.thread.handoffReason}</strong>
          </div>
          <p>{copy.thread.handoffExplanation}</p>
          <span className="demo-handoff-rule">{copy.context.handsOff}</span>
          <span className="demo-context-tag is-warning">{copy.context.handsOffItems[0]}</span>
        </div>
      )}
    </aside>
  )
}

function DemoChecklist({ copy, state }: { copy: DemoCopy; state: DemoState }) {
  const completed =
    state.checklist.handoff && state.checklist.takeover && state.checklist.suggestion
  const items = [
    [true, copy.checklist.ai],
    [state.checklist.handoff, copy.checklist.handoff],
    [state.checklist.takeover, copy.checklist.takeover],
    [state.checklist.suggestion, copy.checklist.suggestion],
  ] as const
  return (
    <aside
      className={`demo-checklist ${completed ? 'is-complete' : ''}`}
      aria-label={copy.checklist.title}
    >
      <div className="demo-checklist-heading">
        <CircleHelp aria-hidden="true" />
        <strong>{copy.checklist.title}</strong>
      </div>
      <div className="demo-checklist-items">
        {items.map(([done, label]) => (
          <span className={done ? 'is-done' : ''} key={label}>
            <span className="demo-checklist-box" aria-hidden="true">
              {done && <Check />}
            </span>
            {label}
          </span>
        ))}
      </div>
      {completed && (
        <div className="demo-checklist-complete">
          <p>{copy.checklist.complete}</p>
          <a href="/login">{copy.checklist.cta}</a>
        </div>
      )}
    </aside>
  )
}

function DemoTour({
  copy,
  step,
  onNext,
  onSkip,
}: {
  copy: DemoCopy
  step: number
  onNext: () => void
  onSkip: () => void
}) {
  const current = copy.tour[step]
  return (
    <aside className="demo-tour" role="dialog" aria-label={`${copy.tourStep} ${step + 1}`}>
      <div className="demo-tour-meta">
        <span>
          {copy.tourStep} {step + 1}/3
        </span>
        <button type="button" onClick={onSkip}>
          {copy.tourSkip}
        </button>
      </div>
      <strong>{current.title}</strong>
      <p>{current.description}</p>
      <Button size="sm" onClick={onNext}>
        {current.action}
      </Button>
    </aside>
  )
}

export function DemoPage({ locale }: { locale: DemoLocale }) {
  const copy = demoCopy[locale]
  const [state, setState] = useState(createInitialDemoState)
  const [mobileView, setMobileView] = useState<'list' | 'thread'>('list')
  const [contextOpen, setContextOpen] = useState(false)
  const suggestionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const conversation =
    demoFixtures.conversations.find(({ id }) => id === state.selectedId) ??
    demoFixtures.conversations[0]

  useEffect(() => {
    document.documentElement.lang = copy.htmlLang
    document.title = copy.title
    document.querySelector('meta[name="description"]')?.setAttribute('content', copy.description)
    return () => {
      if (suggestionTimer.current) clearTimeout(suggestionTimer.current)
    }
  }, [copy])

  function reset() {
    if (suggestionTimer.current) clearTimeout(suggestionTimer.current)
    setState(createInitialDemoState())
    setMobileView('list')
    setContextOpen(false)
  }

  function selectConversation(id: DemoConversationId) {
    setState((current) => ({
      ...current,
      selectedId: id,
      demoNotice: false,
      checklist: { ...current.checklist, handoff: current.checklist.handoff || id === 'lucas' },
      tourStep: current.tourStep === 2 && id === 'lucas' ? null : current.tourStep,
    }))
    setMobileView('thread')
    setContextOpen(false)
  }

  function takeover() {
    setState((current) => ({
      ...current,
      takenOver: true,
      checklist: { ...current.checklist, takeover: true },
    }))
  }

  function generateSuggestion() {
    if (state.generatingSuggestion) return
    setState((current) => ({
      ...current,
      generatingSuggestion: true,
      suggestion: '',
      checklist: { ...current.checklist, suggestion: true },
    }))
    suggestionTimer.current = setTimeout(() => {
      setState((current) => ({
        ...current,
        generatingSuggestion: false,
        suggestion: copy.thread.suggestionText,
      }))
    }, 650)
  }

  function useSuggestion() {
    setState((current) => ({ ...current, draft: current.suggestion }))
  }

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!state.draft.trim()) return
    setState((current) => ({
      ...current,
      sentMessage: current.draft.trim(),
      draft: '',
      demoNotice: true,
    }))
  }

  const tourNext = () =>
    setState((current) => ({
      ...current,
      tourStep: current.tourStep === 2 ? null : (current.tourStep ?? 0) + 1,
    }))
  const tourSkip = () => setState((current) => ({ ...current, tourStep: null }))
  return (
    <div className="demo-workbench-page">
      <DemoHeader copy={copy} locale={locale} onReset={reset} />
      <DemoNotice copy={copy} />
      <main className="demo-workspace-shell">
        <div className="demo-workspace-bar">
          <div>
            <span className="demo-sidebar-kicker">{copy.workspace.page}</span>
            <strong>{demoFixtures.page}</strong>
          </div>
          <span className="demo-workspace-live">
            <span aria-hidden="true" />
            {copy.workspace.live}
          </span>
        </div>
        <div className="demo-workspace-grid" data-mobile-view={mobileView}>
          <DemoSidebar copy={copy} tourStep={state.tourStep} />
          <ConversationList
            copy={copy}
            selectedId={state.selectedId}
            tourStep={state.tourStep}
            onSelect={selectConversation}
          />
          <ConversationThread
            copy={copy}
            conversation={conversation}
            state={state}
            onBack={() => setMobileView('list')}
            onTakeover={takeover}
            onGenerateSuggestion={generateSuggestion}
            onUseSuggestion={useSuggestion}
            onDraftChange={(draft) => setState((current) => ({ ...current, draft }))}
            onSend={send}
            onOpenContext={() => setContextOpen(true)}
          />
          <DemoContext
            copy={copy}
            conversation={conversation}
            takenOver={state.takenOver}
            onTakeover={takeover}
            open={contextOpen}
            onClose={() => setContextOpen(false)}
          />
        </div>
        {state.tourStep === null && <DemoChecklist copy={copy} state={state} />}
        {state.tourStep !== null && (
          <DemoTour copy={copy} step={state.tourStep} onNext={tourNext} onSkip={tourSkip} />
        )}
      </main>
    </div>
  )
}
