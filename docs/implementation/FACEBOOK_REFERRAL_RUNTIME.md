# Messenger source timeline

Implements #17 / T05, the independently deliverable source-intake stage. The
AI advertisement mapping stage (T30) remains separate and is not implemented
or accepted by this change.

## Intake and durable identity

- The signed Facebook webhook accepts standalone `referral` and
  `message.referral` data into a bounded, versioned `facebook.referral` job.
  Queue parsing validates all retained fields and drops unrecognized data.
- A standalone event requires a reliable provider timestamp. An embedded
  event may instead use its provider message ID when that timestamp is
  unavailable. Events lacking both are skipped rather than assigned invented
  timestamps or message IDs.
- The channel identity and a normalized source fingerprint uniquely identify
  each event. Timestamped events deduplicate across standalone/message forms.
  Fingerprints include source/type/ref/ad ID/referrer, excluding presentation
  metadata. The existing channel/user advisory lock serializes identity
  creation and source updates with ordinary inbound-message intake.
- Late duplicates may fill a missing title, image URL or message association;
  they do not overwrite already obtained values. Acquisition time preserves
  the earliest ingress time. Timeline order uses provider time when available,
  otherwise ingress time, and a stable UUID tie-breaker.
- Copies of an embedded event also reconcile by the identity/message ID when
  timestamp availability changes. If a timestamped copy later connects a
  MID-only source and a standalone source, the two records merge atomically.
  Without that timestamped association the two forms cannot safely be inferred
  to represent the same event. A cursor referencing a merged record requires
  a timeline refresh rather than silently jumping to another page.
- Sources belong to the original channel identity, independent of subsequent
  customer identity linking/unlinking. Embedded message association is resolved
  against the real customer message in that same channel and identity, so
  either queue order works without inventing a Message.
- Referral processing creates no Conversation, Message, assignment, AI run,
  read watermark or Messenger reply-window authorization. Only real inbound
  messages follow the existing conversation/routing/window pipeline.

## Authorized display

`GET /api/workspaces/:workspaceId/conversations/:conversationId/referrals`
requires an active authenticated inbox viewer and the conversation's channel
access. It returns only that conversation's channel identity sources, 50 per
page, with an identity-scoped `before` UUID cursor. Other linked identities
and tenants are excluded. Sender IDs and source details are never logged.

The customer sidebar displays available source/type, ref, ad ID, title,
identity and real-message association, with separate platform/acquisition
times. Missing information remains unknown. Referrer addresses are plain
text. Supplied HTTPS image URLs are retained as source metadata but are not
rendered or fetched, avoiding arbitrary network requests and third-party
tracking. No Marketing API lookup or advertisement-window exception is
enabled by an ad ID.

## Migration and rollout

Back up the database, review and apply forward migration
`0026_facebook_referrals.sql` after the preceding migrations, then deploy the
Worker and SPA together. It adds a source table and indexes, with no changes
to existing customer messages. Rolling back the application stops new source
intake; leave the additive table and its data intact.

New Page connections request `messaging_referrals` alongside existing message
and receipt subscriptions. Existing Pages need an operator to refresh their
Page/app webhook subscriptions; deployment alone cannot retrofit Meta
subscription settings. Verify the subscription and a neutral real-account
entry before accepting provider capability. No broader ad-read permission
is requested.

## Evidence and remaining gate

Unit tests validate both event forms, recipient matching, echo exclusion,
timestamp requirements, bounded fields and URL rejection. Authenticated Worker
tests use signed ingress, the real queue handler and migrated PostgreSQL to
verify concurrent deduplication, both message/source ordering, no phantom
message/routing/window activity, tenant/channel isolation, linked-identity
isolation and tied-timestamp pagination. Playwright exercises the actual
customer sidebar and verifies that source images are not rendered.

Meta's reference endpoints were checked during implementation but returned
fetch failure/rate limiting; they are not recorded as newly verified
contracts. The retained field shape remains subject to the real-account gate:

- <https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messaging_referrals>
- <https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messages>

Actual account event availability and subscription permission revocation are
not validated by local substitutes. Until that gate is complete, do not claim
real advertisement entry acceptance or enable any reply-window exception.
