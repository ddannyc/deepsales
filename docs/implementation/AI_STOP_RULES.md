# AI reply stopping

Issue #40, T33 adds published stop settings to the existing AI configuration.
Older configuration versions default to no stop rules. Restoring history changes
the draft only; publication validates the current property, tag and ending-image
references before creating the immutable version.

Each condition group is AND; groups are OR. A condition matches an authorized
customer/conversation property by exact typed value, an assigned tag, or a minimum
number of committed AI logical replies in the current conversation. Missing,
deleted and inaccessible facts cannot match. A split answer plus its attachment
counts once; retries do not add rounds. Human messages and system handoff notices
do not count. Committed failed replies count because generation already produced
a durable reply. Later follow-up delivery must use the same logical accounting
and commit boundary.

Weekly periods use the published configuration's IANA time zone and server time.
Days are Sunday 0 through Saturday 6. Start is inclusive and end exclusive;
`24:00` is permitted for an end. Cross-midnight periods are two explicit day
entries. DST repetition and skipped wall-clock hours follow the configured zone.
Limits are project choices: ten groups of ten conditions and 28 weekly periods.

PostgreSQL stores the stop reason and transition time on the conversation,
without adding lifecycle states or changing ownership. A condition stop persists
for that conversation even after facts or configuration change. A schedule stop
ends only when a new input, persisted after the stop transition and outside the
run's pinned published period, is processed. A delayed input from within the period
does not resume the conversation just because its queue runs later. Closing and
opening a new conversation naturally starts with no stop state.

The Worker checks deterministic configured handoff first, then stopping before
knowledge retrieval or normal reply generation. If customer-request handoff is
enabled, a stopped input within the existing text budget still gets a metered
semantic handoff check. Only `CUSTOMER_REQUEST` can hand off from that check;
model answer text and other handoff reasons are discarded. Disabling this policy
skips that model call; configured keyword triggers continue to apply. The commit
transaction repeats ownership, channel,
freshness and stop checks. Workspace/conversation locks serialize fact changes,
publication and commits. Deleted condition references cause a diagnosed runtime
fault handled by the existing safe handoff policy; they are not silently omitted.

Only a transition into stopping may commit the optional administrator-provided
ending text and/or private library image. Text is an explicit configured answer,
not generated knowledge; administrators confirm its facts and language. An image
is reauthorized at commit and its immutable delivery metadata is copied to the
message ledger. Revocation skips that image with `AI_STOP_ENDING_UNAVAILABLE`,
while retaining the stop and any valid ending text. Stops themselves do not
handoff. Existing explicit human-request and keyword handoff still applies.

All inbound input remains durable and visible. Repeated or concurrent queue work
cannot create another ending for the same transition. Legally committed endings
remain deliverable after takeover or library deletion. Delivery window, storage,
provider failure and unknown-result policies are the existing media/text paths.
Stopping without ending content creates no empty message. A semantic handoff
check uses the existing live-operation budget, retry and unknown-result policy.
Its `STOP_HANDOFF` provider attempt is cached separately from ordinary `LLM`
generation, so a condition changing during the check cannot reuse the classifier
as a customer reply. Normal generation may continue if the final check no longer
matches; both attempts share one logical reservation and retain their actual costs.
Inbox badges and AI diagnostics distinguish condition/schedule stops, unavailable
ending images and runtime faults.

Forward migration `0034_ai_stop_rules.sql` adds configuration and conversation
JSON fields. Production requires backup and a separate migration step before
deploying; this stage does not migrate or deploy production or send real-channel
acceptance messages. Tests cover durable stopping, AND/OR and channel isolation,
logical rounds, DST, new-input recovery, stale input, concurrent ending creation,
revocation, takeover, handoff priority, semantic requests, changing conditions
during classification and browser configuration/publication.
