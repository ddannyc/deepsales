# Lean V1 implementation tickets

Status: **Ready-to-publish drafts**  
Source: `V1_IMPLEMENTATION_SPEC.md`  
Publication: no Git remote or configured project issue tracker is present in this repository, so issue bodies are retained here without inventing a destination or labels.

## Story map

- `US-01` — A user can authenticate, create or join a workspace, and reach the application.
- `US-02` — An OWNER/ADMIN can configure human and AI Members, access, availability, and capacity.
- `US-03` — An OWNER/ADMIN can connect Facebook Pages and see connection health.
- `US-04` — A Messenger message appears exactly once in the shared inbox.
- `US-05` — A human can take over and send a reply with visible delivery state.
- `US-06` — Conversations route AI-first with human fallback without exceeding capacity.
- `US-07` — Knowledge documents become searchable grounded context.
- `US-08` — A published AI Member can answer safely after debounce.
- `US-09` — AI hands off and never replies after losing ownership or input freshness.
- `US-10` — A human can transfer, unassign, disable ownership, and close; later inbound creates a new conversation.
- `US-11` — Realtime loss, queue duplicates, process failure, and provider failure do not corrupt canonical state.

## Proposed breakdown

1. **T01 — Ship the authenticated workspace walking skeleton**  
   Blocked by: none  
   User stories: US-01, US-11
2. **T02 — Invite and configure the human team**  
   Blocked by: T01  
   User stories: US-01, US-02
3. **T03 — Connect and monitor Facebook Pages**  
   Blocked by: T01  
   User stories: US-03
4. **T04 — Receive Messenger text into the realtime inbox**  
   Blocked by: T01, T03  
   User stories: US-04, US-11
5. **T05 — Take over and deliver a human text reply**  
   Blocked by: T02, T04  
   User stories: US-05, US-11
6. **T06 — Transfer, unassign, disable, and close conversations**  
   Blocked by: T05  
   User stories: US-02, US-10
7. **T07 — Persist and display inbound Messenger attachments**  
   Blocked by: T04  
   User stories: US-04
8. **T08 — Index inline knowledge in pgvector**  
   Blocked by: T01  
   User stories: US-07
9. **T09 — Add file ingestion to the KnowledgeBase**  
   Blocked by: T08  
   User stories: US-07
10. **T10 — Configure and publish an AI Member**  
   Blocked by: T02, T03, T08  
   User stories: US-02, US-08
11. **T11 — Route conversations AI-first with human fallback**  
    Blocked by: T04, T10  
    User stories: US-06
12. **T12 — Send one grounded AI response end to end**  
    Blocked by: T05, T08, T11  
    User stories: US-07, US-08
13. **T13 — Enforce AI debounce, freshness, and takeover races**  
    Blocked by: T12  
    User stories: US-08, US-09, US-11
14. **T14 — Hand AI conversations off to humans safely**  
    Blocked by: T06, T13  
    User stories: US-09, US-10
15. **T15 — Recover durable work and harden production**  
    Blocked by: T01–T14  
    User stories: US-11
16. **T16 — Pass the live V1 release gate**  
    Blocked by: T01–T15  
    User stories: US-01–US-11

The slices are intentionally ordered so T05 produces the first real customer-to-human round trip before AI work begins. Inline knowledge enables AI work without waiting for every file parser, and production hardening is complete before live release verification. Each ticket is demoable and owns its schema, backend, UI, queue/realtime behavior, and executable tests where those layers are relevant.

---

## T01 — Ship the authenticated workspace walking skeleton

## What to build

Turn the M0-only repository into the smallest deployable V1 application: one React SPA and Hono Worker deployment, PostgreSQL/Drizzle connectivity through Hyperdrive, Better Auth email/password sessions, workspace creation, and the authenticated application shell. Preserve the M0 webhook route while later tickets replace its fixed-reply behavior.

The first authenticated user can create a workspace and becomes both its OWNER WorkspaceUserAccess and HUMAN Member in one transaction. Users without a workspace see the creation flow; users with access reach the shell.

