# AI Conversation Context and Grounded Follow-up Answers

Status: implemented; specification #10 and implementation ticket #12 are closed.
Status checked: 2026-10-14. Implementation commit: ed5d1e7 (already in local main).
The decisions and acceptance requirements below describe the delivered scope.

Scope update: the user withdrew the separate pricing/Purchase Intent handoff feature. This specification now covers Conversation Context only. All other screenshot features belong to the separately prioritized screenshot-parity plan; they are not excluded from the next version.

## Problem Statement

An ongoing Messenger conversation loses meaning when an AI attempt receives only the unanswered customer messages since the last Member reply. Earlier customer answers, AI explanations, and human messages are absent, and retrieval uses only the latest unanswered text. A short follow-up such as “Does the second option come in blue?” loses its referent despite the conversation containing it.

## Solution

Give the AI bounded, role-aware Conversation Context from the current Conversation. Use it to interpret current customer input, retrieve the relevant configured knowledge, and generate a grounded follow-up answer. Preserve existing general handoff policies, human takeover, authorization, freshness, and delivery behavior.

This feature adds no new pricing or buying-intent restriction. Business facts, including price facts, remain subject to the existing configured-knowledge grounding policy.

## User Stories

1. As a Messenger customer, I want the AI to understand a reference to its earlier explanation, so that I do not need to repeat the conversation.
2. As a Messenger customer, I want short preference answers to use earlier questions, so that a natural back-and-forth remains possible.
3. As a Messenger customer, I want references to one of several discussed options to be understood, so that I receive facts about the intended option.
4. As a Messenger customer, I want unclear references to receive clarification, so that the AI does not invent an interpretation.
5. As a Messenger customer, I want business facts to remain grounded in configured knowledge, so that conversation memory does not legitimize unsupported claims.
6. As a human Member, I want delivered human messages to inform AI after an explicit transfer back, so that the customer does not need to repeat preferences.
7. As a human Member, I want historical participants to retain their origin, so that a change of assignee does not rewrite who said what.
8. As a human Member, I want takeover to prevent an unfinished AI attempt from committing, so that my intervention remains authoritative.
9. As an administrator, I want context limited to the current Conversation and workspace, so that another customer or workspace cannot influence the answer.
10. As an administrator, I want deterministic history limits and safe truncation, so that long conversations remain usable within provider limits.
11. As an administrator, I want conversation text and prompts excluded from logs, so that the feature preserves existing privacy rules.
12. As an administrator, I want existing response languages and general handoff settings preserved, so that the feature does not impose a new business-specific policy.
13. As a maintainer, I want new input and ownership changes to cancel stale attempts, so that asynchronous AI processing uses current authorization.
14. As a maintainer, I want duplicate jobs and valid committed PENDING messages to retain existing behavior, so that the feature does not duplicate or erase replies.
15. As a maintainer, I want English multi-turn acceptance through existing test seams, so that the feature has reproducible evidence.

## Implementation Decisions

- Keep the modular monolith and first-class Member model. This is a next-version extension, not a rewrite of the frozen Lean V1 baseline.
- Extend the existing AI run-claim and provider-input contracts with message identity, chronology, direction, and customer/AI/human origin. Separate current unanswered customer input from historical context.
- Read canonical PostgreSQL messages for the claimed run's current Conversation and workspace, through its input cutoff. Do not include another Conversation or later input.
- Include earlier customer text and delivered AI/HUMAN Member text. Failed or unsent outbound messages must not be presented as statements the customer received. Preserve canonical database ordering for equal or out-of-order provider timestamps.
- Keep input-first/input-last references as the run's current-input range. Background history does not expand commit authorization or freshness.
- Use a deterministic documented internal provider-input budget. Retain supported current input and nearest complete prior turns; drop oldest history first. Clarify or safely hand off when a referent is unavailable. No stored summaries or cross-Conversation memory are introduced by this ticket.
- Treat current and historical messages, including human text, and knowledge as untrusted data. Embedded instructions and role labels cannot become system instructions.
- Build retrieval queries from current input plus relevant recent referents. Generation uses the same retained context, separately marked current input, published configuration, and retrieved knowledge chunks.
- Reuse embedding and PostgreSQL knowledge search. Historical dialogue is not proof of business facts; existing valid-chunk references and grounding enforcement remain required, including for pricing facts.
- Keep existing general handoff reasons, optional settings, notice behavior, HUMAN_ONLY persistence, human routing, provider failures, and runtime-health behavior. Do not add pricing/Purchase Intent reasons, switches, or a sales-output veto.
- Preserve unsupported-attachment behavior within this feature. The separate screenshot-parity workstream adds media understanding later in dependency order.
- Adapt affected callers, typed exports, input validation, external-provider fakes, and fixtures. Reuse existing tables; no migration or new dependency is required for this context ticket.
- Preserve public inbox APIs, queue payloads, realtime invalidation, workspace and Member-channel authorization, Facebook reply-window checks, and committed-message delivery semantics.
- Never log conversation text, prompts, knowledge text, protected identifiers, or provider credentials.

