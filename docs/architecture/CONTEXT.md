# Project Context

## Project

**Facebook AI Shared Inbox**

Current phase: **Lean V1 implementation and release preparation**

This repository should implement the frozen Lean V1 product scope. Product decisions are already made. Do not reopen product discovery unless a contradiction blocks implementation.

## Authoritative Documents

Read these before planning or implementation:

1. `../product/LEAN_V1_PRD.md`
2. `ARCHITECTURE_INVARIANTS.md`
3. `TECHNICAL_DECISIONS.md`
4. `../research/M0_FACEBOOK_SPIKE.md`

If implementation details conflict with these documents, the order above is authoritative unless the user explicitly changes a decision.

## Product Goal

Build a lightweight shared inbox for Facebook Messenger where:

1. A Facebook customer sends a Messenger message.
2. The system receives the webhook and creates or finds the customer, channel identity, conversation, and message.
3. A new conversation is assigned **AI first**, then falls back to a human if no AI member is eligible.
4. The AI answers grounded business questions using configured knowledge.
5. If the AI cannot safely continue, it hands off to a human.
6. A human can take over, reply, transfer, and close the conversation.
7. AI and humans must never race in a way that causes stale or duplicate replies.

## Frozen Lean V1 Scope

Included:

- Facebook Messenger only
- One or more Facebook Pages
- Shared inbox
- Human members
- AI members
- Basic roles: OWNER / ADMIN / AGENT
- Member-to-channel access
- AI-first automatic assignment
- Human fallback
- AI -> Human handoff
- Human -> AI transfer
- Human takeover
- Knowledge base
- Text outbound
- Inbound text and attachment display
- Webhook idempotency
- Message delivery status
- Facebook reply-window enforcement
- AI stale-response protection
- Concurrency-safe assignment and takeover

Explicitly deferred to V1.1:

- Facebook comments
- Instagram / WhatsApp / LINE
- Historical Messenger import
- CRM
- Bulk messaging / marketing automation
- Advanced analytics
- Custom role builder
- Departments / skills / advanced routing
- Full AI version history / rollback
- AI evidence UI
- Generic ConversationEvent timeline
- Complex invitation management
- Full presence subsystem
- Human outbound images
- Complete Meta Business Suite outbound echo synchronization
- Advanced read-state UI
- External AI agents such as Dify / Coze
- AI tool calling / order actions
- Multi-agent collaboration

## Domain Language

### User
A global login identity.

### WorkspaceUserAccess
A human user's access to a workspace and role.

### Member
A service identity that can own and handle conversations.

Member types:

- `HUMAN`
- `AI`

Human and AI are equal first-class members in the core conversation domain.

### Channel
Provider-neutral communication endpoint.

V1 provider:

- `FACEBOOK_MESSENGER`

### ChannelIdentity
The identity of an external customer within a channel.

For Messenger, `external_user_id` is the PSID, but the core domain must not know or name it as PSID.

### Conversation
One customer-service episode.

Lifecycle:

- `OPEN`
- `CLOSED`

A `ChannelIdentity` may have many historical conversations, but at most one OPEN conversation at a time.

### Assignment
Ownership of a conversation by one `Member`.

A conversation has at most one current assignee.

### Conversation Context

The prior customer, AI, and human messages within the current Conversation that give meaning to subsequent replies. This term is distinct from Customer Memory and structured customer properties; the current-context feature does not include other Conversations or cross-channel history.

### Customer Memory

A persistent summary of a customer's prior communications within one Workspace, shared across Conversations, AI Members, and channel identities explicitly linked to that Customer. This term is distinct from current Conversation Context and structured customer properties.

### Customer Property

A named, typed piece of structured information about a Customer, distinct from free-form Customer Memory. Conversation-scoped properties describe one service episode rather than the customer's persistent profile.

### Follow-up Rule

A configured condition for an AI Member to contact eligible customers proactively after a specified delay, with optional instructions and actions. A follow-up is distinct from responding to a new customer message.

### Single-turn Skip

An AI decision to provide no customer-visible reply for the current input while leaving later replies eligible. It is distinct from a persistent stop and from transferring ownership to a human.

### queue_reason
Why an unassigned conversation is currently queued.

Only meaningful while `assignee_member_id IS NULL`.

Lean V1 values:

- `NEW_CONVERSATION`
- `AI_HANDOFF`
- `MANUAL_UNASSIGN`
- `MEMBER_DISABLED`

### routing_constraint
Who may receive the conversation on future assignment.

Values:

- `ANY_MEMBER`
- `HUMAN_ONLY`

AI handoff sets `HUMAN_ONLY`.

### AIResponseRun
One asynchronous AI attempt to respond to a conversation.

Used to enforce ownership, freshness, cancellation, and debugging.

## Core Routing Policy

### New conversation

1. Find eligible AI members.
2. If one exists, assign the best AI candidate.
3. Otherwise find eligible human members.
4. If one exists, assign the best human candidate.
5. Otherwise leave unassigned.

### AI handoff

1. Set `routing_constraint = HUMAN_ONLY`.
2. Unassign AI.
3. Set `queue_reason = AI_HANDOFF`.
4. Search only eligible HUMAN members.
5. If none are available, keep the conversation queued for a human.

### Candidate selection

Within one candidate type:

`load_ratio = open_assigned_conversations / max_active_conversations`

Choose the lowest ratio.

Tie-break by least recently auto-assigned.

## Implementation guardrails

Do not:

- split human and AI into separate conversation models
- add `ai_member_id` or `human_member_id` to core business tables
- put `facebook_page_id`, `psid`, page token, or Messenger-window rules into Conversation or Member
- add more Conversation lifecycle statuses
- bypass the assignment domain to mutate conversation ownership directly
- use D1 as the primary source of truth for conversation concurrency
- introduce Redis, Kafka, microservices, Qdrant, or another infrastructure component without a proven V1 need
- add speculative abstractions for future providers
- add V1.1 features while implementing V1
- silently weaken concurrency, idempotency, or AI freshness constraints to simplify code

## Implementation Philosophy

- Modular monolith
- One repository
- TypeScript throughout application code
- PostgreSQL is the source of truth
- Cloudflare-specific services live behind thin infrastructure adapters
- Prefer explicit domain services over framework magic for critical assignment / handoff / AI commit logic
- Favor database constraints and transactions over application-only assumptions
- Every ticket should be a vertical slice with executable acceptance tests