## Acceptance criteria

- [ ] The workspace has repeatable install, build, typecheck, lint, unit, integration, and optional E2E commands.
- [ ] A committed Drizzle migration enables pgvector and creates Better Auth, workspace, access, and Member foundations from the implementation spec.
- [ ] The Worker connects through a cache-disabled Hyperdrive binding using Drizzle and `pg`; migration tooling uses only the direct `DATABASE_URL`.
- [ ] A user can sign up, sign in, sign out, and create a workspace from `/login`.
- [ ] Workspace creation atomically creates OWNER access and its HUMAN Member; retrying the request cannot create duplicates.
- [ ] Protected API routes and the application shell reject missing sessions and workspace access.
- [ ] The React SPA and Worker deploy together with `/api/*`, `/webhooks/*`, `/health`, and `/ready` invoking the Worker and navigation using SPA fallback.
- [ ] `/health` reports process health and `/ready` detects missing bindings or database failure without exposing secrets.
- [ ] Integration tests exercise the real PostgreSQL migration and workspace bootstrap transaction.
- [ ] A Playwright check covers sign-up/login, workspace creation, shell load, and sign-out.

## Blocked by

None — can start immediately.

---

## T02 — Invite and configure the human team

## What to build

Deliver the `/team` slice for human onboarding and Member configuration. OWNER/ADMIN creates a short-lived invitation, copies the one-time link, and the matching authenticated email accepts it. Acceptance creates WorkspaceUserAccess, HUMAN Member, and availability together. The team page lists HUMAN and AI Members as the same core entity and lets authorized users manage human role, lifecycle, availability, auto-assignment, capacity, and currently available channel access.

AI Member creation in this slice creates only the shared Member identity in an UNPUBLISHED state; configuration arrives in T10.

## Acceptance criteria

- [ ] OWNER/ADMIN can create a hashed, expiring invitation and copy the plaintext token exactly once; no email subsystem is added.
- [ ] Only the invited normalized email can accept, and concurrent/repeated acceptance creates one access and one HUMAN Member.
- [ ] Every WorkspaceUserAccess has one HUMAN Member; AI Members have no User or login account.
- [ ] `/team` lists HUMAN and AI together with type, lifecycle, availability where applicable, auto-assignment, capacity, and channel access.
- [ ] OWNER/ADMIN can create an AI Member and edit allowed Member fields without AI-specific ownership foreign keys.
- [ ] OWNER/ADMIN can grant or revoke MemberChannelAccess only for Channels in the same workspace.
- [ ] An ADMIN cannot disable, demote, or remove the OWNER access/Member.
- [ ] AGENT cannot manage members, access, roles, or invitations.
- [ ] Authorization and invitation races have PostgreSQL integration tests; the main invitation and team-edit flow has a Playwright check.

## Blocked by

- T01

---

## T03 — Connect and monitor Facebook Pages

## What to build

Deliver `/settings/facebook` from OAuth start through Page selection and webhook subscription. Store Facebook state only in adapter tables, encrypt Page access tokens, and expose redacted connection health. Reconnect replaces an invalid token; disable stops future intake without deleting conversation history.

## Acceptance criteria

- [ ] OWNER/ADMIN can start OAuth with a single-use, hashed, expiring state tied to the initiating User and workspace.
- [ ] The callback rejects missing, expired, reused, or mismatched state and never logs OAuth codes or tokens.
- [ ] The Page picker requests only the permissions established by M0 and creates one generic Channel per selected Page.
- [ ] The backend subscribes each selected Page to `messages`, encrypts its Page token with AES-GCM, and never returns the token to the browser.
- [ ] Reconnecting the same Page inside its current workspace updates that Channel/config instead of creating a duplicate.
- [ ] A global Page-ID uniqueness constraint makes concurrent cross-workspace connection attempts deterministic; the losing workspace receives `FACEBOOK_PAGE_ALREADY_CONNECTED` without learning or changing the owning workspace.
- [ ] `/settings/facebook` shows connected Page name, ACTIVE/ACTION_REQUIRED/DISABLED state, last check, and redacted failure.
- [ ] A recheck detects token/permission failure and marks ACTION_REQUIRED; disabling a Channel stops new inbound processing.
- [ ] AGENT cannot connect, recheck, reconnect, or disable a Page.
- [ ] Provider calls are tested through the Facebook adapter seam, including Page selection, subscription failure, token encryption, redaction, and idempotent reconnect.
- [ ] The flow is manually verified against the M0 test Page before completion.

