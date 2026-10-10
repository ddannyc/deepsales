# Customer facts runtime

Issue #15 adds contact details, scoped properties and tags, and explicit identity links.
The Worker routes are nested below the authorized conversation. PostgreSQL remains
the authority; realtime events only prompt canonical reads.

## Permissions and concurrency

OWNER and ADMIN manage definitions and identity links. An active human AGENT can
edit facts only through their assigned OPEN conversation and permitted channel.
Shared customer facts are unavailable when any linked or contributing channel is
restricted. Conversation messages remain channel-authorized independently, and
restricted shared names are masked in the inbox. Linking never grants channel access.

Workspace row locks serialize fact mutations. Profile and property revisions reject
stale edits with HTTP 409; writes bind to the expected customer so a concurrent
identity relink cannot redirect them. Changing the customer owner never changes assignment.
Property level and type are immutable. Name, options and length changes must still
accept existing values. Manual values default to protected; the explicit automatic
update flag is persisted for the later extraction feature. This ticket does not add
automatic extraction or AI writes.

Property changes preserve value, definition name, human name snapshot, member ID
when available, channel source, timestamp and protection status. Removing a member
does not delete their history. The sidebar loads history in pages of 100 with a stable
timestamp/ID cursor; older records can be loaded under the same permissions.
Clearing a property preserves its revision and history.
Definition deletion shows active-value dependencies and refuses deletion until they
are cleared, then archives the definition. Future audience/rule consumers must add
their references to this dependency check before enabling their own deletion paths.

Tags have separate CUSTOMER and CONVERSATION scopes and case-insensitive names
unique within each workspace and scope. Database unique indexes prevent duplicate
association under concurrent requests. Deleting a tag removes its associations,
not messages or conversations. Inbox tag filtering reads these same associations.

## Identity changes

The UI displays internal identity IDs and channel names, never provider user IDs.
Administrators preview affected conversation count and fact sharing, then explicitly
confirm. The expected current customer prevents competing relinks from overwriting
each other. Linking changes only the identity's customer reference; existing
conversation, assignment history, messages and channel messaging window remain intact.
Unlinking creates an empty independent customer and stops sharing the prior customer's
contact details, properties and tags. Prior customer facts retain source channels,
so removing an identity cannot reveal facts contributed by a restricted channel.

Long-term memory is not present yet. Its later implementation must atomically clear
affected shared summaries on unlink/relink and invalidate old summary work before
it can write again. Each resulting identity must build memory from new communication
after that reset. This is a required future integration contract, not a memory feature
claimed by this ticket.

## Migration and validation

Apply forward migration 0017 with the direct migration URL before deploying
the updated Worker; deployment does not run migrations. It adds nullable contact
fields, revision/provenance state and new fact tables. Existing customers, identities,
conversations, messages and send windows are retained. Provenance is backfilled for
existing names/avatars, and human history gets durable name snapshots. No destructive
backfill or provider calls are required. Review the generated SQL and metadata together.

Authenticated Worker integration tests use real PostgreSQL for revisions, scoped
validation, uniqueness, identity races, isolation and channel permissions. Playwright
covers sidebar edits, definitions, history/dependencies, persisted tags and filtering,
confirmed linking/unlinking and permission feedback. Run integration and E2E sequentially
because the browser runner resets the test database.
