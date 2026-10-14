# Ordinary campaigns

T41–T44 store an explicit deduplicated snapshot of channel identities. Saving a draft never sends;
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
Retry deadlines persist in the existing delivery-attempt ledger and apply across campaigns on
the same channel, including after one campaign exhausts its attempts. A delayed maintenance
tick continues eligible sends; the scheduled recovery scan remains the fallback.

The actual page at `/campaigns` supports explicit audience selection, saved inbox filter controls,
customer creation dates, draft creation, execution, pause/resume/cancel and canonical result reads.
The audience is frozen at save; later customer identity associations do not add recipients.
Content blocks contain text or existing private media. Reply templates copy their current text
into the saved content version. ALL retains order; RANDOM freezes one selection per occurrence
and identity. Translation retains source and translated blocks per recipient and one durable
logical translation operation with separate provider stages. Failure stops that recipient;
unknown results visibly pause the campaign without regeneration or automatic resend.

Scheduling stores the chosen IANA zone and local calendar time. The default is explicit UTC.
Past starting times and nonexistent/repeated daylight-saving starting times are rejected.
DAILY and WEEKLY recurrence preserve local time; future missing/repeated local occurrences are
skipped. A maximum occurrence count or end time stops new rounds while already committed work
finishes. Recovery skips recurring occurrences missed by more than five minutes and schedules
the next future one; it never backfills a burst of historical rounds. Paused/cancelled campaigns
do not submit unsent blocks; committed messages remain independently deliverable.

Result reads use bounded cursors: three rounds and twenty recipients per round per page.
The page can load earlier rounds or more recipients without dropping the retained ledger.
Acceptance covers concurrent execution, stable random selection, ordered private attachments,
translation recovery and usage, channel revocation, durable retry deadlines, recurrence/DST,
partial cancellation and the real browser create-to-result workflow with fake external services.

Migration `0047_ordinary_campaigns.sql` follows `0046_controlled_ai_tags.sql`; it adds campaign
tables, indexes and constraints only. Production migration remains a separate operator step.
Utility and marketing capabilities require their separate actual-account gates and are not
implemented by ordinary campaigns.
