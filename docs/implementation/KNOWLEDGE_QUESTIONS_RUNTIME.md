# Structured knowledge questions

This delivers #28's T34 stage. T35 private asset retrieval and AI sending remain
separate staged work. Existing text and file documents continue to use the same
knowledge base, embedding adapter, retrieval, and citation pipeline.

## Storage and indexing

A question/answer pair is a TEXT knowledge document with explicit `question`,
`answer`, normalized question hash, positive `revision`, and `index_operation_id`.
The source uses `Question: …\nAnswer: …`; citations retain the document ID.
Limits are 400 Unicode code points for the question and 1,500 for the answer,
after the existing text normalization. The complete pair fits one existing
2,000-code-point chunk, so retrieval does not split an answer from its question.
These are project limits, not provider defaults.

Within one knowledge base, identical normalized questions and answers merge.
The same question with a different answer returns CONFLICT, requiring an
explicit edit. Batch insertion is atomic. Stable client item IDs and the unique
question hash make request retries and repeated imports idempotent. Imports use
a JSON array of objects containing only `question` and `answer`, with 1–100
items and a 1 MiB request/file limit. No import overwrites an existing answer.

Editing uses an expected revision. A replay of the immediately preceding edit
with identical normalized content succeeds without another revision. A stale
or competing edit returns CONFLICT. An accepted edit deletes old chunks in the
same transaction, increments the revision, clears processing/failure state,
and schedules indexing. Queue completion, failure, and release all require
the claimed revision and timestamp; old work cannot replace a newer index.
Deletion cascades chunks and prevents later worker completion from restoring
the source. Existing embedding provider/model/dimension compatibility checks
apply unchanged.

Each revision has an independent indexing operation ID. Retries of that
revision reuse its metered operation; actual provider attempts remain recorded.
A new edit starts a new operation and may consume another indexing allowance.
Failed entries show the existing safe failure codes; after restoring service or
budget, editing and saving starts a fresh revision. New retrievals cannot see
the removed old index. An AI run that already read the old source may finish
under the existing conversation ownership/input checks; knowledge editing does
not cancel all in-flight conversation runs.

Active human workspace membership is required for reads; OWNER/ADMIN membership
is required for management. Disabled members retain no knowledge access.
Provider calls remain outside database transactions. Scheduled recovery picks
up durable UPLOADED documents if enqueueing fails; clients may safely retry the
same item IDs when a request result is unknown.

## Rollout and validation

Back up the database and apply forward migration
`0027_knowledge_questions.sql` before deploying code that selects these fields.
It adds nullable question fields, revision/operation identity, constraints, and
a unique per-base question hash. Existing documents are backfilled with
`index_operation_id = id`, preserving their previous metering identity and
indexing retry behavior. If earlier migrations are pending, apply them in
order using the direct migration URL. Application deployment does not migrate.
Do not roll indexing consumers back to a pre-T34 Worker after deploying this
stage. Older consumers use document IDs for metering and lack revision checks;
they can charge again or publish stale results for edited questions. Keep the
revision-aware indexing consumer during any UI rollback, stop ingestion while
diagnosing an indexing defect, and ship a forward fix. Do not remove columns.

Validation covers Unicode boundaries/full-pair chunking, authenticated Worker
routes and queue handlers against real PostgreSQL, duplicate imports/jobs,
revision races and stale provider completion, deletion, conflict atomicity,
tenant/role/disabled-member access, and Playwright add/edit/import/delete flows.
The existing text/file browser flow runs alongside the question flow. Provider
substitutes verify deterministic retrieval and accounting; they do not certify
real model answer quality. No production migration or deployment is part of
this implementation stage.
