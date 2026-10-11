# AI publication and operations

Issue: #26. This is the approved next-version extension to the frozen baseline.

## Publication

Publishing appends an immutable main-configuration version and atomically selects it
as the current runtime. Draft edits and history restoration never change the published
version. Restoration overwrites the current draft only; independent resources and
customer values remain untouched. A missing knowledge-base reference is explicitly
reported in history and restored as an unselected field that must be repaired before
publishing. No resource is recreated.

A response run captures its version and snapshot on its first claim and retains them
across retries. It records the actual bounded history message IDs, input boundaries,
retrieved knowledge IDs and committed reply/transfer notice ID. Older runs without
such references remain explicitly unversioned; migration does not invent their past
configuration or context. Existing current publications receive an initial history
version, using their existing published time and snapshot.

## Usage

The application unit is one logical operation. The initial period is a UTC calendar
month. An optional workspace hard limit is manager-configurable; blank means unlimited.
An operation is a real response run (retrieval and generation together), one isolated
test, or one knowledge-document indexing job (all its embedding batches together).
Future generation entry points must use the same reservation and attempt boundary.

Reservations serialize under the workspace lock. The first provider request starts
the operation's charge. Failure or cancellation after starting does not refund that
charge. Safe retries reuse its stable ID and original billing period; they do not
charge another application unit. Completed provider responses are privately persisted
and replayed without another external request. Each actual HTTP attempt is separately
recorded, including embedding batches. Costs are unknown; no monetary balance is shown.
The existing deployment's provider/model settings remain the authority for model choice.

Known failed requests have at most two retries, with minimum waits of 30/120 seconds
and any longer Retry-After. Network results that cannot be determined pause without
another call. Scheduled recovery cancels untouched reservations older than five
minutes, and marks interrupted started operations/attempts unknown while keeping their
charge. A late caller cannot spend a cancelled reservation. A new test requires a new
operation ID; reposting an existing ID reads its current durable status.

Exhausted live reception retains the inbound message and hands off through the existing
assignment boundary with QUOTA_EXHAUSTED. No available human means HUMAN_ONLY waiting.
Increasing a limit never silently reassigns those conversations to AI. Non-reception
operations stop without touching conversation ownership. Indexing failures can be
diagnosed through the existing knowledge-document status; private attempt records retain
whether a provider request began.

## Diagnostics and statistics

OWNER/ADMIN with active human membership can enter diagnostics from a real AI reply or
the AI member's real/test run list. Tests can use a saved draft, current publication, or
history version. They create no Customer, Conversation, assignment or outbound Message.
Multiturn/reset, simulated customer state and batch testing remain #37 scope.

Diagnostics read customer and knowledge content from canonical workspace-authorized
storage, never public logs. They distinguish handoff, stale-input/ownership cancellation,
invalid knowledge/output and provider failures. Missing knowledge is shown as deleted.
Manager feedback references the actual run or test; feedback never changes knowledge or
configuration. Mixed real/test history uses one stable microsecond timestamp/ID cursor.

Statistics query durable runs, messages and the usage ledger directly. UTC interval
boundaries are inclusive/exclusive respectively; a validated IANA timezone controls
daily production grouping. The maximum interval is 366 days. Filters select a member
and/or configuration version. Production runs, test operations, knowledge indexing,
human messages and AI messages are separate. Message totals include transfer notices;
they are labelled committed messages, not logical successful answers. Only COMPLETED
production runs represent committed logical answers. Queued/generating, failed and
cancelled runs remain separate, and provider attempts are never additional answers.
Skip is not an executable outcome in the current runtime and is not fabricated.
Zero data and query failures are explicit; calculatedAt indicates fresh on-demand
aggregation, with no delayed cache presented as current data.

## Operations and validation

Apply the reviewed forward migration before deploying the matching Worker/SPA. Take a
fresh database backup first. The migration adds history, quota/operations, attempts,
feedback and response diagnostic references without removing existing data. Database
constraints validate ledger states and feedback references. Version updates are rejected
by a database trigger. Do not run the old Worker concurrently after a deployment rollback:
the old runtime does not enforce the new hard limits. Keep the new Worker and disable AI
members if operational rollback is required.

Real PostgreSQL tests cover publication isolation/concurrency, missing references,
concurrent reservations, retry charging, interrupted-call recovery, diagnostic
authorization, isolated duplicate tests, same-timestamp paging and interval boundaries.
Worker tests cover quota/unknown-result handoff and no repeated provider call.
Playwright covers history preview/restore/publish, isolated testing/feedback, hard-limit
rejection and statistics. Provider substitutes do not verify real model quality or
provider invoice amounts. Production migration/deployment and real model verification
remain operator steps; no production data or account details are included here.
