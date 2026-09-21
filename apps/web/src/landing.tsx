import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Inbox,
  Menu,
  MessageCircle,
  Sparkles,
  UsersRound,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Avatar, AvatarFallback } from '#components/ui/avatar'
import { Button } from '#components/ui/button'
import { landingDemoThreads as demoThreads } from './demo-data'

type LandingLocale = 'zh' | 'en'
type LandingProps = { authenticated: boolean; locale: LandingLocale }

type LandingCopy = {
  seo: { htmlLang: string; title: string; description: string }
  nav: {
    mainNavigation: string
    homeLabel: string
    product: string
    howItWorks: string
    demo: string
    openWorkspace: string
    signIn: string
    freeTrial: string
    openNavigation: string
    closeNavigation: string
    language: string
    switchToChinese: string
    switchToEnglish: string
  }
  hero: {
    eyebrow: string
    titleFirst: string
    titleSecond: string
    lead: string
    primaryAction: string
    secondaryAction: string
    note: string
  }
  preview: {
    ariaLabel: string
    chromeTitle: string
    live: string
    inboxListLabel: string
    panelKicker: string
    inbox: string
    allOpen: string
    conversationCount: string
    aiHandling: string
    conversationLabel: string
    facebookMessenger: string
    open: string
    today: string
    aiTeammate: string
    readyToSend: string
    replyTo: string
    contextLabel: string
    context: string
    customerAndAi: string
    facebookCustomer: string
    page: string
    assignee: string
    knowledgeUsed: string
    knowledgeLabels: Record<string, string>
  }
  values: {
    eyebrow: string
    title: string
    copy?: string
    items: Array<{ title: string; copy: string }>
  }
  how: {
    eyebrow: string
    title: string
    copy?: string
    steps: Array<{ title: string; copy?: string }>
    summary: [string, string, string]
  }
  ai: {
    eyebrow: string
    titleFirst: string
    titleSecond: string
    body: string[]
    link: string
    team: string
    members: string
    activeMembers: string
    aiTeammate: string
    online: string
    setup: string
    canAccess: string
    knowledge: string
    knowledgeLabels: string[]
  }
  demo: { eyebrow: string; title: string; copy: string; action: string }
  final: { eyebrow: string; title: string; action: string; note: string }
  footer: {
    tagline: string
    product: string
    demo: string
    signIn: string
    languageLink: string
  }
}

