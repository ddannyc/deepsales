# Current Conversation Context runtime contract

Implements [#12](https://github.com/ddannyc/deepsales/issues/12), under the
[context specification #10](https://github.com/ddannyc/deepsales/issues/10).

## Scope and chronology

Each claimed AI run reads only its current Conversation. Current unanswered
customer input remains the original input-first/input-last range; history never
expands ownership or freshness authorization. PostgreSQL orders messages by
`created_at`, then message ID. Cutoff comparisons preserve PostgreSQL microseconds
instead of round-tripping through JavaScript millisecond timestamps. Provider
timestamps do not reorder the thread.

History includes customer text and SENT member text with its actual CUSTOMER,
AI or HUMAN origin, member identity, direction and creation time. Member origins
are resolved within the Conversation's workspace. PENDING, FAILED, EXTERNAL and
attachment bodies are excluded; readable captions remain text history. Outbound
delivery completed after the input cutoff is excluded even when its message was
created earlier. Existing attachment handling for current input remains unchanged.

## Deterministic budget

- Current supported text: at most 8,000 Unicode code points across the unanswered
  input range. At the limit it remains intact. Larger input safely hands off with
  `AI_INPUT_LIMIT`; it is not silently truncated or sent to a provider.
- History: at most 8,000 Unicode code points and 48 messages. Scan at most 49
  eligible recent messages before the current input. If this scan reaches the
  extra row, discard its oldest potentially partial customer turn; an orphan
  reply is already omitted and does not discard the next complete turn.
- A complete prior turn contains a customer burst followed by one or more SENT
  member replies. Retain the nearest complete turns, dropping oldest turns first.
  A turn is never split to fit the budget; if the nearest complete turn alone is
  too large, omit history. Leading orphan member replies and trailing unanswered
  history are omitted. No persisted summary or cross-Conversation memory exists.

These are initial project limits, not model token guarantees. Prompt framing,
published instructions and retrieved knowledge have their existing independent
limits. Provider failures retain the existing safe runtime handling.

## Retrieval and generation

The embedding query contains the same retained recent history, labelled by
origin, followed by current customer text. Generation receives that history in a
separate escaped data section and current input in the customer-messages section.
History, including human replies and embedded role labels, never becomes a system
instruction or proof of company facts. Answers still require valid retrieved
chunk references under the existing grounding policy. Missing or ambiguous
referents require clarification or existing handoff handling.

No public inbox API, queue payload, schema, migration, dependency, response
language, sales policy or assignment behavior changes. No prompt or customer text
is added to logs.

## Verification

Worker queue-consumer tests use real PostgreSQL and external provider fakes to
verify distinct-knowledge retrieval, retained AI/human origin, cutoff/isolation,
delivery exclusions and Unicode budgets. Existing database race tests verify
takeover, freshness, duplicate jobs and valid committed-message independence.
Prompt contract tests verify untrusted human text remains escaped data. Playwright
checks a multi-turn thread and explicit human-to-AI continuation through actual
routes and queues with fake AI/Facebook services.

These tests prove application contracts. Live-model referent resolution and a real
Messenger transcript remain release checks; no live customer message is sent by
this implementation workflow.
