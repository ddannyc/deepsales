# Customer memory (T28)

Customer memory is a private, customer-level summary independent of conversation
context and properties. The member setting defaults to disabled, follows draft/save/
publish/version restoration and does not delete stored memory when disabled.
Summary generation runs only for currently enabled published AI members.

After ten minutes without valid communication, the existing maintenance queue
processes at most 50 messages and 8,000 Unicode code points in communication order.
A long first message is truncated explicitly rather than skipping a middle message.
Remaining messages are processed in separate bounded batches. Every revision uses
one durable operation and logical charge; provider attempts remain separate. Queue
jobs carry the revision, so redelivery cannot accidentally start the following batch.
Budget exhaustion preserves the cursor and stored summary. Unknown or terminal
failed operations stay paused until new communication or explicit clearing.

The communication ledger records customer input and MEMBER replies confirmed SENT.
Pending/failed sends, EXTERNAL content and internal notes do not contribute.
PostgreSQL serializes ledger insertion, revision invalidation and summary commits.
The message trigger also tracks communication received by an older application
between migration and deployment. Provider calls occur outside transactions.

Only manually associated identities share a summary. All contributing channels
must currently be authorized and active for a reader or generating AI member;
mixed summaries are withheld entirely when any contribution is inaccessible.
The scheduler filters full contribution access before its 50-customer limit, so
restricted customers cannot block authorized updates behind them.
Memory is untrusted continuity data and never substitutes for knowledge grounding.
Live AI runs record the memory revision; clearing, relinking or losing access prevents
a stale answer from committing and schedules a fresh run. Diagnostics expose the
revision, without returning the private summary snapshot.

Administrator clearing requires the displayed customer and memory revision, checked
again under the memory lock after locking contributing identities in stable order. It
invalidates pending work, removes the active summary and advances both customer and
identity boundaries. Messages remain intact and pre-clear communication is not
automatically rebuilt, including after a later identity move. Moving an identity
clears the source customer's mixed summary; an existing target summary remains.
Newly detached identities form memory only from new communication. Identity dialogs
describe these effects before confirmation.

Apply reviewed forward migrations 0041–0043 before deploying. They add the memory
tables and setting, backfill communication metadata without model calls, add identity
boundaries and a response cancellation reason. All model credentials remain existing
Worker secrets. Tests use real PostgreSQL routes, maintenance/scheduled handlers and
provider substitutes; browser coverage verifies publication, retention and explicit
clearing. Real model summarization quality requires separate acceptance.