## Blocked by

- T01

---

## T04 — Receive Messenger text into the realtime inbox

## What to build

Replace the M0 fixed reply with the durable inbound text path. Verify and normalize the webhook, publish compact events, process them idempotently into Customer, ChannelIdentity, one OPEN Conversation, and one inbound Message, then display the conversation in `/inbox`. Add fixed inbox views and workspace realtime invalidation, with PostgreSQL remaining canonical.

New conversations remain unassigned with `NEW_CONVERSATION` until routing is delivered in T11.

## Acceptance criteria

- [ ] GET verification fails closed and POST verifies the raw-body HMAC before parsing.
- [ ] Valid Page text events are queued before `200 EVENT_RECEIVED`; enqueue failure returns a retryable 5xx; echoes and unknown/disabled Pages create no domain data.
- [ ] The consumer stores a sanitized Facebook receipt and maps Page ID, external user ID, `mid`, text, and provider timestamp according to M0 findings.
- [ ] Duplicate or concurrently delivered copies of one `mid` create exactly one Message and one set of downstream work.
- [ ] Concurrent first messages for one ChannelIdentity result in at most one OPEN Conversation through locking plus the partial unique index.
- [ ] A new OPEN Conversation is unassigned with `queue_reason = NEW_CONVERSATION`, `routing_constraint = ANY_MEMBER`, and a queue timestamp.
- [ ] The Messenger reply-window adapter state is updated outside the core Conversation model.
- [ ] `/inbox` provides My Conversations, Waiting for Human, AI Handling, Unassigned, and All Open as query views rather than statuses.
- [ ] Conversation list/detail and paginated message APIs scope every query to authorized workspace access.
- [ ] One hibernating Durable Object per workspace broadcasts identifier-only invalidations; losing the socket does not prevent refetch/poll recovery.
- [ ] PostgreSQL integration tests cover `mid` dedupe and open-conversation concurrency; Playwright shows a fake inbound message without reloading.

## Blocked by

- T01
- T03

---

## T05 — Take over and deliver a human text reply

## What to build

Complete the first production-shaped round trip: a HUMAN Member takes an unassigned conversation, writes a text reply as PENDING, and the outbound queue sends it through the Facebook adapter. The thread updates to SENT or visibly FAILED. Enforce the Messenger reply window before commit and again before delivery.

## Acceptance criteria

- [ ] An ACTIVE human with channel access can take over an unassigned OPEN conversation through the single assignment interface.
- [ ] Takeover writes exactly one ConversationAssignment and clears queue fields; repeated/concurrent commands have one deterministic winner.
- [ ] Only the current HUMAN assignee may reply; empty/oversized/non-text outbound payloads are rejected.
- [ ] A closed Messenger window returns `REPLY_WINDOW_CLOSED` before Message creation and is visibly disabled in the UI.
- [ ] A valid reply commits as PENDING before queue publication and appears immediately in the thread.
- [ ] The outbound consumer atomically claims once, sends `messaging_type: RESPONSE`, and records SENT plus the external message ID on success.
- [ ] Meta rejection or ambiguous network failure records FAILED and a redacted adapter attempt; it is never shown as SENT.
- [ ] Duplicate queue delivery performs at most one Graph call. A claim abandoned for five minutes becomes FAILED `AMBIGUOUS_DELIVERY` instead of being resent.
- [ ] Subsequent assignment changes do not cancel an already validly committed PENDING message.
- [ ] Integration tests cover takeover contention, reply authorization, message claim dedupe, and committed-message independence.
- [ ] Playwright covers take over -> reply -> PENDING -> SENT and FAILED display through a fake Facebook adapter.

