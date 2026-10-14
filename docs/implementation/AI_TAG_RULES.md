# Controlled AI tag appending

The AI tag feature defaults off. Save and publish its main configuration switch
to enable it. Authorized tag rules are independent resources: saving, disabling
or deleting a rule takes effect immediately and restoring a main configuration
does not roll these resources back. Each AI may have at most 20 rules.

Rules reference existing workspace customer or conversation tag definitions.
Model output contains only a deduplicated array of authorized definition IDs.
The server chooses the customer and conversation from the assigned run. AI never
creates definitions, removes tags or replaces existing tags. Appended records
retain the AI member and current source channel.

Claim captures rule revisions, customer association and target tag revisions.
The reply commit rechecks ownership, current customer input, channel grants,
association, enabled published switch and current rules. Human tag decisions
increment persistent target revisions, including removal of an absent tag. A
result generated before that decision cannot reappend the tag. Shared customer
tags require access to all currently associated channels. Duplicate appends use
existing tag uniqueness constraints.

Tag generation shares the ordinary reply provider call and quota operation.
Test sessions use the same output boundary and authorized rules, but apply tags
only to their simulated customer. No live tag records are written by tests.

Apply forward migration `0046_controlled_ai_tags.sql` before deploying this
feature. It adds default-off configuration, independent rules, run snapshots
and target revision counters; existing tags are retained.
