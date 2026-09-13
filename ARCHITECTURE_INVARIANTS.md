# Architecture Invariants

These are non-negotiable Lean V1 architecture rules.

## INV-01 — Member First-Class

Human and AI are both `Member`.

Core domain tables and APIs use `member_id`.

Do not introduce:

- `ai_member_id`
- `human_member_id`
- `human_agent_id`
- separate AI/Human conversation ownership models

## INV-02 — User / Member Separation

`User` represents authentication.

`Member` represents customer-service identity.

Conversation ownership references Member, never User.

## INV-03 — Authentication != Service Identity

AI members do not require login accounts.

Do not create fake users, emails, or passwords for AI.

## INV-04 — AI Response Commit Authorization

An AI may create a customer-visible outbound Message only if, at commit time, it is still the current conversation assignee.

Authorization happens when committing the outbound Message, not when delivering it to Facebook.

## INV-05 — AI Input Freshness

An AI may create a customer-visible outbound Message only if the latest customer input still matches the input range used by its AIResponseRun.

If a new customer message arrived, cancel the stale run and generate from fresh input.

## INV-06 — Grounded Business Answer

AI may not invent company-specific facts such as price, product capability, delivery, return policy, or support rules when configured knowledge is insufficient.

Safe fallback or human handoff is required.

## INV-07 — Assignment Policy, Not Identity Split

Routing policy may prioritize member types, but HUMAN and AI must remain the same core Member entity.

Do not create separate assignment domains.

## INV-08 — Assignment Gateway

Every change to conversation ownership must go through one assignment-domain boundary.

Do not directly update `conversation.assignee_member_id` from controllers, queue handlers, AI code, or channel adapters.

The assignment boundary must also record `ConversationAssignment`.

## INV-09 — Human Handoff Persistence

AI handoff sets:

`routing_constraint = HUMAN_ONLY`

This constraint remains after a human is assigned.

It is cleared only by:

- closing the conversation, or
- a human explicitly transferring back to AI

This prevents AI -> Human -> automatic AI loops.

## INV-10 — Channel-Specific Logic Isolation

Provider-specific concepts stay inside provider adapters/configuration.

Core Conversation / Member models must not contain:

- Facebook Page ID
- PSID-specific naming
- Page Access Token
- Messenger 24-hour window state
- Meta-specific error semantics

## INV-11 — Queue Semantics

`queue_reason` and `routing_queued_at` are meaningful only while a conversation is unassigned.

Successful assignment clears them.

`routing_constraint` is independent and may persist after assignment.

## INV-12 — Committed Message Independence

Once a PENDING outbound Message has been validly committed under correct ownership/freshness checks, subsequent conversation ownership changes do not invalidate it.

Channel delivery proceeds independently.

## INV-13 — PostgreSQL Is the Source of Truth

Critical correctness is enforced with PostgreSQL transactions, constraints, and locking.

Do not depend on Cloudflare Durable Objects, queues, in-memory state, or cache as the authoritative source for:

- conversation ownership
- open-conversation uniqueness
- assignment capacity decisions
- AI response commit authorization
- message delivery state

## INV-14 — One Open Conversation Per Channel Identity

The database must prevent more than one OPEN Conversation for a single ChannelIdentity.

Do not rely only on application pre-checks.

## INV-15 — Webhook Idempotency

Duplicate provider events/messages must not create duplicate domain messages or conversations.

Idempotency must be backed by database uniqueness or equivalent durable constraints.

## INV-16 — Thin Infrastructure Adapters

Cloudflare Workers, Queues, Durable Objects, R2, Hyperdrive, and Facebook API bindings must be isolated behind infrastructure adapters.

Core domain code should not import Cloudflare bindings directly.

Do not implement alternate adapters in V1 unless the primary adapter blocks delivery.

## INV-17 — V1 Scope Discipline

Do not implement deferred features "because they are easy" or "for future flexibility."

If a feature is not required by Lean V1 acceptance criteria, default it to V1.1.
