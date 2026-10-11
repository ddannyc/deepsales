# Independent AI handoff conditions

Implements #40 stage T52. Existing published handoff flags and keywords remain active.
Managers can create up to 20 named conditions per AI member: exact typed property
equality, a customer/conversation tag, or a natural-language semantic condition.
Enabled conditions use OR matching. Property and tag conditions use only current
facts from active channels authorized for that AI member. Semantic conditions use
the current customer input and authorized recent conversation context.

Saving, enabling, disabling, and deleting apply immediately. Updates and deletion
require the current revision. Restoring an AI configuration version leaves these
independent resources unchanged. Broken references require repair or disabling;
runtime failures use the existing safe handoff path.

Before generation and again before committing a reply, PostgreSQL checks current
rules. A semantic decision is associated with the enabled rule revisions; an edit
requires classification again. The assignment boundary rechecks rule revision,
ownership, input freshness, and deterministic facts before writing assignment
history and HUMAN_ONLY. Existing human capacity and queue behavior apply; sending
the handoff notice is independent of the committed ownership change.

Semantic classification is a metered provider stage in the same logical reply
operation. Changed revisions receive a different stage key; retries do not reuse
an older rule decision or charge another logical operation. Actual attempts remain
visible separately and can increase provider cost.

The isolated single-question test freezes enabled definitions and supplied mock
property/tag facts in its operation. It records a simulated handoff and never
creates a customer, conversation, assignment, or outbound message. The UI can
supply one condition's mock facts; the API accepts up to 20 properties and tags.
Semantic tests use the selected configuration's language and timezone. Real model
classification quality and real-channel acceptance require separate verification.

Migration `0035_ai_handoff_rules.sql` adds an independent rules table without
changing existing data. Back up the database and apply the forward migration with
a direct database connection before deploying this version. Deployment does not
apply migrations automatically. This change has not been deployed to production.