## Testing Decisions

Use the confirmed existing Worker AI queue-consumer boundary with real PostgreSQL and controlled embedding/LLM, queue, and Facebook fakes. Exercise context loading, retrieval, policy, canonical Message/Conversation state, and post-commit effects. Reuse assignment/AI-response race tests where lock order must be controlled, focused parser/policy tests, and a small existing Playwright flow.

Useful tests assert observable provider inputs, canonical database/API state, queues, and the inbox. Avoid whole-prompt snapshots and private-helper call counts. Multiple distinct knowledge facts and an isolated follow-up must show why history is necessary. A fake provider proves contracts, not live-model reasoning quality; use a neutral English transcript against the configured provider during release verification.

| Scenario | Required result |
| --- | --- |
| AI describes two options; customer asks about the second | Correct referent and current question reach retrieval and generation; answer is grounded |
| Customer gives a short preference answer | Earlier questions explain the new input; old requests are not revived |
| Human replies and explicitly transfers back to AI | Delivered human text appears with human origin in context |
| Outbound text failed or is unsent | It is excluded from customer-received history |
| Context exceeds its budget | Current input and recent complete turns survive; unresolved references get safe clarification or handoff |
| Foreign, closed historical, or later-input text matches the question | It is absent from this run's context and retrieval query |
| History contains an injected instruction | It stays untrusted and cannot override grounding or general handoff policy |
| Customer asks a price question with supported knowledge | Existing grounding and configured general handoff behavior apply; no new mandatory sales trigger exists |
| Takeover or newer input wins before commit | Old attempt cannot commit a stale reply |
| Duplicate queue delivery | No duplicate reply or Assignment history |
| Ownership changes after a valid PENDING commit | Existing delivery remains valid |
| Provider output is invalid or a provider fails | Existing validated retry/failure/handoff behavior remains intact |

Run affected formatting, lint, typecheck, unit, real-PostgreSQL integration, relevant Playwright, and build checks during implementation. Integration and E2E must run sequentially with existing database safeguards.

## Out of Scope

- The withdrawn business-specific pricing/Purchase Intent handoff policy, silent-sales default, and order-confirmation workflow.
- Persistent customer-property memory, media understanding, follow-up rules, bulk sending, CRM, labels, notes, translation, quick replies, AI playground/batch testing, history, tools, and other screenshot capabilities are separate required workstreams. This ticket does not implement them.
- Cross-channel automatic identity merging, order/payment/fulfillment systems, and features not evidenced in the supplied screenshots.
- Unrelated cleanup, new infrastructure, vector spaces, dependencies, and deployment operations.

## Further Notes

- The user explicitly withdrew the sales-specific policy and made the supplied screenshot capabilities the next-version priority. Tickets #11 and #13 are withdrawn; #12 is implemented and closed.
- Interface language remains Chinese; English is the first customer acceptance language, not the only configured response language.
- Current-Conversation scope is the source boundary for this ticket. The screenshot's AI-memory setting is a separate required workstream whose persistence semantics must follow its actual configuration.
- Use neutral examples throughout repository documents, tracker content, and fixtures. Do not include private business details or screenshots in published issues.
- Implementation was subsequently authorized and completed through #12. Deployment remains a separate operational step.