## Blocked by

- T02
- T04

---

## T06 — Transfer, unassign, disable, and close conversations

## What to build

Finish human ownership and Conversation lifecycle controls that do not require a published AI runtime. Users can transfer to another HUMAN, unassign, and close within the frozen permission rules; disabling a Member requeues its OPEN work. A later inbound message after close creates a new Conversation for the same ChannelIdentity. Human -> AI transfer is delivered with AI routing in T11, after AI publication exists.

## Acceptance criteria

- [ ] Current human owner, ADMIN, or OWNER can manually transfer Human -> Human through the assignment interface.
- [ ] Disabled or channel-inaccessible HUMAN targets are rejected.
- [ ] Capacity and temporary human availability can be overridden only after an explicit warning confirmation.
- [ ] Human -> Human transfer and manual unassign preserve the existing routing constraint.
- [ ] Manual unassign clears ownership, writes `MANUAL_UNASSIGN`, sets queue time, and records assignment history.
- [ ] Disabling a Member routes each owned OPEN conversation through `MEMBER_DISABLED`; it never directly updates ownership.
- [ ] Close locks the ChannelIdentity and Conversation, clears current ownership/queue fields, resets routing constraint, and records closer/time.
- [ ] Close writes `from -> NULL` history only when ownership changed; no `NULL -> NULL` history is created.
- [ ] A later inbound event creates a new OPEN Conversation while preserving the closed history.
- [ ] Integration tests cover all ownership reasons in this slice, invalid human targets, HUMAN_ONLY persistence, and both commit orders of close versus inbound.
- [ ] Playwright covers transfer, unassign, close, and the later-message/new-conversation flow.

## Blocked by

- T05

---

## T07 — Persist and display inbound Messenger attachments

## What to build

Extend the durable inbound path to image, file, audio, and video attachments. Persist an encrypted short-lived Facebook source, fetch it asynchronously into private R2, and show PENDING/READY/FAILED attachments in the conversation without exposing provider URLs.

Human outbound media remains excluded.

## Acceptance criteria

- [ ] Facebook normalization accepts supported attachment events with or without accompanying text and still uses `mid` idempotency.
- [ ] Core Message uses generic ATTACHMENT type and MessageAttachment kinds; no Page ID, PSID, or Meta URL enters core tables.
- [ ] Provider URLs are encrypted in a short-lived Facebook adapter row, never logged, and deleted after successful R2 persistence.
- [ ] The documents consumer validates size/type, aborts over 25 MiB, writes a private unguessable R2 key, and updates READY or FAILED.
- [ ] Retry or maintenance can recover a PENDING attachment while its encrypted source remains valid.
- [ ] Authenticated download verifies workspace access and returns safe content headers; R2 objects have no public URL.
- [ ] `/inbox` renders images and downloadable file/audio/video attachments with loading and failure states.
- [ ] Attachment-only input remains visible without depending on AI handoff delivery in T14.
- [ ] Contract/integration tests cover mixed text+attachment, duplicate webhooks, oversize, expired source, R2 failure, and unauthorized download.
- [ ] Playwright displays each supported inbound attachment kind through fake Facebook and object-storage adapters.

## Blocked by

- T04

---

## T08 — Index inline knowledge in pgvector

## What to build

Deliver the thinnest complete `/knowledge` path: create a KnowledgeBase, submit inline text, process it asynchronously, generate embeddings through the provider-neutral `EmbeddingProvider` using Alibaba Cloud International Model Studio, store pgvector chunks atomically, retrieve relevant chunks, and expose processing status. This slice makes grounded AI implementation possible without waiting for file-format adapters.

## Acceptance criteria

