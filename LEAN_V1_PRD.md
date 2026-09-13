# Facebook AI Shared Inbox — Lean V1 Product Requirements

Status: **Frozen Baseline**

## 1. Product Goal

Validate whether a small Facebook customer-service team benefits from one shared inbox where AI handles routine Messenger questions first and reliably hands off to humans when needed.

The V1 success path is:

Facebook customer message  
-> inbox  
-> conversation  
-> AI or human assignment  
-> response  
-> AI handoff when necessary  
-> human takeover / reply / transfer  
-> close

Any feature that does not directly support this loop is out of V1 by default.

## 2. Roles

### OWNER
Workspace creator. Full V1 permissions. Cannot be removed by a normal admin.

### ADMIN
Manage channels, members, AI members, knowledge, and all conversations.

### AGENT
Handle own conversations, see unassigned / waiting-human queues, take over, reply, transfer, and close conversations according to permissions.

## 3. Facebook Messenger

V1 must support:

- Connect Facebook Page(s)
- Receive Messenger webhooks in real time
- Receive text
- Display inbound images/files/audio/video as attachments
- Send text replies
- Detect Page token / permission failure
- Enforce normal Messenger reply-window restrictions
- Idempotently process duplicate webhooks

V1 does not support:

- Facebook comments
- historical conversation import
- marketing messages
- bulk messaging
- Messenger templates
- proactive outbound conversation initiation
- guaranteed synchronization of messages manually sent from Meta Business Suite

## 4. Shared Inbox

Fixed views:

- My Conversations
- Waiting for Human
- AI Handling
- Unassigned
- All Open

These are query views, not Conversation statuses.

## 5. Conversation

Conversation is one customer-service episode.

Lifecycle:

- `OPEN`
- `CLOSED`

A `ChannelIdentity` can have many historical conversations but no more than one OPEN conversation at the same time.

Closing a conversation does not permanently close the customer relationship. A later inbound message creates a new Conversation.

### Core fields

- workspace
- channel identity
- status
- current assignee member
- queue reason
- routing constraint
- queued time
- latest message timestamps
- last customer message reference
- closed time / closed by

### queue_reason

Only set while unassigned.

Lean V1:

- `NEW_CONVERSATION`
- `AI_HANDOFF`
- `MANUAL_UNASSIGN`
- `MEMBER_DISABLED`

Clear it after successful assignment.

### routing_constraint

- `ANY_MEMBER`
- `HUMAN_ONLY`

A new conversation starts as `ANY_MEMBER`.

AI handoff switches the conversation to `HUMAN_ONLY`.

`HUMAN_ONLY` persists even after a human is assigned, until the conversation is closed or a human explicitly transfers it back to AI.

## 6. Member Model

Human and AI are both:

`Member`

Member fields include:

- workspace
- type: `HUMAN | AI`
- display name
- avatar
- lifecycle: `ACTIVE | DISABLED`
- auto-assignment enabled
- maximum active conversations

Core business objects must use `member_id`, never human- or AI-specific foreign keys.

## 7. User and Human Member

`User` is a login identity.

`Member` is a customer-service identity.

Humans connect through:

User  
-> WorkspaceUserAccess  
-> Member(type=HUMAN)

AI members have no User/login account.

V1 human configuration:

- name
- login account
- OWNER / ADMIN / AGENT role
- channel access
- auto-assignment enabled
- max active conversations
- available / unavailable

Presence is intentionally simple in V1.

## 8. Channel Access

`MemberChannelAccess(member_id, channel_id)`

The same model is used for HUMAN and AI.

It means that a member is allowed to service conversations from that channel.

It is separate from administrative permissions.

## 9. AI Member

Lean V1 AI configuration:

- member
- instructions
- response language
- one knowledge base
- handoff-on-customer-request
- handoff-on-no-knowledge
- handoff-on-negative-sentiment
- handoff-on-unable-to-answer
- handoff keywords
- published config snapshot
- published time

V1 uses a simple Draft -> Publish flow.

Publishing copies the current editable AI configuration into a stable runtime snapshot.

Do not implement a full version-history / rollback subsystem in V1.

## 10. Knowledge

Lean V1 supports:

- text
- PDF
- DOCX
- TXT
- Markdown

Document flow:

upload  
-> extract text  
-> chunk  
-> embed  
-> index  
-> ready

One AI member may bind one knowledge base in Lean V1.

Business-fact answers involving products, price, delivery, returns, support policy, or other company facts must be grounded in configured knowledge.

If reliable knowledge is unavailable, AI must not invent the answer.

It should safely state uncertainty or hand off.

## 11. AIResponseRun

Each asynchronous AI attempt is represented by an AIResponseRun.

Important states:

- `QUEUED`
- `GENERATING`
- `COMPLETED`
- `HANDOFF`
- `CANCELLED`
- `FAILED`

It records:

- conversation
- member
- input first / last message
- retrieved chunk IDs
- failure / cancellation reason

This is required in V1.

## 12. Debounce

Short bursts of customer messages should be merged into one AI attempt.

Default implementation target: approximately 2 seconds.

The exact value is an internal implementation detail in V1.

## 13. AI Freshness

When an AI run begins, record its last input customer message.

Before creating a customer-visible outbound Message:

