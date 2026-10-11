# Published reply style and bounded input waiting

Ticket #40, T32 adds separate natural-tone and input-wait switches to the
AI configuration draft. Save and publish remain separate. Natural tone is off
by default; waiting is on, preserving the existing two-second behavior.
Legacy versions without these fields retain those defaults when read or restored.
Restoring history only changes the draft and never changes a running generation.

Natural tone adds a concise conversational-style instruction to live and isolated
test prompts. It explicitly preserves AI identity. It does not add business rules,
new handoff conditions, or another model request. Knowledge grounding and existing
handoff policies remain in force.

## Waiting and publication

With waiting enabled, a new unclaimed run is due two seconds after the last
customer input, capped at thirty seconds after that run was first queued.
Continuous messages update the same persisted run; duplicate scheduling of the
same last input does not postpone it. The cap means a worker may try to claim at
thirty seconds, not that a stale result becomes valid or that a provider reply
will arrive by then.

Disabling waiting makes new runs immediately eligible. Publishing either switch
recalculates unclaimed waiting runs using their last-input timestamp and original
thirty-second cap, then re-enqueues that member's waiting jobs through the existing
queue boundary. Scheduled recovery reads these PostgreSQL deadlines after a
process restart or enqueue failure. Queue duplicates cannot produce duplicate
claims or replies.

First claim pins the published configuration as before. Generating runs and queued
retries with a pinned snapshot keep it; publishing does not remove retry backoff.
New customer input during a queued retry cancels that old run and creates a fresh
run under current published waiting settings. Ownership and latest-input checks
remain mandatory when committing a reply. A reply legally committed before
takeover remains independently deliverable.

The page shows draft controls, published values and history/diagnostic snapshot
values separately. The two and thirty second limits are project defaults, not
claims about a channel provider's defaults. T32 does not add configurable wait
durations, response splitting, attachment fallback, persistent stops or language
detection; those remain separate approved stages.

## Deployment and verification

Apply reviewed forward migration `0029_reply_style_wait.sql`, after its preceding
migrations and the documented backup procedure, before deploying. It adds two
defaulted booleans and does not rewrite immutable version records. An older
release ignores these settings; reverting code therefore restores its old waiting
behavior without deleting data.

Tests cover bounded continuous input, concurrent claim/commit, published changes
to an already queued run, takeover, retry isolation, saved/restored defaults,
authenticated configuration validation, actual Worker provider input and queue
duplicates, and browser save/publish/history flows. The existing grounded-reply
browser flow verifies delivery through the channel substitute. Real model tone
quality and real-channel acceptance remain separate checks; local tests do not
claim those checks are complete. No production deployment or migration is part
of this local implementation.