- [ ] OWNER/ADMIN can create a KnowledgeBase and add inline text; AGENT cannot mutate knowledge.
- [ ] Empty or oversized inline text becomes visibly FAILED without partial chunks.
- [ ] Normalized text is split on paragraph boundaries using the specified 2,000/200 code-point limits.
- [ ] Embedding batches must return 1,536-dimensional vectors; all chunks and READY state commit atomically.
- [ ] Active KnowledgeBase vectors record Alibaba/qwen3.7-text-embedding/1,536 metadata, and retrieval rejects a provider/model/dimension mismatch.
- [ ] Retrieval is workspace/KnowledgeBase scoped, READY-only, uses cosine distance, and returns at most six chunks under the configured threshold.
- [ ] Deleting an inline document removes its chunks without affecting other documents.
- [ ] Queue duplicates cannot create duplicate chunks; maintenance can recover UPLOADED/PROCESSING work.
- [ ] Unit tests cover normalization/chunking and PostgreSQL tests cover vector retrieval, atomic chunk insertion, deletion, and tenant isolation.
- [ ] Playwright covers inline text moving through UPLOADED/PROCESSING/READY plus a FAILED example.

## Blocked by

- T01

---

## T09 — Add file ingestion to the KnowledgeBase

## What to build

Extend the working inline KnowledgeBase path with private R2 upload and extraction for PDF, DOCX, TXT, and Markdown. Reuse the T08 normalization, chunking, embedding, retrieval, status UI, and documents queue rather than creating a second ingestion pipeline.

## Acceptance criteria

- [ ] OWNER/ADMIN can upload PDF, DOCX, TXT, or Markdown up to 10 MiB into an existing KnowledgeBase.
- [ ] File extension, declared MIME, and available magic bytes are validated before private R2 storage.
- [ ] TXT/Markdown use UTF-8 decoding, PDF uses `unpdf`, and DOCX uses Mammoth raw-text extraction with external file access disabled.
- [ ] Empty, scanned-only, malformed, oversized, or extraction-failing files become visibly FAILED without partial chunks.
- [ ] Successful files reuse T08 chunking, embeddings, atomic READY commit, retrieval, and tenant isolation unchanged.
- [ ] Deleting a file document removes its chunks and private R2 object without affecting other documents.
- [ ] Queue duplicates cannot create duplicate chunks or objects; maintenance can recover file work from durable document state.
- [ ] Unit tests cover each extractor contract and security setting; PostgreSQL/R2 integration tests cover READY, FAILED, deletion, and retry paths.
- [ ] Playwright covers one uploaded file moving through UPLOADED/PROCESSING/READY and one FAILED file.

## Blocked by

- T08

---

## T10 — Configure and publish an AI Member

## What to build

Deliver `/ai-member/:id` with the frozen draft fields and a single stable published snapshot. Connect the shared AI Member to exactly one KnowledgeBase, validate runtime eligibility, and show UNPUBLISHED/USABLE/UNHEALTHY without adding login identity or version history.

## Acceptance criteria

- [ ] OWNER/ADMIN can edit instructions, response language, one KnowledgeBase, four handoff booleans, negative-sentiment behavior, and normalized keywords as draft fields.
- [ ] AGENT can view neither secret provider configuration nor mutate an AI Member configuration.
- [ ] Editing a draft after publish does not change the runtime snapshot until Publish is invoked again.
- [ ] Publish validates an ACTIVE AI Member, at least one ChannelAccess, selected workspace-owned KnowledgeBase, instructions/language, and usable provider configuration.
- [ ] Publishing atomically replaces the one snapshot, stamps published time, and marks runtime USABLE.
- [ ] Invalid configuration is UNPUBLISHED or UNHEALTHY and cannot be manually transferred to or auto-assigned.
- [ ] AI Members have no User, account, email, password, or AI-specific conversation ownership column.
- [ ] The UI clearly distinguishes draft changes from the published runtime state and links back to the unified team list.
- [ ] No version-history, rollback, evidence, tools/actions, or external-agent UI/table is introduced.
- [ ] Integration and Playwright tests cover draft isolation, publish validation, republish, and eligibility state.