1. lock/recheck the Conversation
2. verify the AI member is still current assignee
3. verify the latest customer message has not advanced

If ownership changed:

- cancel with `OWNERSHIP_CHANGED`

If a new customer message arrived:

- cancel with `NEW_CUSTOMER_MESSAGE`
- schedule a fresh AI run using the latest input

## 14. Human Takeover

A human can explicitly take over a conversation currently handled by AI.

Takeover and AI response commit may race.

The implementation must make the result deterministic using database transaction/locking semantics.

If human takeover commits first, the AI may not create the outbound response.

If AI response commit completed first, the committed pending message remains valid and delivery proceeds even if the human takes over immediately afterward.

## 15. AI Handoff

Triggers include:

- customer explicitly asks for a person
- insufficient knowledge
- AI cannot safely continue
- strong negative sentiment
- handoff keyword
- AI runtime failure
- unsupported attachment content

Handoff must:

1. create an optional customer-facing transfer message as PENDING
2. change assignee AI -> NULL
3. set `routing_constraint = HUMAN_ONLY`
4. set `queue_reason = AI_HANDOFF`
5. trigger human-only assignment

Message delivery and human assignment are independent asynchronous operations.

Failure to deliver the transfer notice must not block the human handoff.

## 16. Assignment

### New conversation

AI first -> Human fallback -> Unassigned

### Eligibility

All members:

- ACTIVE
- auto-assignment enabled
- channel access
- below max active conversations

Human additionally:

- available

AI additionally:

- published config exists
- runtime is usable

### Candidate ranking

Within one type:

1. lowest load ratio
2. least recently auto-assigned

### Handoff

`HUMAN_ONLY` conversations can only be auto-assigned to humans.

If no human is available, keep queued.

Retry when capacity/availability changes and through a low-frequency recovery job.

## 17. Manual Transfer

Allow:

- Human -> Human
- Human -> AI
- Human takeover of AI

Manual transfer may override:

- capacity
- temporary human availability

with a warning.

Manual transfer may not target:

- disabled member
- member without channel access
- unpublished/unhealthy AI

A human explicitly transferring a HUMAN_ONLY conversation back to AI resets routing constraint to ANY_MEMBER.

## 18. Assignment History

Every ownership change must create a `ConversationAssignment` record containing:

- conversation
- from member
- to member
- reason
- acting member when applicable
- timestamp

Do not add a generic ConversationEvent subsystem in Lean V1.

## 19. Message

Lean V1 Message supports:

- inbound/outbound direction
- sender type: CUSTOMER / MEMBER / EXTERNAL
- sender member when MEMBER
- message type
- text
- external message id
- delivery state: PENDING / SENT / FAILED

Human and AI outbound messages both use `sender_type = MEMBER`.

Message delivery must be asynchronous:

create PENDING  
-> call Facebook API  
-> SENT or FAILED

Failed messages must remain visible.

## 20. Attachments

Inbound:

- text
- image
- file/audio/video displayed as attachment

Outbound V1:

- text only

Outbound images are V1.1.

AI treats unsupported attachment-only input as a reason to hand off.

## 21. Facebook Boundary

Core domain uses generic:

- Channel
- ChannelIdentity

Facebook-specific state belongs in the Facebook adapter/config layer.

Do not put these into Conversation or Member:

- page id
- PSID naming
- access token
- Messenger reply-window state

## 22. Facebook Reply Window

Store Messenger-specific messaging-window state outside the core conversation model.

Before outbound send, the Facebook adapter must determine whether normal reply is permitted.

If not permitted, the UI/backend must reject the send instead of waiting for an avoidable API failure.

## 23. Webhook

Webhook endpoint must:

- verify source/signature as applicable
- preserve enough raw event information for debugging
- process idempotently
- ACK quickly
- hand processing to asynchronous work

Do not run LLM generation, heavy document processing, or long business flows synchronously in the webhook request.

## 24. Main Pages

Lean V1 should stay close to:

- `/login`
- `/inbox`
- `/team`
- `/ai-member/:id`
- `/knowledge`
- `/settings/facebook`

Do not create CRM, analytics, workflow, role-builder, or quality-center sections in V1.

## 25. Release Acceptance

V1 is not complete until these real flows work:

### Messenger
Real Facebook user -> Messenger message -> inbox -> reply reaches user.

### AI
New conversation -> AI assigned -> grounded response.

### Handoff
Customer asks for human -> HUMAN_ONLY -> human assigned -> human reply.

### Takeover race
AI generating -> human takeover -> no stale AI response committed after takeover.

### Freshness race
AI generating -> customer sends another message -> old response is cancelled.

### Delivery failure
Facebook send fails -> message is visibly FAILED, not falsely marked sent.

### Conversation lifecycle
Close conversation -> later inbound customer message creates a new OPEN conversation.

## 26. Lean V1 Success Definition

A real small Facebook support team can continuously use the product for customer conversations without returning to Meta Business Suite for the normal handling loop, while AI safely handles routine questions and reliably hands off situations it should not answer.

The product must not suffer from trust-breaking failures such as:

- duplicate replies
- AI/human reply races
- AI returning after human handoff
- stale AI responses
- silent message delivery failure
- lost conversations
- invented critical business facts
