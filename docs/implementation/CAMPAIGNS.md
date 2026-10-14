# Ordinary campaigns

T41 stores an explicit deduplicated snapshot of channel identities. Saving a draft never sends;
execution is a separate action. A campaign sends as the initiating human member without taking
conversation ownership. It requires an active administrator with channel access, an active
connected channel and the normal automatic-message window, both before committing and before
provider delivery. The adapter uses the proactive `UPDATE` purpose. API acceptance is distinct
from delivery and read receipts.

`campaign`, `campaign_run` and `campaign_recipient` persist configuration, occurrence identity,
selection and recipient outcomes. A channel advisory lock serializes message submissions across
campaigns; a committed pending message blocks the next submission. Existing outbound claiming,
private attachment upload, provider receipts and recovery remain authoritative. A received
timeout is not automatically resent. Campaign text retries are bounded to three attempts.

The actual page at `/campaigns` supports explicit audience selection, saved inbox filter controls,
customer creation dates, draft creation, execution, pause/resume/cancel and canonical result reads.
The audience is frozen at save; later customer identity associations do not add recipients.
The initial acceptance covers normal text, concurrent execution, identity deduplication,
unchanged conversation ownership, foreign identity rejection and delivery-time permission/window
revocation. Rich content, translated output, scheduling and recurrence have additional staged
acceptance and are not complete solely because their settings can be saved.

Migration `0047_ordinary_campaigns.sql` follows `0046_controlled_ai_tags.sql`; it adds campaign
tables, indexes and constraints only. Production migration remains a separate operator step.
Utility and marketing capabilities require their separate actual-account gates and are not
implemented by ordinary campaigns.