## Blocked by

- T02
- T03
- T08

---

## T11 — Route conversations AI-first with human fallback

## What to build

Implement automatic assignment as one concurrency-safe domain operation and connect it to new conversations, capacity/availability changes, and recovery. `ANY_MEMBER` tries AI then HUMAN; `HUMAN_ONLY` tries HUMAN only. Add explicit Human -> AI transfer now that published AI eligibility exists. Every transition whose resulting assignee is AI must atomically ensure the AIResponseRun when unanswered customer input exists. Show resulting assignee/queue changes in all inbox views.

## Acceptance criteria

- [ ] All ownership writes in routes and queue handlers cross the assignment interface; a code search finds no direct assignee update elsewhere.
- [ ] Eligibility exactly checks ACTIVE, auto-assignment enabled, channel access, and capacity; HUMAN additionally checks availability and AI checks published USABLE runtime.
- [ ] `ANY_MEMBER` selects eligible AI before any human; when no AI is eligible it selects human; when neither is eligible it remains queued.
- [ ] `HUMAN_ONLY` never selects AI.
- [ ] Ranking uses lowest open-load ratio, least recent auto-assignment, then deterministic Member ID.
- [ ] The workspace row lock and in-transaction load recheck prevent concurrent routing from exceeding capacity.
- [ ] Successful assignment clears queue fields, updates last-auto-assigned time, and writes exactly one history row.
- [ ] Automatic assignment to AI creates exactly one QUEUED AIResponseRun in the same transaction for unanswered customer input and publishes that run only after commit.
- [ ] Current human owner, ADMIN, or OWNER can explicitly transfer Human -> a published USABLE AI with channel access; disabled, inaccessible, unpublished, or unhealthy AI targets are rejected.
- [ ] Explicit Human -> AI transfer resets HUMAN_ONLY to ANY_MEMBER and atomically creates the same single AIResponseRun only when customer input is newer than the last MEMBER outbound Message.
- [ ] Availability/capacity/access changes and the maintenance queue retry eligible queued conversations.
- [ ] Realtime invalidation moves conversations among My, Waiting for Human, AI Handling, Unassigned, and All Open without making the socket authoritative.
- [ ] PostgreSQL integration tests cover every eligibility rule, ranking/ties, AI-first fallback, HUMAN_ONLY, retry, concurrent capacity, Human -> AI transfer, one-run creation under concurrent assignment, and no run for already-answered history.
- [ ] Playwright demonstrates AI assignment, human fallback, and remaining unassigned by changing Member configuration.

## Blocked by

- T04
- T10

---

## T12 — Send one grounded AI response end to end

## What to build

Consume the AIResponseRun created when T11 assigns AI, update the same run for later inbound messages while AI remains owner, retrieve its published KnowledgeBase, generate a structured decision through the configured LlmProvider, enforce grounding, commit a valid AI text as a PENDING MEMBER Message, and reuse the existing outbound delivery path. Show AI generating state and final delivery state in the inbox.

This ticket implements the success path; concurrency cancellation and handoff are completed in T13 and T14.

## Acceptance criteria

- [ ] A run created by AI assignment, or ensured by later inbound on an AI-owned OPEN conversation, contains member and input first/last message IDs and is durably queued once.
- [ ] The consumer claims the run as GENERATING before external work and uses the published snapshot, never the current draft.
- [ ] Retrieval uses only READY chunks in the snapshot's one KnowledgeBase and records retrieved chunk IDs on the run.
- [ ] Alibaba Cloud International Model Studio calls live behind the required LlmProvider and use native `fetch`; domain code imports no provider SDK.
- [ ] Provider output is Zod-validated for decision, response, handoff reason, business-fact flag, and used chunk IDs.
- [ ] An ANSWER containing business facts commits only with a non-empty used-chunk subset of retrieved chunks.
- [ ] If grounding fails, configured no-knowledge behavior becomes HANDOFF-ready state or a localized factual-free uncertainty reply; invented company facts are never committed.
- [ ] A valid answer commits one outbound PENDING Message with `sender_type = MEMBER` and the AI `sender_member_id`, then uses T05 delivery unchanged.
- [ ] AI generating and PENDING/SENT/FAILED changes publish realtime invalidations.
- [ ] Unit tests cover prompt-data delimiting, schema rejection, chunk-subset enforcement, and safe fallback; integration tests cover run/message atomicity.
- [ ] Playwright demonstrates new inbound -> AI Handling -> grounded reply -> SENT using fake AI/Facebook adapters and real PostgreSQL.