const landingCopy: Record<LandingLocale, LandingCopy> = {
  zh: {
    seo: {
      htmlLang: 'zh-CN',
      title: 'DeepSales — Facebook AI 客服与团队消息工作台',
      description: '集中管理 Facebook Messenger 客户消息，让团队成员和 AI 客服一起处理客户咨询。',
    },
    nav: {
      mainNavigation: '主导航',
      homeLabel: 'DeepSales 首页',
      product: '产品',
      howItWorks: '使用方式',
      demo: '在线体验',
      openWorkspace: '打开工作台',
      signIn: '登录',
      freeTrial: '仅限邀请',
      openNavigation: '打开导航',
      closeNavigation: '关闭导航',
      language: '语言切换',
      switchToChinese: '切换到中文',
      switchToEnglish: '切换到 English',
    },
    hero: {
      eyebrow: 'FACEBOOK MESSENGER · AI 客服工作台',
      titleFirst: 'Facebook 客户消息',
      titleSecond: '一个后台统一处理',
      lead: '集中管理 Facebook Messenger 客户咨询，团队成员协同处理，让 AI 客服自动回答常见问题，复杂问题随时转人工。',
      primaryAction: '仅限邀请',
      secondaryAction: '体验在线 Demo',
      note: '为使用 Facebook 获客的跨境团队而设计',
    },
    preview: {
      ariaLabel: 'DeepSales 收件箱示例',
      chromeTitle: 'DeepSales / 收件箱',
      live: '在线演示',
      inboxListLabel: '收件箱列表',
      panelKicker: '工作区',
      inbox: '收件箱',
      allOpen: '全部打开',
      conversationCount: '3 个对话',
      aiHandling: 'AI 处理中',
      conversationLabel: '对话',
      facebookMessenger: 'Facebook Messenger',
      open: '进行中',
      today: '今天',
      aiTeammate: 'AI 客服',
      readyToSend: '待发送',
      replyTo: '回复',
      contextLabel: '客户与 AI 上下文',
      context: '上下文',
      customerAndAi: '客户与 AI',
      facebookCustomer: 'Facebook 客户',
      page: '主页',
      assignee: '负责人',
      knowledgeUsed: '使用的知识',
      knowledgeLabels: {
        'Product FAQ': '商品常见问题',
        'Shipping policy': '物流政策',
        'Color guide': '颜色指南',
        Returns: '退换货',
        'Human handoff': '人工接管',
      },
    },
    values: {
      eyebrow: 'Facebook 客户消息统一处理',
      title: '客户消息，不该散落在不同人的收件箱里',
      items: [
        {
          title: '统一处理客户消息',
          copy: '所有 Facebook 客户咨询集中到一个后台，团队成员都能看到当前处理进度。',
        },
        {
          title: 'AI 自动回答常见问题',
          copy: '让 AI 客服根据业务知识回答商品、物流、退换货等重复咨询。',
        },
        {
          title: '复杂问题随时转人工',
          copy: 'AI 无法处理时自动交给团队成员，人工也可以随时接管当前对话。',
        },
      ],
    },
    how: {
      eyebrow: '使用方式',
      title: '从 Facebook 消息到客户回复，只需三步',
      steps: [
        { title: '连接 Facebook Page' },
        { title: '邀请团队成员和 AI 客服' },
        { title: '一起处理客户咨询' },
      ],
      summary: ['Facebook Page', 'DeepSales 收件箱', '人工 + AI'],
    },
    ai: {
      eyebrow: 'AI 客服',
      titleFirst: '把 AI 加入你的',
      titleSecond: '客服团队',
      body: [
        '让 AI 客服处理重复咨询，并使用你的业务知识回答客户。',
        '复杂问题交给人工，团队始终掌握最终控制权。',
      ],
      link: '查看收件箱中的效果',
      team: '团队',
      members: '成员',
      activeMembers: '3 位活跃成员',
      aiTeammate: 'AI 客服',
      online: '在线',
      setup: 'Nova 的设置',
      canAccess: '可访问',
      knowledge: '知识',
      knowledgeLabels: ['物流政策', '退换货', '商品常见问题'],
    },
    demo: {
      eyebrow: '虚构工作区',
      title: '连接 Facebook 之前，先体验一下',
      copy: '通过虚构客户数据体验 DeepSales，看看团队成员和 AI 客服如何一起处理客户消息。',
      action: '体验在线 Demo',
    },
    final: {
      eyebrow: '从今天的客户消息开始',
      title: '开始用 DeepSales 处理真实客户消息',
      action: '仅限邀请',
      note: '连接你的第一个 Facebook Page，并邀请团队成员。',
    },
    footer: {
      tagline: '面向跨境团队的 AI 客服工作台',
      product: '产品',
      demo: '在线体验',
      signIn: '登录',
      languageLink: 'English',
    },
  },
  en: {
    seo: {
      htmlLang: 'en',
      title: 'DeepSales — AI-powered shared inbox for customer conversations',
      description:
        'Manage Facebook customer messages with your team and an AI teammate in one shared inbox.',
    },
    nav: {
      mainNavigation: 'Main navigation',
      homeLabel: 'DeepSales home',
      product: 'Product',
      howItWorks: 'How it works',
      demo: 'Demo',
      openWorkspace: 'Open workspace',
      signIn: 'Sign in',
      freeTrial: 'Private Beta',
      openNavigation: 'Open navigation',
      closeNavigation: 'Close navigation',
      language: 'Language',
      switchToChinese: 'Switch to Chinese',
      switchToEnglish: 'Switch to English',
    },
    hero: {
      eyebrow: 'FACEBOOK MESSENGER · SHARED INBOX',
      titleFirst: 'Turn customer messages',
      titleSecond: 'into conversations that sell.',
      lead: 'Bring your Facebook customer messages into one shared inbox, let your team work together, and add an AI teammate that can help answer repetitive questions instantly.',
      primaryAction: 'Private Beta',
      secondaryAction: 'Try the demo',
      note: 'Built for teams managing Facebook Pages.',
    },
    preview: {
      ariaLabel: 'Sample DeepSales inbox',
      chromeTitle: 'DeepSales / Inbox',
      live: 'Live sample',
      inboxListLabel: 'Inbox list',
      panelKicker: 'Workspace',
      inbox: 'Inbox',
      allOpen: 'All open',
      conversationCount: '3 conversations',
      aiHandling: 'AI handling',
      conversationLabel: 'Conversation',
      facebookMessenger: 'Facebook Messenger',
      open: 'Open',
      today: 'Today',
      aiTeammate: 'AI teammate',
      readyToSend: 'Ready to send',
      replyTo: 'Reply to',
      contextLabel: 'Customer and AI context',
      context: 'Context',
      customerAndAi: 'Customer & AI',
      facebookCustomer: 'Facebook customer',
      page: 'Page',
      assignee: 'Assignee',
      knowledgeUsed: 'Knowledge used',
      knowledgeLabels: {
        'Product FAQ': 'Product FAQ',
        'Shipping policy': 'Shipping policy',
        'Color guide': 'Color guide',
        Returns: 'Returns',
        'Human handoff': 'Human handoff',
      },
    },
    values: {
      eyebrow: 'The shared inbox for Facebook messages',
      title: "Customer messages shouldn't disappear inside individual inboxes.",
      copy: 'DeepSales gives your team one place to see, answer, and hand off every customer conversation.',
      items: [
        {
          title: 'One shared inbox',
          copy: 'Your team sees the same customer conversations and always knows who is handling what.',
        },
        {
          title: 'AI as a teammate',
          copy: 'Let AI answer repetitive questions using your business knowledge, while your team stays in control.',
        },
        {
          title: 'Human when it matters',
          copy: 'AI can help with routine messages and hand conversations back to your team whenever human judgment is needed.',
        },
      ],
    },
    how: {
      eyebrow: 'How it works',
      title: 'From Facebook message to answered customer',
      copy: 'A short path from the Page your customers already use to a team response with the right context.',
      steps: [
        {
          title: 'Connect your Facebook Page',
          copy: 'Bring your customer messages into one focused workspace.',
        },
        {
          title: 'Invite your team and AI teammate',
          copy: 'Give the right people and your AI member a clear place to work.',
        },
        {
          title: 'Handle customer conversations together',
          copy: 'Reply faster, stay in context, and hand off when it matters.',
        },
      ],
      summary: ['Facebook Page', 'DeepSales Inbox', 'Human + AI'],
    },
    ai: {
      eyebrow: 'AI Member',
      titleFirst: 'Add an AI teammate,',
      titleSecond: 'not another chatbot.',
      body: [
        'Create an AI member for repetitive customer questions.',
        'Give it business knowledge, control which conversations it can access, and let your team take over whenever needed.',
      ],
      link: 'See it in the inbox',
      team: 'Team',
      members: 'Members',
      activeMembers: '3 active',
      aiTeammate: 'AI teammate',
      online: 'Online',
      setup: "Nova's setup",
      canAccess: 'Can access',
      knowledge: 'Knowledge',
      knowledgeLabels: ['Shipping policy', 'Returns', 'Product FAQ'],
    },
    demo: {
      eyebrow: 'Fictional workspace',
      title: 'See DeepSales before connecting your page.',
      copy: 'Explore a sample inbox with fictional customer conversations and an AI teammate already configured.',
      action: 'Try interactive demo',
    },
    final: {
      eyebrow: 'Start with the conversations you have today',
      title: 'Ready to try DeepSales with real customer messages?',
      action: 'Private Beta',
      note: 'Connect your first Facebook Page and invite your team.',
    },
    footer: {
      tagline: 'AI-powered shared inbox',
      product: 'Product',
      demo: 'Demo',
      signIn: 'Sign in',
      languageLink: '中文',
    },
  },
}

