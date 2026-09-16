# Facebook AI Shared Inbox — Lean V1 Implementation Specification

Status: **Implementation baseline**  
Date: 2026-09-13  
M0 gate: **GO**

## 1. Authority and scope

This specification translates the frozen product and architecture decisions into an implementation contract. It does not change them.

Authority, in descending order:

1. `../product/LEAN_V1_PRD.md`
2. `../architecture/ARCHITECTURE_INVARIANTS.md`
3. `../architecture/TECHNICAL_DECISIONS.md`
4. `../research/M0_FACEBOOK_SPIKE.md`
5. `../research/M0_FINDINGS.md`
6. this specification

If this document appears to conflict with a higher-authority document, the higher-authority document wins and implementation stops until the conflict is resolved explicitly.

V1 delivers only the frozen Messenger shared-inbox loop. Every item listed as V1.1 in `../architecture/CONTEXT.md` remains out of scope.

## 2. Release outcome

A release is acceptable when a real workspace can:

1. connect one or more Facebook Pages;
2. receive text and attachment messages into the shared inbox exactly once;
3. route a new conversation AI-first with human fallback;
4. produce a grounded AI answer or safely hand off;
5. let a human take over, reply, transfer, unassign, and close;
6. show outbound delivery failures;
7. prevent stale or unauthorized AI messages under concurrent customer, AI, and human actions; and
8. create a new conversation when a customer messages after the prior one was closed.

## 3. Concrete implementation choices

| Concern | V1 choice |
| --- | --- |
| Repository | pnpm TypeScript workspace |
| Web | React 19 SPA built by Vite |
| HTTP and jobs | One Hono Cloudflare Worker |
| Static hosting | Cloudflare Worker Static Assets, SPA fallback, same origin as the API |
| Authentication | Better Auth email/password and database sessions; Drizzle adapter; no organization plugin |
| Database provider | Neon PostgreSQL with `vector` extension |
| Worker database path | Drizzle ORM over `pg` through a cache-disabled Hyperdrive binding |
| Migration path | Drizzle Kit using a direct `DATABASE_URL_UNPOOLED` (or direct `DATABASE_URL`); generated SQL committed to the repository |
| Validation | Zod at HTTP, queue, provider, and AI-output trust boundaries |
| Styling | Plain CSS with a small shared token file; no UI framework |
| Client data | Native `fetch` and local React state; no global state or query library |
| Durable jobs | Five Cloudflare Queues: `webhooks`, `outbound`, `ai`, `documents`, `maintenance`; one shared DLQ |
| Realtime | One hibernating Durable Object per workspace; notifications only, followed by canonical API reads |
| Object storage | Private Cloudflare R2 bucket |
| AI provider | Alibaba Cloud International Model Studio through native `fetch`; embeddings use `qwen3.7-text-embedding` at 1,536 dimensions and responses use `qwen3.8-flash` |
| Vector search | pgvector cosine distance, HNSW index |
| PDF extraction | `unpdf` serverless build |
| DOCX extraction | `mammoth.extractRawText` with `ArrayBuffer`; external file access remains disabled |
| Text/Markdown/TXT extraction | UTF-8 `TextDecoder` |
| Code quality | TypeScript compiler, Biome lint/format, Vitest, Playwright, PostgreSQL integration tests |

Reasons for the runtime-sensitive choices:

