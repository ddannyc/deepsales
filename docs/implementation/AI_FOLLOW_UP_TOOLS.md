# Follow-up tools and variables

Independent follow-up requirements may reference the controlled variable and tool
catalogs. Their current rule revision and event eligibility authorize those
references; they need not also appear in the main published instructions. Main
configuration history restores do not restore independent rules or tools.

Migration `0053_tool_read_retry.sql` adds `attempt_count` and `retry_at` to the
existing action ledger. Apply this forward migration before deploying the new
runtime. Existing started live actions reserve one slot; simulated tests and
debug operations do not acquire live dispatch slots. No conversation or message
data is rewritten.

The counter records conservative reserved execution slots, not exact network
requests: validation or cancellation after a claim can prevent I/O. Every live
turn has at most three slots across built-ins, external calls and safe retries.
Replaying a successful receipt consumes no new slot. A safe read retry keeps the
same event, operation, action ID and ordinal, with durable 30/120-second backoff
or a longer provider delay. Uncertain dispatched writes remain paused and cannot
be retried automatically. Provider model-attempt and cost metrics remain separate.