const howItWorksIcons = [MessageCircle, UsersRound, MessageCircle]

function localeHref(locale: LandingLocale) {
  return `${locale === 'zh' ? '/' : '/en'}${window.location.hash}`
}

function updateLandingSeo(locale: LandingLocale) {
  const seo = landingCopy[locale].seo
  document.documentElement.lang = seo.htmlLang
  document.title = seo.title
  document.querySelector('meta[name="description"]')?.setAttribute('content', seo.description)
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', seo.title)
  document
    .querySelector('meta[property="og:description"]')
    ?.setAttribute('content', seo.description)
}

function LocaleSwitch({ locale, copy }: { locale: LandingLocale; copy: LandingCopy }) {
  return (
    <nav className="landing-locale-switch" aria-label={copy.nav.language}>
      <a
        href={localeHref('zh')}
        title={copy.nav.switchToChinese}
        aria-current={locale === 'zh' ? 'page' : undefined}
      >
        中
      </a>
      <span aria-hidden="true">/</span>
      <a
        href={localeHref('en')}
        title={copy.nav.switchToEnglish}
        aria-current={locale === 'en' ? 'page' : undefined}
      >
        EN
      </a>
    </nav>
  )
}

function LandingHeader({ authenticated, locale }: LandingProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const closeMobileNav = () => setMobileNavOpen(false)
  const copy = landingCopy[locale]

  return (
    <header className="landing-header">
      <div className="landing-container landing-header-inner">
        <a
          className="landing-brand"
          href={locale === 'zh' ? '/' : '/en'}
          aria-label={copy.nav.homeLabel}
        >
          <span className="landing-brand-mark" aria-hidden="true">
            DS
          </span>
          <span>DeepSales</span>
        </a>

        <nav className="landing-nav" aria-label={copy.nav.mainNavigation}>
          <a href="#product">{copy.nav.product}</a>
          <a href="#how-it-works">{copy.nav.howItWorks}</a>
          <a href="#demo">{copy.nav.demo}</a>
          <LocaleSwitch locale={locale} copy={copy} />
          {authenticated ? (
            <Button asChild size="sm">
              <a href="/inbox">
                {copy.nav.openWorkspace}
                <ArrowUpRight aria-hidden="true" />
              </a>
            </Button>
          ) : (
            <>
              <a className="landing-sign-in" href="/login">
                {copy.nav.signIn}
              </a>
              <Button asChild size="sm">
                <a href="/login">{copy.nav.freeTrial}</a>
              </Button>
            </>
          )}
        </nav>

        <div className="landing-header-actions">
          <LocaleSwitch locale={locale} copy={copy} />
          <button
            className="landing-menu-toggle"
            type="button"
            aria-expanded={mobileNavOpen}
            aria-controls="landing-mobile-navigation"
            aria-label={mobileNavOpen ? copy.nav.closeNavigation : copy.nav.openNavigation}
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            {mobileNavOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
          </button>
        </div>

        {mobileNavOpen && (
          <nav
            id="landing-mobile-navigation"
            className="landing-mobile-nav"
            aria-label={copy.nav.mainNavigation}
          >
            <a href="#product">{copy.nav.product}</a>
            <a href="#how-it-works">{copy.nav.howItWorks}</a>
            <a href="#demo">{copy.nav.demo}</a>
            {authenticated ? (
              <Button asChild size="sm">
                <a href="/inbox" onClick={closeMobileNav}>
                  {copy.nav.openWorkspace}
                  <ArrowUpRight aria-hidden="true" />
                </a>
              </Button>
            ) : (
              <div className="landing-mobile-actions">
                <a href="/login" onClick={closeMobileNav}>
                  {copy.nav.signIn}
                </a>
                <Button asChild size="sm">
                  <a href="/login" onClick={closeMobileNav}>
                    {copy.nav.freeTrial}
                  </a>
                </Button>
              </div>
            )}
          </nav>
        )}
      </div>
    </header>
  )
}

function ProductPreview({ locale }: { locale: LandingLocale }) {
  const [selectedConversation, setSelectedConversation] = useState(0)
  const thread = demoThreads[selectedConversation] ?? demoThreads[0]
  const copy = landingCopy[locale].preview

  return (
    <section id="product" className="product-preview" aria-label={copy.ariaLabel}>
      <div className="preview-chrome">
        <div className="preview-window-controls" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <span className="preview-chrome-title">{copy.chromeTitle}</span>
        <span className="preview-live">
          <span aria-hidden="true" />
          {copy.live}
        </span>
      </div>

      <div className="preview-layout">
        <aside className="preview-inbox-panel" aria-label={copy.inboxListLabel}>
          <div className="preview-panel-heading">
            <div>
              <span className="preview-panel-kicker">{copy.panelKicker}</span>
              <strong>{copy.inbox}</strong>
            </div>
            <span className="preview-count">3</span>
          </div>
          <div className="preview-filter">
            <span>{copy.allOpen}</span>
            <span className="preview-filter-status">{copy.conversationCount}</span>
          </div>
          <div className="preview-conversations">
            {demoThreads.map((conversation, index) => (
              <button
                key={conversation.name}
                className={`preview-conversation ${selectedConversation === index ? 'selected' : ''}`}
                type="button"
                aria-pressed={selectedConversation === index}
                onClick={() => setSelectedConversation(index)}
              >
                <Avatar size="sm" className="preview-avatar">
                  <AvatarFallback>{conversation.initials}</AvatarFallback>
                </Avatar>
                <span className="preview-conversation-copy">
                  <span className="preview-conversation-topline">
                    <strong>{conversation.name}</strong>
                    <time>{conversation.time}</time>
                  </span>
                  <span className="preview-conversation-product">{conversation.product}</span>
                  <span className="preview-conversation-state">
                    <span aria-hidden="true" />
                    {copy.aiHandling}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="preview-thread" aria-label={copy.conversationLabel}>
          <header className="preview-thread-header">
            <div className="preview-thread-identity">
              <Avatar className="preview-avatar preview-avatar-large">
                <AvatarFallback>{thread.initials}</AvatarFallback>
              </Avatar>
              <div>
                <strong>{thread.name}</strong>
                <span>
                  <MessageCircle aria-hidden="true" /> {copy.facebookMessenger}
                </span>
              </div>
            </div>
            <span className="preview-open-status">{copy.open}</span>
          </header>
          <div className="preview-message-list">
            <div className="preview-date-divider">{copy.today}</div>
            <article className="preview-message preview-message-customer">
              <div className="preview-message-meta">
                <strong>{thread.name}</strong>
                <time>{thread.time}</time>
              </div>
              <p>{thread.customerMessage}</p>
            </article>
            <article className="preview-message preview-message-ai">
              <div className="preview-message-meta">
                <strong>
                  <Sparkles aria-hidden="true" /> Nova
                </strong>
                <span className="preview-ai-badge">{copy.aiTeammate}</span>
              </div>
              <p>{thread.aiMessage}</p>
              <span className="preview-message-delivery">
                <CheckCircle2 aria-hidden="true" /> {copy.readyToSend}
              </span>
            </article>
          </div>
          <div className="preview-composer">
            <span>
              {copy.replyTo} {thread.name}…
            </span>
            <ArrowUpRight aria-hidden="true" />
          </div>
        </section>

        <aside className="preview-context-panel" aria-label={copy.contextLabel}>
          <div className="preview-context-heading">
            <span className="preview-panel-kicker">{copy.context}</span>
            <strong>{copy.customerAndAi}</strong>
          </div>
          <div className="preview-customer-card">
            <Avatar className="preview-avatar preview-avatar-large">
              <AvatarFallback>{thread.initials}</AvatarFallback>
            </Avatar>
            <strong>{thread.name}</strong>
            <span>{copy.facebookCustomer}</span>
          </div>
          <dl className="preview-details">
            <div>
              <dt>{copy.page}</dt>
              <dd>{thread.page}</dd>
            </div>
            <div>
              <dt>{copy.assignee}</dt>
              <dd className="preview-assignee">
                <span className="preview-assignee-dot" aria-hidden="true" />
                Nova <span>{copy.aiTeammate}</span>
              </dd>
            </div>
          </dl>
          <div className="preview-knowledge">
            <span className="preview-panel-kicker">{copy.knowledgeUsed}</span>
            <div>
              {thread.knowledge.map((item) => (
                <span key={item}>{copy.knowledgeLabels[item] ?? item}</span>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </section>
  )
}

function SectionIntro({
  eyebrow,
  title,
  copy,
  titleId,
}: {
  eyebrow: string
  title: string
  copy?: string
  titleId?: string
}) {
  return (
    <div className="landing-section-intro">
      <p className="landing-eyebrow">{eyebrow}</p>
      <h2 id={titleId}>{title}</h2>
      {copy && <p className="landing-section-copy">{copy}</p>}
    </div>
  )
}

function ValuesSection({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].values
  const values = [
    {
      icon: Inbox,
      ...copy.items[0],
    },
    {
      icon: Bot,
      ...copy.items[1],
    },
    {
      icon: UsersRound,
      ...copy.items[2],
    },
  ]

  return (
    <section id="values" className="landing-section landing-values" aria-labelledby="value-title">
      <div className="landing-container">
        <SectionIntro
          eyebrow={copy.eyebrow}
          title={copy.title}
          copy={copy.copy}
          titleId="value-title"
        />
        <div className="value-grid">
          {values.map(({ icon: Icon, title, copy }, index) => (
            <article className="value-item" key={title}>
              <div className="value-item-topline">
                <span>0{index + 1}</span>
                <Icon aria-hidden="true" />
              </div>
              <h3>{title}</h3>
              <p>{copy}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

function HowItWorksSection({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].how

  return (
    <section
      id="how-it-works"
      className="landing-section landing-how"
      aria-labelledby="how-it-works-title"
    >
      <div className="landing-container">
        <SectionIntro
          eyebrow={copy.eyebrow}
          title={copy.title}
          copy={copy.copy}
          titleId="how-it-works-title"
        />
        <div className="process-flow">
          {copy.steps.map(({ title, copy: stepCopy }, index) => {
            const Icon = howItWorksIcons[index] ?? MessageCircle

            return (
              <div className="process-step" key={title}>
                <div className="process-step-marker">
                  <span>0{index + 1}</span>
                  <Icon aria-hidden="true" />
                </div>
                <div>
                  <h3>{title}</h3>
                  {stepCopy && <p>{stepCopy}</p>}
                </div>
                {index < copy.steps.length - 1 && (
                  <ArrowRight
                    className="process-arrow process-arrow-horizontal"
                    aria-hidden="true"
                  />
                )}
                {index < copy.steps.length - 1 && (
                  <ArrowDown className="process-arrow process-arrow-vertical" aria-hidden="true" />
                )}
              </div>
            )
          })}
        </div>
        <div className="process-summary">
          <span>
            <MessageCircle aria-hidden="true" /> {copy.summary[0]}
          </span>
          <ArrowRight aria-hidden="true" />
          <span>
            <Inbox aria-hidden="true" /> {copy.summary[1]}
          </span>
          <ArrowRight aria-hidden="true" />
          <span>
            <UsersRound aria-hidden="true" /> {copy.summary[2]}
          </span>
        </div>
      </div>
    </section>
  )
}

function AiMemberSection({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].ai
  const members = [
    { initials: 'SC', name: 'Sarah', role: locale === 'zh' ? '客服' : 'Support' },
    { initials: 'DR', name: 'Daniel', role: locale === 'zh' ? '销售' : 'Sales' },
  ]

  return (
    <section className="landing-section landing-ai" aria-labelledby="ai-member-title">
      <div className="landing-container landing-ai-grid">
        <div className="ai-copy">
          <p className="landing-eyebrow">{copy.eyebrow}</p>
          <h2 id="ai-member-title">
            {copy.titleFirst}
            <span>{copy.titleSecond}</span>
          </h2>
          {copy.body.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <a className="text-link" href="#demo">
            {copy.link} <ArrowRight aria-hidden="true" />
          </a>
        </div>

        <div className="member-preview">
          <div className="member-preview-heading">
            <div>
              <span className="preview-panel-kicker">{copy.team}</span>
              <strong>{copy.members}</strong>
            </div>
            <span>{copy.activeMembers}</span>
          </div>
          {members.map((member) => (
            <div className="member-preview-row" key={member.name}>
              <Avatar size="sm" className="preview-avatar member-avatar">
                <AvatarFallback>{member.initials}</AvatarFallback>
              </Avatar>
              <div>
                <strong>{member.name}</strong>
                <span>{member.role}</span>
              </div>
            </div>
          ))}
          <div className="member-preview-row member-preview-ai">
            <Avatar size="sm" className="preview-avatar member-avatar member-avatar-ai">
              <AvatarFallback>N</AvatarFallback>
            </Avatar>
            <div>
              <strong>Nova</strong>
              <span>{copy.aiTeammate}</span>
            </div>
            <span className="member-online">
              <span aria-hidden="true" /> {copy.online}
            </span>
            <span className="member-ai-label">AI</span>
          </div>
          <div className="capability-panel">
            <div className="capability-heading">
              <Sparkles aria-hidden="true" />
              <strong>{copy.setup}</strong>
            </div>
            <div className="capability-line">
              <span>{copy.canAccess}</span>
              <strong>Facebook Store</strong>
            </div>
            <div className="capability-line capability-knowledge">
              <span>{copy.knowledge}</span>
              <div>
                {copy.knowledgeLabels.map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function DemoCtaSection({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].demo

  return (
    <section id="demo" className="landing-section landing-demo-cta" aria-labelledby="demo-title">
      <div className="landing-container demo-cta-inner">
        <div>
          <p className="landing-eyebrow">{copy.eyebrow}</p>
          <h2 id="demo-title">{copy.title}</h2>
          <p>{copy.copy}</p>
        </div>
        <Button asChild size="lg">
          <a href={locale === 'zh' ? '/demo' : '/en/demo'}>
            {copy.action} <ArrowUpRight aria-hidden="true" />
          </a>
        </Button>
      </div>
    </section>
  )
}

function FinalCta({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].final

  return (
    <section className="landing-final-cta" aria-labelledby="final-cta-title">
      <div className="landing-container">
        <div className="final-cta-rule" aria-hidden="true" />
        <p className="landing-eyebrow">{copy.eyebrow}</p>
        <h2 id="final-cta-title">{copy.title}</h2>
        <Button asChild size="lg">
          <a href="/login">
            {copy.action} <ArrowRight aria-hidden="true" />
          </a>
        </Button>
        <p className="final-cta-note">{copy.note}</p>
      </div>
    </section>
  )
}

function LandingFooter({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].footer

  return (
    <footer className="landing-footer">
      <div className="landing-container landing-footer-inner">
        <div>
          <a className="landing-footer-brand" href={locale === 'zh' ? '/' : '/en'}>
            <span className="landing-brand-mark" aria-hidden="true">
              DS
            </span>
            <span>DeepSales</span>
          </a>
          <p>{copy.tagline}</p>
        </div>
        <div className="landing-footer-links">
          <a href="#product">{copy.product}</a>
          <a href="#demo">{copy.demo}</a>
          <a href="/login">{copy.signIn}</a>
          <a href={locale === 'zh' ? '/en' : '/'}>{copy.languageLink}</a>
        </div>
        <p className="landing-copyright">© 2026 DeepSales</p>
      </div>
    </footer>
  )
}

export function LandingPage({ authenticated, locale }: LandingProps) {
  const copy = landingCopy[locale]

  useEffect(() => {
    updateLandingSeo(locale)
  }, [locale])

  return (
    <div id="landing-page" className="landing-page">
      <LandingHeader authenticated={authenticated} locale={locale} />
      <main>
        <section className="landing-hero" aria-labelledby="hero-title">
          <div className="landing-container">
            <div className="hero-copy">
              <p className="landing-eyebrow">
                <span className="landing-eyebrow-mark" aria-hidden="true" /> {copy.hero.eyebrow}
              </p>
              <h1 id="hero-title">
                <span className="hero-title-line">{copy.hero.titleFirst}</span>
                <span>{copy.hero.titleSecond}</span>
              </h1>
              <p className="hero-lead">{copy.hero.lead}</p>
              <div className="hero-actions">
                <Button asChild size="lg">
                  <a href="/login">
                    {copy.hero.primaryAction} <ArrowRight aria-hidden="true" />
                  </a>
                </Button>
                <a className="hero-secondary-action" href={locale === 'zh' ? '/demo' : '/en/demo'}>
                  {copy.hero.secondaryAction} <ArrowUpRight aria-hidden="true" />
                </a>
              </div>
              <p className="hero-note">
                <MessageCircle aria-hidden="true" /> {copy.hero.note}
              </p>
            </div>
            <div className="hero-rule" aria-hidden="true" />
            <ProductPreview locale={locale} />
          </div>
        </section>
        <ValuesSection locale={locale} />
        <HowItWorksSection locale={locale} />
        <AiMemberSection locale={locale} />
        <DemoCtaSection locale={locale} />
        <FinalCta locale={locale} />
      </main>
      <LandingFooter locale={locale} />
    </div>
  )
}