- Cloudflare currently recommends `pg` for Hyperdrive compatibility, and Hyperdrive holds one origin connection for a transaction. Critical transactions must therefore be short and contain no provider or object-storage calls: [Hyperdrive PostgreSQL drivers](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/) and [connection lifecycle](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/).
- Better Auth mounts directly in Hono through Web `Request`/`Response`; Workers require `nodejs_compat`: [Better Auth Hono integration](https://better-auth.com/docs/integrations/hono) and [Drizzle adapter](https://better-auth.com/docs/adapters/drizzle).
- Queue consumers must be idempotent because Cloudflare Queues use at-least-once delivery and do not guarantee order: [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) and [queue behavior](https://developers.cloudflare.com/queues/reference/how-queues-works/).
- A React SPA and Worker can ship as one deployment with API-first route patterns and SPA fallback: [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/).
- Hibernating WebSockets keep idle realtime cost low: [Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
- R2 bindings avoid object-storage credentials in application code: [Workers bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/).
- `unpdf` explicitly supports Cloudflare Workers; Mammoth exposes browser `ArrayBuffer` raw-text extraction: [unpdf](https://github.com/unjs/unpdf) and [Mammoth](https://github.com/mwilliamson/mammoth.js).

No Railway runtime, alternate database adapter, generic provider framework, Redis, Kafka, D1, external vector database, or Python service is built in V1.

## 4. Deployable shape

```text
Browser
  | HTTPS / WebSocket
  v
Cloudflare Worker
  |- Static Assets -> React SPA
  |- Hono routes -> auth and application commands/queries
  |- Facebook webhook verification -> webhooks queue
  |- Queue consumers -> domain modules
  |- Scheduled handler -> recovery scans
  |- Hyperdrive -> Neon PostgreSQL + pgvector
  |- R2 binding -> private documents and inbound attachments
  `- Workspace Durable Object -> realtime invalidation notifications

External calls
  |- Meta OAuth / Graph Send API
  `- Alibaba Cloud International Model Studio APIs
```

The Worker and React assets deploy together. `run_worker_first` covers `/api/*`, `/webhooks/*`, `/health`, and `/ready`; navigation and other asset misses use SPA fallback.

Cloudflare Smart Placement may be enabled after measuring database latency. It is not part of correctness.

## 5. Repository shape

```text
apps/
  web/                  React SPA
  worker/               Hono entrypoint, routes, queue/scheduled handlers, DO
packages/
  db/                   Drizzle schema, migrations, database creation, and domain operations
```

There are no per-domain packages or microservices in V1. The Worker and
`packages/db` contain the glossary modules and keep provider-specific code at
the infrastructure boundary.

## 6. Module seams

### 6.1 Assignment module

All ownership mutation crosses one interface:

```ts
executeAssignment(
  tx: DbTransaction,
  command: AssignmentCommand,
): Promise<AssignmentResult>
```

`AssignmentCommand` is a discriminated union for:

- `AUTO_ROUTE`
- `TAKEOVER`
- `TRANSFER`
- `UNASSIGN`
- `AI_HANDOFF`
- `MEMBER_DISABLED`
- `CLOSE`

The module locks, rechecks policy, updates `conversation.assignee_member_id`, maintains queue fields and routing constraint, and inserts `conversation_assignment`. When the resulting assignee is AI and the Conversation has unanswered customer input (its latest customer Message is newer than its latest MEMBER outbound Message), the same transaction also ensures one QUEUED AIResponseRun and returns its ID for post-commit queue publication. No caller may issue an ownership `UPDATE` itself or separately reimplement this AI trigger.

### 6.2 AI module

The queue consumer exposes one application entry:

```ts
runAIResponse(runId: string, deps: AIRuntimeDependencies): Promise<void>
```

Retrieval, prompt construction, structured-output validation, handoff policy, and the final authorization/freshness transaction remain inside this module.

The required provider seams stay small:

```ts
interface EmbeddingProvider {
  embed(input: string[]): Promise<number[][]>
}

interface LlmProvider {
  generateResponse(input: AIResponseInput): Promise<AIResponseDecision>
}
```

The current implementation has one `AlibabaEmbeddingProvider` and one
`AlibabaLlmProvider` production adapter, with test fakes at the provider seams.

### 6.3 Channel module

Core flows consume normalized inbound messages and generic send results. Facebook-specific parsing, identifiers, permissions, OAuth, reply-window state, and errors remain under `channels/facebook`.

The Facebook adapter owns:

- signature verification;
- webhook normalization;
- Page connection and subscription;
- Page-token encryption/decryption;
- Messenger reply-window checks;
- Graph text sending; and
- redaction/classification of Meta failures.

### 6.4 Infrastructure seams

Use only the three thin interfaces already required by `../architecture/TECHNICAL_DECISIONS.md`:

- `JobQueue`
- `RealtimePublisher`
- `ObjectStorage`

Cloudflare implementations and test fakes satisfy them. Domain code receives these dependencies and never imports Worker bindings.

Do not add generic repositories. Domain modules use the typed Drizzle database handle, with explicit SQL where locking or partial indexes matter.

## 7. Database model

All primary keys are UUIDs generated by PostgreSQL. All times are `timestamptz`. Mutable tables have `created_at` and `updated_at`. Workspace-owned unique keys always include `workspace_id` unless a provider key is globally constrained deliberately.

### 7.1 Authentication and workspace

Better Auth owns `users`, `sessions`, `accounts`, and `verifications`. Its generated Drizzle schema is committed and changed only through generated migrations.

`workspace`

- `id`, `name`

`workspace_user_access`

- `id`, `workspace_id`, `user_id`
- `role`: `OWNER | ADMIN | AGENT`
- unique `(workspace_id, user_id)`

`workspace_invitation`

- `id`, `workspace_id`, `email`, `role`, `display_name`
- `token_hash`, `expires_at`, `accepted_at`, `created_by_user_id`
- only the hash is stored; the token is displayed once for manual sharing

Any authenticated user may create a workspace and becomes its OWNER. Additional users join only through an unexpired invitation matching their normalized login email. Email delivery, password reset, invitation reminders, ownership transfer, and multi-step invitation administration are deferred.

### 7.2 Members and access

`member`

- `id`, `workspace_id`
- `type`: `HUMAN | AI`
- `workspace_user_access_id` nullable and unique
- `display_name`, `avatar_url` nullable
- `status`: `ACTIVE | DISABLED`
- `auto_assignment_enabled`
- `max_active_conversations` with `CHECK >= 0`
- `last_auto_assigned_at` nullable
- check: HUMAN requires `workspace_user_access_id`; AI requires it to be null

`human_member_availability`

- `member_id` primary key
- `available` boolean

This separate row keeps temporary human availability out of the shared Member lifecycle. AI members have no availability row and no User.

`member_channel_access`

- `member_id`, `channel_id`
- primary key `(member_id, channel_id)`

Application commands verify both rows belong to the same workspace. PostgreSQL foreign keys protect existence; integration tests protect the cross-table workspace rule.

### 7.3 Channels and customers

`channel`

- `id`, `workspace_id`
- `provider`: V1 permits only `FACEBOOK_MESSENGER`
- `display_name`
- `status`: `ACTIVE | DISABLED`

`facebook_channel_config`

- `channel_id` primary key
- `page_id` unique
- `encrypted_page_access_token`, `token_iv`, `token_key_version`
- `connection_status`: `ACTIVE | ACTION_REQUIRED | DISABLED`
- `subscribed_at`, `last_checked_at`
- redacted `last_error_code`, `last_error_subcode`, `last_error_message`

`page_id` is globally unique in V1 because one Page webhook must resolve to exactly one Channel/workspace. Reconnecting the Page inside its current workspace updates that Channel. A different workspace attempting to connect it receives `FACEBOOK_PAGE_ALREADY_CONNECTED`; the response does not reveal the owning workspace and never updates its token or configuration.

`facebook_oauth_state`

- `id`, `workspace_id`, `initiated_by_user_id`, `state_hash`, `expires_at`, `used_at`

`customer`

- `id`, `workspace_id`
- `display_name`, `avatar_url` nullable

`channel_identity`

- `id`, `workspace_id`, `customer_id`, `channel_id`
- `external_user_id`
- unique `(channel_id, external_user_id)`

`facebook_messaging_window`

- `channel_identity_id` primary key
- `last_customer_message_at`, `eligible_until`

The core tables never call `external_user_id` a PSID. Page IDs, access tokens, and Messenger window data exist only in Facebook tables.

### 7.4 Conversations, assignments, and messages

`conversation`

- `id`, `workspace_id`, `channel_identity_id`
- `status`: `OPEN | CLOSED`
- `assignee_member_id` nullable
- `queue_reason` nullable: `NEW_CONVERSATION | AI_HANDOFF | MANUAL_UNASSIGN | MEMBER_DISABLED`
- `routing_constraint`: `ANY_MEMBER | HUMAN_ONLY`
- `routing_queued_at` nullable
- `latest_message_at`, `last_customer_message_at`, `last_outbound_message_at`, `last_customer_message_id` nullable
- `closed_at`, `closed_by_member_id` nullable

Checks:

- assigned implies `queue_reason` and `routing_queued_at` are null;
- unassigned OPEN implies both queue fields are non-null;
- OPEN implies close fields are null;
- CLOSED implies no assignee, no queue fields, `routing_constraint = ANY_MEMBER`, and both close fields are non-null.

A partial unique index on `channel_identity_id WHERE status = 'OPEN'` enforces one open conversation per identity.

`conversation_assignment`

- `id`, `conversation_id`
- `from_member_id`, `to_member_id` nullable
- `reason`: `AUTO_ROUTE | TAKEOVER | MANUAL_TRANSFER | MANUAL_UNASSIGN | AI_HANDOFF | MEMBER_DISABLED | CLOSE`
- `acting_member_id` nullable
- `created_at`

Initial assignment records `NULL -> member`. Queueing a new conversation with no eligible member does not create a history row because ownership did not change.

`message`

- `id`, `conversation_id`, `channel_id`
- `direction`: `INBOUND | OUTBOUND`
- `sender_type`: `CUSTOMER | MEMBER | EXTERNAL`
- `sender_member_id` nullable; required only for MEMBER
- `message_type`: `TEXT | ATTACHMENT`
- `text` nullable
- `external_message_id` nullable
- `provider_sent_at` nullable
- `delivery_state` nullable: `PENDING | SENT | FAILED`; required only for OUTBOUND
- `delivery_started_at`, `delivery_completed_at` nullable
- generic `failure_code`, `failure_message` nullable

Checks require text or at least one attachment at the application boundary, permit outbound text only, and enforce sender/member consistency. A partial unique index on `(channel_id, external_message_id)` where the external ID is not null is the durable Messenger idempotency key.

`message_attachment`

- `id`, `message_id`
- `kind`: `IMAGE | FILE | AUDIO | VIDEO`
- `filename`, `mime_type`, `byte_size` nullable
- `storage_key` nullable
- `storage_state`: `PENDING | READY | FAILED`
- generic `failure_code` nullable

`facebook_attachment_source`

- `attachment_id` primary key
- `encrypted_source_url`, `url_iv`, `token_key_version`
- `expires_at`

The documents consumer fetches the provider URL promptly, writes the private object to R2, and deletes the source row. Provider URLs never enter core attachment data or logs; an encrypted short-lived source row makes a failed queue delivery recoverable.

`facebook_delivery_attempt`

- `id`, `message_id`, `attempt_number`
- `http_status`, Meta `code`, `subcode`, `type`, redacted `message` nullable
- `started_at`, `completed_at`
- unique `(message_id, attempt_number)`

Meta-specific error semantics stay out of `message`.

`facebook_webhook_receipt`

- `id`, `ingress_id` unique, `page_id`, `external_message_id` nullable
- sanitized event fragment JSON, payload SHA-256, `received_at`, `processed_at`

This is provider diagnostic input, not a generic ConversationEvent timeline. Receipts are deleted after 30 days by maintenance.

### 7.5 AI configuration and runs

`ai_member_config`

- `member_id` primary key
- editable draft fields: instructions, response language, knowledge base, handoff booleans, normalized handoff keywords
- `published_snapshot` JSONB nullable
- `published_at` nullable
- `runtime_status`: `UNPUBLISHED | USABLE | UNHEALTHY`
- redacted `runtime_error` nullable

Publishing replaces the single snapshot atomically. No version-history table is created.

`ai_response_run`

- `id`, `conversation_id`, `member_id`
- `state`: `QUEUED | GENERATING | COMPLETED | HANDOFF | CANCELLED | FAILED`
- `input_first_message_id`, `input_last_message_id`
- `scheduled_for`, `started_at`, `completed_at` nullable
- `retrieved_chunk_ids` UUID array
- `cancellation_reason`: `OWNERSHIP_CHANGED | NEW_CUSTOMER_MESSAGE` nullable
- generic `failure_code`, redacted `failure_message` nullable

A partial unique index permits only one `QUEUED` or `GENERATING` run per conversation. A queue retry can therefore never start a second active generation.

### 7.6 Knowledge

`knowledge_base`

- `id`, `workspace_id`, `name`
- active vector metadata: `embedding_provider`, `embedding_model`, `embedding_dimensions`
  (nullable until the first complete index; legacy/unknown vectors are not searchable)

`knowledge_document`

- `id`, `workspace_id`, `knowledge_base_id`
- `name`, `source_type`: `TEXT | PDF | DOCX | TXT | MARKDOWN`
- `storage_key` nullable for uploaded files
- `status`: `UPLOADED | PROCESSING | READY | FAILED`
- `content_sha256`, `failure_code`, redacted `failure_message` nullable

`knowledge_chunk`

- `id`, `knowledge_document_id`, `knowledge_base_id`, `workspace_id`
- `ordinal`, `text`, `embedding vector(1536)`
- unique `(knowledge_document_id, ordinal)`
- HNSW cosine index on `embedding`

The worker inserts all chunks and marks the document READY in one short transaction after extraction and embeddings have succeeded. A processing failure leaves the document FAILED without partial chunks.

## 8. Locking and transaction rules

### 8.1 Lock order

Code uses these orders consistently:

- assignment commands: workspace row, conversation row, involved member rows ordered by UUID;
- inbound/close lifecycle: channel identity row, conversation row;
- AI commit: conversation row, AI run row;
- message delivery claim: message row.

No external HTTP, AI, R2, queue, or realtime call occurs inside a PostgreSQL transaction.

### 8.2 Auto-assignment

Auto-assignment takes a `FOR UPDATE` lock on the workspace row. This serializes automatic routing within one small V1 workspace, then rechecks the conversation and candidate loads in the same transaction.

Candidate eligibility is exactly the PRD policy. Load is the count of OPEN assigned conversations divided by `max_active_conversations`. Candidates at capacity or with zero capacity are excluded. Ordering is:

1. lowest numeric load ratio;
2. `last_auto_assigned_at NULLS FIRST`;
3. member UUID for deterministic final ties.

`ANY_MEMBER` tries eligible AI first, then eligible HUMAN. `HUMAN_ONLY` tries HUMAN only. A successful assignment clears queue fields, updates `last_auto_assigned_at`, and writes history. Assignment to AI with unanswered customer input atomically ensures the AIResponseRun before commit; queue publication occurs afterward and is recoverable from the QUEUED row. Assignment with no unanswered input does not initiate proactive outbound messaging.

This workspace lock is the deliberate V1 throughput ceiling; replace it with per-candidate locking only if measured routing contention matters.

### 8.3 Close versus inbound

Inbound processing and close both lock the ChannelIdentity before resolving its OPEN conversation.

- If inbound commits first, the message belongs to the existing conversation and close follows it.
- If close commits first, the inbound message creates a new OPEN conversation.

The partial unique index is the final protection against two OPEN conversations.

### 8.4 Takeover versus AI commit

Both transactions lock the Conversation.

- Takeover first: assignee changes to the human; AI commit recheck cancels the run with `OWNERSHIP_CHANGED` and inserts no outbound message.
- AI commit first: it inserts a valid PENDING message and commits the run; later takeover does not invalidate the committed message.

### 8.5 Customer freshness

Every unique inbound customer message updates `last_customer_message_id` while holding the Conversation lock. AI commit compares that ID with `ai_response_run.input_last_message_id`.

If different, the run becomes CANCELLED with `NEW_CUSTOMER_MESSAGE`, no outbound message is inserted, and one fresh run is scheduled after commit.

## 9. Authentication and authorization

Better Auth handles credential hashing, sessions, cookies, and auth endpoints. The Hono application derives the User from the session, then requires an explicit workspace access row for every protected route.

The React client sends the active workspace ID on protected API requests. The backend never trusts it without membership lookup. A minimal workspace switcher appears only when a User has multiple accesses.

Permissions:

| Action | OWNER | ADMIN | AGENT |
| --- | --- | --- | --- |
| Manage Facebook channels | yes | yes | no |
| Manage human/AI members and access | yes | yes | no |
| Manage AI configuration and knowledge | yes | yes | no |
| View fixed inbox views and conversations | yes | yes | yes |
| Take over unassigned or AI-owned conversation | yes | yes | yes |
| Reply | when own HUMAN member is assignee | same | same |
| Transfer/unassign/close | any conversation | any conversation | own conversation |
| Disable OWNER member/access | no | no | no |

Every WorkspaceUserAccess has exactly one HUMAN Member in that workspace. OWNER/ADMIN actions still act as that human Member when changing a conversation.

## 10. End-to-end workflows

### 10.1 Workspace and human onboarding

1. User signs up or signs in through `/login`.
2. A user with no access creates a workspace; one transaction creates OWNER access and its HUMAN Member.
3. OWNER/ADMIN creates an invitation with role and human settings.
4. The UI displays a one-time invite URL for manual sharing.
5. The matching authenticated email accepts it; one transaction creates WorkspaceUserAccess, HUMAN Member, availability, and selected channel access.

### 10.2 Facebook Page connection

1. OWNER/ADMIN starts OAuth from `/settings/facebook`.
2. Backend stores a short-lived hashed state tied to User and workspace.
3. Callback validates and consumes state, exchanges the code, and fetches Pages available to the user.
4. User selects one or more Pages.
5. Backend obtains Page tokens, rejects a Page already owned by another workspace without disclosing that workspace, subscribes accepted Pages to `messages`, encrypts tokens with AES-GCM using `TOKEN_ENCRYPTION_KEY`, and creates or reconnects only the current workspace's Channel/config rows.
6. Settings shows subscription and token health. A permission/token error marks `ACTION_REQUIRED` and offers reconnect.

Required permissions are `pages_messaging`, the Page `MESSAGE` task, `pages_manage_metadata` for API subscription, and `pages_show_list` for Page selection, matching M0 findings.

### 10.3 Webhook ingress

1. GET verification fails closed when the verify token is absent or wrong.
2. POST reads raw bytes and verifies `X-Hub-Signature-256` with Web Crypto before JSON parsing.
3. Facebook adapter validates only Page message events, ignores echoes, and normalizes text/attachments.
4. It sends one small queue message per normalized event. The Worker returns `200 EVENT_RECEIVED` only after queue publication succeeds; otherwise it returns a retryable 5xx.
5. The webhook consumer stores a receipt, resolves the Channel and ChannelIdentity, and locks the identity.
6. In one transaction it inserts the inbound Message using `(channel_id, mid)` idempotency, finds or creates the OPEN Conversation, updates latest/customer message fields and Messenger-window state, and queues a new conversation with `NEW_CONVERSATION` when applicable.
7. If the Conversation was already AI-owned, the inbound transaction ensures its debounced AI run. If it was newly created and unassigned, the later auto-assignment transaction creates the run when it assigns AI. After commit, the relevant run/routing, attachment, and realtime jobs are published; recovery scans cover failed publication.

Unknown Pages and unsupported non-message webhook events are acknowledged and logged without domain mutation.

### 10.4 Human reply and delivery

1. Only the currently assigned HUMAN Member may reply.
2. The command locks the Conversation, rechecks OPEN ownership, and asks the Facebook adapter whether the stored window permits normal RESPONSE messaging.
3. If closed, return `409 REPLY_WINDOW_CLOSED`; do not create a Message.
4. Otherwise insert an outbound text Message as PENDING and commit.
5. Publish its ID to `outbound`; realtime shows PENDING immediately.
6. Consumer atomically claims a PENDING message by setting `delivery_started_at`, rechecks the reply window, then calls Graph Send API with `messaging_type: RESPONSE`.
7. Success records the Meta message ID and changes state to SENT. A definite rejection or ambiguous network failure changes state to FAILED and remains visible.

Queue duplicates see `delivery_started_at` or a terminal state and do not resend. If a Worker dies after claiming, recovery marks the message FAILED with `AMBIGUOUS_DELIVERY` rather than risking an automatic duplicate. A manual retry UI is not included in V1.

### 10.5 Conversation ownership and lifecycle

- `TAKEOVER`: an active HUMAN with channel access takes an unassigned or AI-owned OPEN conversation. Capacity and availability may be overridden with a warning.
- `TRANSFER`: current human owner, ADMIN, or OWNER chooses an eligible target. Manual capacity/availability overrides require confirmation. Disabled, inaccessible, unpublished, or unhealthy targets are rejected.
- Human -> AI explicitly resets `HUMAN_ONLY` to `ANY_MEMBER`.
- `UNASSIGN`: sets `MANUAL_UNASSIGN`, preserves routing constraint, and queues recovery routing.
- disabling a Member unassigns all its OPEN conversations through `MEMBER_DISABLED`; HUMAN_ONLY persists.
- `CLOSE`: clears assignment/queue fields, resets routing constraint to ANY_MEMBER, and records closer/time. It records `from -> NULL` assignment history only when an assignee actually changed.

### 10.6 Knowledge ingestion and retrieval

1. OWNER/ADMIN creates a KnowledgeBase and submits inline text or a PDF/DOCX/TXT/Markdown file up to 10 MiB.
2. Backend validates declared type, extension, and file signature where available; uploads private content to R2; creates UPLOADED document; queues processing.
3. Consumer claims the document, extracts plain text, normalizes line endings/control characters, and rejects empty/scanned-only content as FAILED.
4. Text is split on paragraph boundaries into at most 2,000 Unicode code points with 200-code-point overlap.
5. `AlibabaEmbeddingProvider` embeds batches with `model=qwen3.7-text-embedding`
   and `dimensions=1536`; every response count and vector dimension is validated.
6. A short transaction replaces chunks, records matching active embedding metadata,
   and marks READY. Any failure leaves no partial chunks or READY state.
7. Retrieval verifies the query provider/model/dimensions against the active
   KnowledgeBase metadata, embeds the customer query with the same provider, and
   selects up to 6 chunks by cosine distance.

`AI_RETRIEVAL_MAX_DISTANCE`, default `0.35`, is an environment calibration value. The character chunker is the deliberate V1 ceiling; add OCR or token-aware/layout-aware chunking only after real documents demonstrate a failure.

### 10.7 AI Draft -> Publish

1. AI Member edit screen reads/writes only draft fields.
2. Publish validates active Member, channel access, instructions, response language, selected KnowledgeBase, and provider configuration.
3. It copies the draft into one immutable JSON snapshot, stamps `published_at`, and sets `runtime_status = USABLE`.
4. Changes after publish do not affect runtime until the next publish.
5. Permanent provider/configuration failures set UNHEALTHY; transient generation failures do not permanently disable the member.

### 10.8 AI debounce and response

1. The transaction that receives input for an AI-owned Conversation, or changes a Conversation's assignee to AI while unanswered customer input exists, ensures one QUEUED run. This includes initial auto-assignment and explicit Human -> AI transfer after the triggering customer message already exists, without initiating a reply when the latest customer input was already answered. If a QUEUED run exists, its `input_last_message_id` and `scheduled_for = now + 2 seconds` are updated.
2. A queue delivery before `scheduled_for` retries with the remaining delay.
3. Consumer locks and changes the run to GENERATING, captures the contiguous inbound range since the latest member outbound message, then releases the transaction.
4. It retrieves knowledge and calls the AI adapter outside a transaction.
5. AI output must match a Zod-validated decision: `ANSWER | HANDOFF`, response text, detected handoff reason, whether business facts are present, and used chunk IDs.
6. For ANSWER containing business facts, used chunk IDs must be a non-empty subset of retrieved chunks. Otherwise the application either converts the result to HANDOFF when `handoff-on-no-knowledge` is enabled, or replaces it with a localized factual-free uncertainty response.
7. Final commit locks the Conversation and run and enforces current AI ownership plus last-customer-message equality.
8. A valid ANSWER inserts one PENDING MEMBER outbound message and completes the run. Delivery is queued after commit.

The prompt may answer ordinary greetings without knowledge, but any product, price, delivery, return, support-policy, or other company-specific fact must be grounded.

### 10.9 AI handoff

Configured customer-request and keyword triggers are checked before generation. The structured AI decision reports insufficient knowledge, negative sentiment, and inability to answer; the published handoff booleans decide whether each detected condition hands off or returns a safe factual-free fallback. Attachment-only unsupported input and permanent AI runtime failure always hand off.

In one transaction:

1. optionally insert a customer-facing transfer text as PENDING;
2. execute `AI_HANDOFF` through the assignment module;
3. change AI -> NULL and write history;
4. set `routing_constraint = HUMAN_ONLY`, `queue_reason = AI_HANDOFF`, and queue time;
5. finish the AI run as HANDOFF or FAILED, as appropriate.

After commit, outbound delivery and human-only auto-assignment are published independently. Either may fail without blocking the other; recovery scans retry unscheduled durable state.

### 10.10 Realtime

Clients authenticate before WebSocket upgrade. The Worker routes them to the workspace Durable Object and attaches User/workspace identifiers to the hibernating socket.

Realtime payloads contain only:

```ts
type RealtimeEvent = {
  type: 'conversation.changed' | 'message.changed' | 'member.changed' | 'knowledge.changed'
  entityId: string
}
```

Clients refetch relevant API data. They also refetch on window focus, WebSocket reconnect, and every 30 seconds while the inbox is visible. The Durable Object stores no canonical business state.

## 11. HTTP interface

All protected application routes are under `/api`. JSON uses camelCase. List endpoints use opaque cursor pagination. Errors use `{ error: { code, message, details? } }`; clients branch on stable `code`, never English text.

### Auth/workspace

- Better Auth: `/api/auth/*`
- `GET /api/me`
- `POST /api/workspaces`
- `GET /api/workspaces/:workspaceId`
- `POST /api/workspaces/:workspaceId/invitations`
- `POST /api/invitations/:token/accept`

### Members

- `GET /api/workspaces/:workspaceId/members`
- `POST /api/workspaces/:workspaceId/members/ai`
- `PATCH /api/workspaces/:workspaceId/members/:memberId`
- `PUT /api/workspaces/:workspaceId/members/:memberId/channels`
- `PUT /api/workspaces/:workspaceId/members/:memberId/availability`

### Facebook channels

- `GET /api/workspaces/:workspaceId/channels`
- `POST /api/workspaces/:workspaceId/facebook/oauth/start`
- `GET /api/facebook/oauth/callback`
- `POST /api/workspaces/:workspaceId/facebook/oauth/:stateId/pages`
- `POST /api/workspaces/:workspaceId/channels/:channelId/recheck`
- `POST /api/workspaces/:workspaceId/channels/:channelId/disable`
- public `GET|POST /webhooks/facebook`

### Inbox

- `GET /api/workspaces/:workspaceId/conversations?view=my|waiting-human|ai-handling|unassigned|all-open&cursor=`
- `GET /api/workspaces/:workspaceId/conversations/:conversationId`
- `GET /api/workspaces/:workspaceId/conversations/:conversationId/messages?cursor=`
- `POST /api/workspaces/:workspaceId/conversations/:conversationId/replies`
- `POST /api/workspaces/:workspaceId/conversations/:conversationId/takeover`
- `POST /api/workspaces/:workspaceId/conversations/:conversationId/transfer`
- `POST /api/workspaces/:workspaceId/conversations/:conversationId/unassign`
- `POST /api/workspaces/:workspaceId/conversations/:conversationId/close`
- `GET /api/workspaces/:workspaceId/attachments/:attachmentId`

### AI and knowledge

- `GET|PATCH /api/workspaces/:workspaceId/ai-members/:memberId/config`
- `POST /api/workspaces/:workspaceId/ai-members/:memberId/publish`
- `GET|POST /api/workspaces/:workspaceId/knowledge-bases`
- `GET /api/workspaces/:workspaceId/knowledge-bases/:knowledgeBaseId/documents`
- `POST /api/workspaces/:workspaceId/knowledge-bases/:knowledgeBaseId/documents/text`
- `POST /api/workspaces/:workspaceId/knowledge-bases/:knowledgeBaseId/documents/upload`
- `DELETE /api/workspaces/:workspaceId/knowledge-bases/:knowledgeBaseId/documents/:documentId`

### Realtime/health

- `GET /api/workspaces/:workspaceId/realtime` with WebSocket upgrade
- `GET /health` checks process health only
- `GET /ready` checks one cache-disabled database query and binding presence

## 12. UI contract

The default interface language is Simplified Chinese. All user-facing copy must
be in Chinese, including navigation, headings, buttons, form labels, statuses,
loading and empty states, errors, confirmation prompts, page titles, and
accessible labels. Product and platform names such as DeepSales, Facebook,
Messenger, and AI retain their official spelling; API paths, field names, enum
values, and code identifiers remain unchanged.

### `/login`

Sign in, sign up, invitation acceptance, and workspace creation. No social login or password-reset UI in V1.

### `/inbox`

Desktop-first three-pane layout:

- fixed view selector: My Conversations, Waiting for Human, AI Handling, Unassigned, All Open;
- conversation list with customer/channel, latest preview/time, assignee, queue indicator, and failed-message indicator;
- thread with inbound attachments, PENDING/SENT/FAILED outbound state, AI generating indicator, and reply-window status;
- actions: takeover, reply, transfer, unassign, close.

Views are query filters, never status values. Mobile may stack panes but retains keyboard and screen-reader access. Failed messages and expired reply windows use text/icon labels, not color alone.

### `/team`

List HUMAN and AI Members together with type badges. OWNER/ADMIN can create, enable/disable, set channel access, auto-assignment, capacity, and human availability. It also creates/copies basic invitation links.

### `/ai-member/:id`

Edit the frozen AI fields, show draft/published state and runtime health, and publish. No version history, evidence UI, tools, or external-agent configuration.

### `/knowledge`

Create/select KnowledgeBases, add inline text or allowed files, and show UPLOADED/PROCESSING/READY/FAILED. Deleting a document removes its chunks and R2 object. No document editor, OCR, or chunk UI.

### `/settings/facebook`

Connect/select Pages, list connected Channels, show subscription/token health, recheck, reconnect, or disable. Secrets and PSIDs are never displayed.

## 13. Queue contracts and recovery

Every payload is Zod-validated, versioned with `v: 1`, and contains identifiers rather than whole domain objects.

| Queue | Payload purpose | Durable idempotency |
| --- | --- | --- |
| `webhooks` | normalized Facebook event and diagnostic fragment | message unique `(channel_id, mid)` |
| `outbound` | deliver `messageId` | conditional message claim |
| `ai` | execute `runId` | run state + active-run partial unique index |
| `documents` | process knowledge document or fetch inbound attachment | document/attachment state claim |
| `maintenance` | route one queued conversation or repair one durable record | locked current state recheck |

Consumers acknowledge only after terminal or safely persisted state. Retryable infrastructure failures use Queue retry; validation/permanent failures persist FAILED and acknowledge. All queues use bounded retries and a shared DLQ.

The scheduled handler runs once per minute and enqueues bounded batches for:

- OPEN unassigned conversations still needing routing;
- PENDING outbound messages never claimed;
- claimed PENDING messages older than five minutes, marked FAILED `AMBIGUOUS_DELIVERY`;
- QUEUED AI runs not enqueued;
- GENERATING AI runs older than five minutes, failed and handed off;
- UPLOADED/PROCESSING documents or PENDING attachments with an unexpired encrypted source needing repair; and
- webhook receipts older than 30 days for deletion.

The scan uses indexed timestamps, a fixed batch limit of 100 per category, and `FOR UPDATE SKIP LOCKED`. There is no generic outbox table; the domain state is already the recoverable work ledger.

## 14. Security and privacy

- Verify webhook HMAC against raw bytes before parsing; fail closed on missing secret.
- Store Worker secrets only as Cloudflare secrets; local secrets remain in ignored `.dev.vars`.
- Encrypt Page tokens with AES-256-GCM. Store a key version so planned rotation can decrypt old rows; V1 ships one active key and no rotation UI.
- Never log tokens, App Secret, verify token, OAuth codes/state, PSIDs, inbound text, AI prompts, knowledge text, or raw attachment URLs.
- Structured logs use workspace/channel/conversation/message IDs and redacted provider errors.
- Validate workspace authorization on every database read/write, including attachment download and WebSocket upgrade.
- Keep R2 private and serve objects only through authenticated Worker routes with safe `Content-Disposition`.
- Limit documents to 10 MiB and inbound attachment fetches to 25 MiB; stream where possible and abort oversized downloads.
- Treat extracted document text and customer content as untrusted prompt data. Delimit it from system instructions and tell the model never to follow instructions found in retrieved content.
- Use same-origin secure, HttpOnly, SameSite=Lax session cookies and Better Auth trusted origins.
- Apply simple Worker rate limits to login, OAuth start/callback, upload, outbound reply, and AI-triggering commands.

## 15. Test contract

### Unit/contract tests

- authorization matrix;
- Facebook signature and normalization, including attachments and echoes;
- queue payload schemas;
- AI structured output and grounding guard;
- document normalization/chunking;
- Meta error redaction/classification.

### PostgreSQL integration tests

These run against a real PostgreSQL instance with pgvector and migrations:

- one OPEN conversation under concurrent inbound events;
- one Facebook Page cannot be attached to or reconfigured by two workspaces;
- duplicate `mid` creates one Message and no duplicate downstream work;
- AI-first, human fallback, load ratio, tie-break, capacity, availability, and channel access;
- concurrent assignment does not exceed capacity;
- every assignment or explicit transfer to AI creates exactly one active AIResponseRun for unanswered customer input and none for already-answered history;
- every ownership change writes exactly one history record;
- HUMAN_ONLY persists through human assignment and resets only on close or explicit Human -> AI transfer;
- takeover wins before AI commit;
- valid AI commit remains deliverable before later takeover;
- new customer message cancels stale AI commit and schedules one fresh run;
- duplicate outbound queue delivery performs at most one Graph call;
- close/inbound races resolve to one valid lifecycle;
- failed delivery remains visible and is never marked SENT;
- document chunk replacement is atomic.

### Playwright

Using fake AI/Facebook infrastructure adapters and real Hono/PostgreSQL:

- login/workspace bootstrap;
- connect a fake Page and receive a message into each relevant inbox view;
- human takeover/reply/FAILED state;
- team configuration and transfer;
- knowledge upload to READY and AI publish;
- grounded AI answer;
- AI handoff to waiting-human and human reply;
- close then later inbound creates a new conversation.

### Live release checks

Before production sign-off, run the PRD's seven release flows with a real Facebook Page and user. Add a forced invalid-token check and an observed duplicate webhook replay using the same `mid`. The still-unobserved expired-window Meta error is recorded, but local enforcement plus visible Graph failure is the V1 acceptance behavior.

Every ticket must pass:

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm test:e2e --if-present
```

## 16. Configuration and deployment

Required non-secret configuration:

- `APP_URL`
- `META_APP_ID`
- `META_GRAPH_API_VERSION=v26.0`
- `AI_BASE_URL` (Alibaba Cloud International Model Studio region/workspace-compatible base URL)
- `EMBEDDING_PROVIDER=alibaba`
- `EMBEDDING_MODEL=qwen3.7-text-embedding`
- `EMBEDDING_DIMENSIONS=1536`
- `LLM_PROVIDER=alibaba`
- `LLM_MODEL=qwen3.8-flash`
- `AI_RETRIEVAL_MAX_DISTANCE=0.35`
- `AI_DEBOUNCE_SECONDS=2`

Required secrets:

- `BETTER_AUTH_SECRET`
- `META_APP_SECRET`
- `META_VERIFY_TOKEN`
- `TOKEN_ENCRYPTION_KEY`
- `AI_API_KEY`
- `DATABASE_URL` and `DATABASE_URL_UNPOOLED` only in migration/CI environments

Required bindings:

- `HYPERDRIVE`
- five Queue producers/consumers and `JOBS_DLQ`
- private `OBJECTS` R2 bucket
- `WORKSPACE_REALTIME` Durable Object namespace
- rate-limit bindings for protected write paths

Deployment order:

1. provision Neon PostgreSQL and enable `vector`;
2. apply committed Drizzle migrations through the direct database URL;
3. provision R2, Queues/DLQ, Hyperdrive, and Durable Object namespace;
4. set secrets and deploy the Worker plus static assets;
5. configure Meta callback URL and subscription;
6. run `/ready`, queue smoke tests, and live release checks.

Migration rollback is forward-fix for V1. Destructive migrations require a backup and an explicit operator step; application deploys never run migrations automatically.

## 17. Explicitly skipped

The following are intentionally absent: comments, historical import, non-Messenger providers, CRM, campaigns, analytics, custom roles, advanced routing, AI version history/rollback, AI evidence UI, ConversationEvent, full invitation/email flows, presence, human outbound media, Business Suite echo sync, advanced read state, external AI agents, AI tools/actions, multi-agent collaboration, OCR, manual delivery retry, and dual-runtime adapters.

They are added only through a post-V1 decision or when a measured V1 blocker requires one.

## 18. Invariant traceability

| Frozen invariant | Implemented by |
| --- | --- |
| INV-01 Member First-Class | Member schema, unified team UI, generic assignee/sender foreign keys |
| INV-02 User / Member Separation | Better Auth User -> WorkspaceUserAccess -> HUMAN Member |
| INV-03 Authentication != Service Identity | AI Members have no access/User/account |
| INV-04 AI Response Commit Authorization | Conversation lock and current-assignee recheck at AI commit |
| INV-05 AI Input Freshness | last-customer-message recheck and fresh-run scheduling |
| INV-06 Grounded Business Answer | retrieved-chunk subset guard plus safe fallback/handoff |
| INV-07 Assignment Policy, Not Identity Split | one Member candidate query and type-priority policy |
| INV-08 Assignment Gateway | single `executeAssignment` interface and mandatory history insert |
| INV-09 Human Handoff Persistence | HUMAN_ONLY transition/reset rules and integration tests |
| INV-10 Channel-Specific Logic Isolation | Facebook adapter tables/module and generic core fields |
| INV-11 Queue Semantics | Conversation checks and assignment transition behavior |
| INV-12 Committed Message Independence | PENDING message delivery claim independent of later ownership |
| INV-13 PostgreSQL Is the Source of Truth | constraints, locks, short transactions, recoverable durable rows |
| INV-14 One Open Conversation Per Channel Identity | partial unique index plus lifecycle lock |
| INV-15 Webhook Idempotency | unique `(channel_id, external_message_id)` |
| INV-16 Thin Infrastructure Adapters | JobQueue, RealtimePublisher, and ObjectStorage seams |
| INV-17 V1 Scope Discipline | explicit skipped list and ticket acceptance exclusions |
