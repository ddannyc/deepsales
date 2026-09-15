# Database ER Relationships

当前图以 [`packages/db/src/schema.ts`](packages/db/src/schema.ts) 中的实际 Drizzle schema 为准。

```mermaid
erDiagram
  USERS ||--o{ SESSIONS : has
  USERS ||--o{ ACCOUNTS : has
  USERS ||--o{ WORKSPACE_USER_ACCESS : joins
  USERS ||--o{ WORKSPACE_INVITATION : creates
  USERS ||--o{ FACEBOOK_OAUTH_STATE : initiates

  WORKSPACE ||--o{ WORKSPACE_USER_ACCESS : contains
  WORKSPACE ||--o{ WORKSPACE_INVITATION : contains
  WORKSPACE ||--o{ MEMBER : contains
  WORKSPACE ||--o{ CHANNEL : contains
  WORKSPACE ||--o{ CUSTOMER : contains
  WORKSPACE ||--o{ CHANNEL_IDENTITY : contains
  WORKSPACE ||--o{ CONVERSATION : contains
  WORKSPACE ||--o{ KNOWLEDGE_BASE : contains
  WORKSPACE ||--o{ KNOWLEDGE_DOCUMENT : contains
  WORKSPACE ||--o{ KNOWLEDGE_CHUNK : contains
  WORKSPACE ||--o{ FACEBOOK_OAUTH_STATE : owns

  WORKSPACE_USER_ACCESS ||--o| MEMBER : human_member
  MEMBER ||--o| HUMAN_MEMBER_AVAILABILITY : has
  MEMBER ||--o{ MEMBER_CHANNEL_ACCESS : grants
  CHANNEL ||--o{ MEMBER_CHANNEL_ACCESS : allows

  CHANNEL ||--o| FACEBOOK_CHANNEL_CONFIG : config
  CHANNEL ||--o{ CHANNEL_IDENTITY : identifies
  CUSTOMER ||--o{ CHANNEL_IDENTITY : owns
  CHANNEL_IDENTITY ||--o| FACEBOOK_MESSAGING_WINDOW : window
  CHANNEL_IDENTITY ||--o{ CONVERSATION : starts

  MEMBER o|--o{ CONVERSATION : assignee
  MEMBER o|--o{ CONVERSATION : closed_by
  CONVERSATION ||--o{ CONVERSATION_ASSIGNMENT : history
  MEMBER o|--o{ CONVERSATION_ASSIGNMENT : from_member
  MEMBER o|--o{ CONVERSATION_ASSIGNMENT : to_member
  MEMBER o|--o{ CONVERSATION_ASSIGNMENT : acting_member

  CONVERSATION ||--o{ MESSAGE : contains
  CHANNEL ||--o{ MESSAGE : transports
  MEMBER o|--o{ MESSAGE : sends
  MESSAGE ||--o{ MESSAGE_ATTACHMENT : has
  MESSAGE_ATTACHMENT ||--o| FACEBOOK_ATTACHMENT_SOURCE : source
  MESSAGE ||--o{ FACEBOOK_DELIVERY_ATTEMPT : attempts

  KNOWLEDGE_BASE ||--o{ KNOWLEDGE_DOCUMENT : contains
  KNOWLEDGE_DOCUMENT ||--o{ KNOWLEDGE_CHUNK : splits
  KNOWLEDGE_BASE ||--o{ KNOWLEDGE_CHUNK : indexes
  MEMBER ||--o| AI_MEMBER_CONFIG : configures
  KNOWLEDGE_BASE o|--o{ AI_MEMBER_CONFIG : binds

  USERS {
    uuid id PK
    text email UK
  }
  SESSIONS {
    uuid id PK
    uuid user_id FK
  }
  ACCOUNTS {
    uuid id PK
    uuid user_id FK
  }
  VERIFICATIONS {
    uuid id PK
    text identifier
  }
  WORKSPACE {
    uuid id PK
  }
  WORKSPACE_USER_ACCESS {
    uuid id PK
    uuid workspace_id FK
    uuid user_id FK
  }
  WORKSPACE_INVITATION {
    uuid id PK
    uuid workspace_id FK
    uuid created_by_user_id FK
  }
  MEMBER {
    uuid id PK
    uuid workspace_id FK
    uuid workspace_user_access_id FK
    enum type
  }
  HUMAN_MEMBER_AVAILABILITY {
    uuid member_id PK,FK
  }
  CHANNEL {
    uuid id PK
    uuid workspace_id FK
  }
  MEMBER_CHANNEL_ACCESS {
    uuid member_id PK,FK
    uuid channel_id PK,FK
  }
  FACEBOOK_CHANNEL_CONFIG {
    uuid channel_id PK,FK
    text page_id UK
  }
  FACEBOOK_OAUTH_STATE {
    uuid id PK
    uuid workspace_id FK
    uuid initiated_by_user_id FK
  }
  CUSTOMER {
    uuid id PK
    uuid workspace_id FK
  }
  CHANNEL_IDENTITY {
    uuid id PK
    uuid workspace_id FK
    uuid customer_id FK
    uuid channel_id FK
  }
  FACEBOOK_MESSAGING_WINDOW {
    uuid channel_identity_id PK,FK
  }
  CONVERSATION {
    uuid id PK
    uuid workspace_id FK
    uuid channel_identity_id FK
    uuid assignee_member_id FK
    uuid closed_by_member_id FK
    enum status
  }
  CONVERSATION_ASSIGNMENT {
    uuid id PK
    uuid conversation_id FK
    uuid from_member_id FK
    uuid to_member_id FK
    uuid acting_member_id FK
  }
  MESSAGE {
    uuid id PK
    uuid conversation_id FK
    uuid channel_id FK
    uuid sender_member_id FK
  }
  MESSAGE_ATTACHMENT {
    uuid id PK
    uuid message_id FK
  }
  FACEBOOK_ATTACHMENT_SOURCE {
    uuid attachment_id PK,FK
  }
  FACEBOOK_DELIVERY_ATTEMPT {
    uuid id PK
    uuid message_id FK
  }
  FACEBOOK_WEBHOOK_RECEIPT {
    uuid id PK
    text ingress_id UK
    text page_id
  }
  KNOWLEDGE_BASE {
    uuid id PK
    uuid workspace_id FK
  }
  AI_MEMBER_CONFIG {
    uuid member_id PK,FK
    uuid knowledge_base_id FK
  }
  KNOWLEDGE_DOCUMENT {
    uuid id PK
    uuid workspace_id FK
    uuid knowledge_base_id FK
  }
  KNOWLEDGE_CHUNK {
    uuid id PK
    uuid knowledge_document_id FK
    uuid knowledge_base_id FK
    uuid workspace_id FK
  }
```

## Important constraints

- `channel_identity(channel_id, external_user_id)` 唯一。
- 一个 `channel_identity` 最多一个 `OPEN` conversation。
- `member_channel_access(member_id, channel_id)` 是复合主键。
- `message(channel_id, external_message_id)` 在外部消息 ID 不为空时唯一，用于 webhook 幂等。
- `facebook_webhook_receipt` 是独立的 Facebook 诊断/幂等记录，不直接外键关联核心业务表。
- `conversation.last_customer_message_id` 是逻辑引用，当前没有数据库外键。
- 规格要求的 `ai_response_run` 当前尚未出现在实际 schema 或 migration 中；实现 AI runtime 时需要补充。
