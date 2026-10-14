# Controlled instruction variables

The main AI instruction editor inserts `{{key}}` references from a fixed catalog.
References save in the draft and become live on publication. They are supported
only in AI instructions: they are never SQL, URL hosts, credentials or authority.
Unknown complete references are rejected on save and publish.

| References | Type and source |
| --- | --- |
| `customer.name`, `.email`, `.phone`, `.language` | Text or null from the authorized contact profile |
| `customer.properties`, `conversation.properties` | Up to 20 stable ordered `{name,value}` records, preserving text/number/option values |
| `customer.tags`, `conversation.tags` | Up to 50 stable ordered existing tag names |
| `conversation.context` | The existing bounded, authorized current run input and history |
| `conversation.replyCount` | Committed logical AI replies, including proactive replies using the shared run ledger |
| `system.now`, `system.timeZone` | Server capture time rendered in the configured time zone, and that time zone; default UTC |

Missing or unavailable values are explicit null. An authorized empty list is
empty. Customer data stays quoted in a separate prompt data block; it is not
interpolated into trusted instructions and does not replace company grounding.
Customer text and automatic reply language cannot change trusted time values.

Live claim captures an input schema version, time, typed selected values and
source revisions in `ai_response_run.variable_input`. Retries retain that input
only while its identity, profile, properties, tags and channel access remain
valid. Commit rechecks the same source boundary; a change cancels the stale run
and schedules a fresh one. JSONB object ordering does not affect comparison.
Diagnostics expose the input schema version and capture time, not copied values.

Shared contact/profile variables require all contributing channels. Property
values also require current and historical source-channel access. Reply
suggestions intersect the AI's access with the requesting human's access and
recheck before completing. Test sessions and batch retries build the same typed
inputs from their simulated facts and never read live contacts for variables.

Completed suggestions retain their variable snapshot in the existing private
AI operation output. Cached reads and send confirmation, including client-key
replays, recheck those sources and both members' channel grants. Changed,
unlinked or unavailable sources make the cached suggestion invalid; missing
provenance on older variable-based suggestions also invalidates them. Replaying
the old ID does not call the model again or consume another logical charge.
Already committed messages remain in the delivery ledger and are not cancelled.
Suggestion operations are not exposed by the diagnostic endpoint.

Migration `0048_instruction_variables.sql` adds the independent nullable input
snapshot to existing runs. Apply it separately before deployment. The insertion
component exposes only implemented variables; tool insertion belongs to its
separate tool/skill work and is not represented by an empty control here.