## Blocked by

- T05
- T08
- T11

---

## T13 — Enforce AI debounce, freshness, and takeover races

## What to build

Make asynchronous AI attempts deterministic under bursts, new input, retries, crashes, and human takeover. Debounce to one active run, and enforce both current ownership and last-customer-message freshness in the final PostgreSQL commit.

## Acceptance criteria

- [ ] A burst updates one QUEUED run's input end and `scheduled_for`; early queue delivery retries for the remaining delay.
- [ ] The database partial index permits only one QUEUED/GENERATING run per Conversation under concurrent inbound processing.
- [ ] Final AI commit locks Conversation then run and rechecks the AI Member is still current assignee.
- [ ] When takeover commits first, the run becomes CANCELLED `OWNERSHIP_CHANGED` and no outbound AI Message is inserted.
- [ ] When AI commit finishes first, its PENDING Message remains valid and deliverable after immediate takeover.
- [ ] When a new customer message advances `last_customer_message_id`, the old run becomes CANCELLED `NEW_CUSTOMER_MESSAGE`, inserts no outbound Message, and schedules exactly one fresh run.
- [ ] Duplicate AI queue deliveries cannot generate or commit a second response for the same run.
- [ ] A stale GENERATING run is failed by recovery without permitting a late commit.
- [ ] Inbox generating state clears for every terminal path and recovers through normal reads if realtime is lost.
- [ ] Real PostgreSQL concurrency tests force and assert both takeover/commit orders, freshness, burst, duplicate delivery, and stale-run recovery.
- [ ] Playwright covers AI generating -> human takeover -> no later AI reply.

## Blocked by

- T12

---

## T14 — Hand AI conversations off to humans safely

## What to build

Complete the AI failure path. Apply the published handoff policy to customer requests, no knowledge, negative sentiment, inability to answer, keywords, permanent runtime failure, and unsupported attachment-only input. Commit optional transfer notice and AI unassignment together, then deliver the notice and route a human independently.

## Acceptance criteria

- [ ] Configured explicit-request/keyword triggers are deterministic and use normalized text without invoking the model unnecessarily.
- [ ] Structured no-knowledge, negative-sentiment, and unable-to-answer detections obey their published booleans; a disabled handoff policy returns only a factual-free safe fallback.
- [ ] Unsupported attachment-only input and permanent AI runtime failure always hand off.
- [ ] One transaction optionally creates a PENDING transfer Message, changes AI -> NULL through the assignment interface, writes history, sets HUMAN_ONLY/AI_HANDOFF/queue time, and terminates the run.
- [ ] The transfer notice is committed only under the same ownership/freshness checks as any AI-visible message.
- [ ] Outbound notice delivery and human-only assignment are separate post-commit jobs; failure of either never rolls back or blocks the other.
- [ ] An eligible human is assigned; otherwise the conversation remains Waiting for Human and never returns automatically to AI.
- [ ] HUMAN_ONLY persists after human assignment and through unassign/disable; only close or explicit Human -> AI transfer resets it.
- [ ] Permanent AI failures mark runtime health only when they indicate persistent provider/configuration failure; a transient call failure hands off without globally disabling the Member.
- [ ] Integration tests cover every trigger/policy combination, notice failure, no-human queueing, HUMAN_ONLY persistence, and concurrent takeover.
- [ ] Playwright covers customer asks for a human -> waiting/assigned human -> human reply; attachment transport is not a prerequisite for this core handoff slice.

