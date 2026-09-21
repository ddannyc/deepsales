// Demo fixtures only.
// Contains no real customer or production data.

export type LandingDemoThread = {
  name: string
  initials: string
  product: string
  customerMessage: string
  aiMessage: string
  time: string
  page: string
  knowledge: string[]
}

export const landingDemoThreads: LandingDemoThread[] = [
  {
    name: 'Emily Carter',
    initials: 'EC',
    product: 'TrailPack 22L',
    customerMessage: 'Hi, is this backpack waterproof?',
    aiMessage:
      'Yes — this model uses a water-resistant outer fabric and is suitable for light rain. Would you like me to show you the available colors?',
    time: '09:41',
    page: 'Northstar Outdoor',
    knowledge: ['Product FAQ', 'Shipping policy'],
  },
  {
    name: 'Lucas Reed',
    initials: 'LR',
    product: 'City Sling',
    customerMessage: 'Which colors are available for the City Sling?',
    aiMessage:
      'The City Sling is ready to explore in charcoal, moss, and sand. I can help you compare them if you have a favorite style in mind.',
    time: '09:28',
    page: 'Northstar Outdoor',
    knowledge: ['Product FAQ', 'Color guide'],
  },
  {
    name: 'Mia Chen',
    initials: 'MC',
    product: 'Travel Bottle',
    customerMessage: 'Can someone help me with a return?',
    aiMessage:
      'I can bring a teammate into this conversation to help with your return. Someone from the Northstar Outdoor team will be with you shortly.',
    time: '08:56',
    page: 'Northstar Outdoor',
    knowledge: ['Returns', 'Human handoff'],
  },
]

export type DemoConversationId = 'emily' | 'lucas'
export type DemoMessageSender = 'customer' | 'ai' | 'system'

export type DemoMessage = {
  id: string
  sender: DemoMessageSender
  text: string
  time: string
}

export type DemoConversation = {
  id: DemoConversationId
  name: string
  initials: string
  preview: string
  time: string
  status: 'ai' | 'waiting-human'
  assignee: 'nova' | null
  messages: DemoMessage[]
}

export const demoFixtures = {
  workspace: 'Northstar Outdoor',
  page: 'Northstar Outdoor Store',
  members: [
    { name: 'Sarah', role: 'support', initials: 'SA' },
    { name: 'Daniel', role: 'sales', initials: 'DA' },
    { name: 'Nova', role: 'ai', initials: 'N' },
  ],
  conversations: [
    {
      id: 'emily',
      name: 'Emily Carter',
      initials: 'EC',
      preview: 'Can I use it for hiking?',
      time: '09:42',
      status: 'ai',
      assignee: 'nova',
      messages: [
        {
          id: 'emily-customer-waterproof',
          sender: 'customer',
          text: 'Hi, is this backpack waterproof?',
          time: '09:41',
        },
        {
          id: 'emily-ai-waterproof',
          sender: 'ai',
          text: 'Yes — the TrailPack uses a water-resistant outer fabric and is suitable for light rain.',
          time: '09:41',
        },
        {
          id: 'emily-customer-hiking',
          sender: 'customer',
          text: 'Can I use it for hiking?',
          time: '09:42',
        },
        {
          id: 'emily-ai-hiking',
          sender: 'ai',
          text: 'Yes. The 22L model is designed for day trips and light hiking. It also includes a padded back panel and bottle pockets.',
          time: '09:42',
        },
      ],
    },
    {
      id: 'lucas',
      name: 'Lucas Reed',
      initials: 'LR',
      preview: 'Hi, where is my order?',
      time: '09:36',
      status: 'waiting-human',
      assignee: null,
      messages: [
        {
          id: 'lucas-customer-order',
          sender: 'customer',
          text: 'Hi, where is my order?',
          time: '09:35',
        },
        {
          id: 'lucas-ai-handoff',
          sender: 'ai',
          text: 'I can help with general shipping questions, but I need a team member to check your specific order status.',
          time: '09:36',
        },
        {
          id: 'lucas-system-handoff',
          sender: 'system',
          text: 'Nova 已将该会话转交给人工处理。',
          time: '09:36',
        },
      ],
    },
  ],
} satisfies {
  workspace: string
  page: string
  members: Array<{ name: string; role: string; initials: string }>
  conversations: DemoConversation[]
}
