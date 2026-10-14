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

The test bench can select a saved rule, including a disabled one. It freezes that
rule's revision and requirements for the simulated turn, rechecks the current
rule and tool authorization before effects/results, and retains the existing
session-clear generation guard. The entered text is past context rather than a
new customer input. Sandbox writes are simulated; testing never consumes a live
once event. Tool catalogs and mapped external reads retain the existing viewer
and AI channel intersection.

Event history exposes action IDs, tool kinds, states, reserved counts and retry
times under the already-authorized parent event. It omits arguments and results.
If an action succeeds and later input, ownership, stop or rule changes prevent
the message, history explains partial completion. The successful receipt remains;
it is neither rolled back nor executed again. A changed variable source cancels
the original follow-up without manufacturing an ordinary customer-reply run.