## Blocked by

- T06
- T13

---

## T15 — Recover durable work and harden production

## What to build

Finish production operability without adding a general workflow system. Use the existing durable state tables as bounded recovery ledgers, configure queue retries/DLQ and the scheduled scan, lock down secrets/logging/rate limits, deploy the complete app, and leave a repeatable automated release candidate for live verification.

## Acceptance criteria

- [ ] All five queues validate versioned identifier-only payloads, retry transient failures, persist permanent failures, and route exhausted messages to the shared DLQ.
- [ ] The once-per-minute scheduled handler scans at most 100 indexed rows per work category and repairs unassigned routing, unclaimed outbound, stale claimed outbound, queued/stale AI runs, and pending documents/attachments.
- [ ] A recovery run is safe to overlap with itself and normal consumers through `FOR UPDATE SKIP LOCKED` and current-state checks.
- [ ] Facebook webhook receipts older than 30 days are deleted; no ConversationEvent or generic outbox table is added.
- [ ] Logs and provider errors are verified to exclude tokens, secrets, OAuth state/codes, PSIDs, customer text, prompt/knowledge text, and attachment URLs.
- [ ] Page tokens are AES-GCM encrypted, R2 is private, object reads are authorized, and trust-boundary rate limits are configured.
- [ ] Production configuration contains Hyperdrive, Neon pgvector, R2, queues/DLQ, Durable Object, static assets, required secrets, and Graph API v26.0.
- [ ] Compiler, lint, unit, PostgreSQL integration, Playwright, migration-from-empty, and deployment smoke checks all pass from documented commands.

## Blocked by

- T01
- T02
- T03
- T04
- T05
- T06
- T07
- T08
- T09
- T10
- T11
- T12
- T13
- T14

---

## T16 — Pass the live V1 release gate

## What to build

Verify the hardened release candidate against a real Facebook Page and user. Record timestamps and redacted evidence for every frozen acceptance flow and external-failure check. This ticket changes implementation only when verification exposes a release-blocking defect; it does not reopen product discovery.

## Acceptance criteria

- [ ] The exact deployed version, database migration, Cloudflare resources, Meta app/Page, tester, and test timestamps are recorded without secrets, PSIDs, or customer content.
- [ ] Real user -> Messenger -> inbox -> human reply -> real user passes.
- [ ] New conversation -> AI assigned -> AIResponseRun triggered -> grounded response reaches the user.
- [ ] Customer requests human -> HUMAN_ONLY -> human assigned -> human reply passes.
- [ ] AI generation -> human takeover produces no stale AI commit.
- [ ] AI generation -> newer customer message cancels the old run and generates from fresh input.
- [ ] Forced Facebook send failure remains visibly FAILED and never appears SENT.
- [ ] Close -> later real inbound creates a new OPEN Conversation.
- [ ] Invalid Page token is detected as ACTION_REQUIRED, and an intentional replay with the same `mid` creates no duplicate Message/reply.
- [ ] PDF, DOCX, TXT, and Markdown documents each reach READY and can ground a relevant answer.
- [ ] Each inbound attachment kind is visible or downloadable from private R2 through an authorized route.
- [ ] Any still-unobserved expired-window Meta error is recorded as such; local 24-hour enforcement and visible Graph failure are demonstrated.
- [ ] A final GO/NO-GO report links the evidence and names only unresolved release blockers.

## Blocked by

- T01
- T02
- T03
- T04
- T05
- T06
- T07
- T08
- T09
- T10
- T11
- T12
- T13
- T14
- T15

## Publication checklist

When a project tracker is connected:

1. confirm the 16-ticket granularity and dependency graph;
2. publish in numeric/dependency order so real issue identifiers can replace `Txx` references;
3. apply the repository's actual triage label vocabulary; and
4. do not create a parent issue unless one already exists.
