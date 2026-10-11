# Published advertising reference mappings

Ticket #17, T30 adds one advertising-ID mapping table per AI member. It uses
the existing signed Facebook referral ingestion; it does not fetch ad APIs,
referral URLs, images, or unmapped advertising content.

## Configuration and publication

Managers upload a JSON array of `{ "adId": "123456", "content": "Reference text" }`
into the AI configuration draft. Saving validates and replaces the entire table
atomically. Empty arrays clear it. Invalid input cannot overwrite the saved table.
The upload preview is an unsaved draft until explicitly saved.

Project limits: 1 MiB request/file size, 100 rows, unique decimal-string IDs of
1–200 digits, and 1–2,000 Unicode code points of trimmed content per row. Extra
fields are rejected. These are application limits, not provider defaults.

The enable switch and table take effect only on publication. Both belong to the
immutable version snapshot. History restoration changes only the draft. Versions
without these fields restore a disabled switch and empty table; they are not
backfilled or rewritten. Independent resources retain their current state.

## Runtime source and authorization

The Worker pins the published snapshot on first claim and resolves the latest
referral for the conversation's exact channel identity as of the last customer
input. A timestamp-free referral linked by that input's external message ID can
be selected even if processed later. A future timestamped referral is excluded.
Linked identities and other channels are never included. A later non-ad source
supersedes an older ad source. Source history may span closed conversations for
the same channel identity.

The selected context is pinned on the run before provider calls, including
missing-source and unmapped results. Retries reuse it. Every resolution checks
the active AI member, workspace, active channel and current channel access;
revocation replaces the context with unavailable and removes its content.
Reply commit also checks current channel authorization under the workspace lock,
so removing access during generation prevents a customer-visible commit.

Statuses are explicit: `DISABLED`, `NO_SOURCE`, `UNAVAILABLE`, `UNMAPPED`, or
`MAPPED`. All but mapped continue without advertising content. Diagnostics show
the selected status and, when authorized, the actual ID and mapped reference.

Mapped text is used in the knowledge retrieval query and a separate escaped,
untrusted prompt data section. Referral titles and URLs are excluded. Advertising
text is never a knowledge citation; business facts still require valid retrieved
knowledge chunk IDs. Prompt boundary and grounding checks do not imply that a
real model is immune to all semantic prompt injection.

## Deployment and verification

Apply forward migration `0028_advertising_mappings.sql` before deploying this
release, after the existing backup/operator procedure. It adds defaulted draft
columns and a nullable run-context column. Existing published snapshots remain
disabled until republished with advertising enabled. Older code ignores the new
snapshot fields; rolling back code stops this capability without deleting data.

Verification uses authenticated Worker routes, real PostgreSQL publication,
restoration and permissions, Worker queue execution with thin AI substitutes,
prompt escaping/grounding checks, and the AI configuration browser flow.
Real account ad-source permissions and real-model behavior remain release gates;
local substitute verification does not satisfy those gates. Isolated AI tests
have no advertising source; simulated advertising is outside T30.
