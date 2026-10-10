# Human reply content runtime

Issue #24 adds Messenger human attachments, recording, reusable text templates,
and workspace-private media. Selecting a template only fills the editable text
draft. Uploading, recording, or selecting media never sends it automatically.
One attachment is submitted per message; the separate text draft stays intact.

## Access and delivery

- Active human workspace members can search and manage shared templates and
  media. Downloads require a current authenticated workspace membership.
- New sends require the current human assignee, channel access, an open
  conversation, and the normal Messenger reply window. Uploaded file access
  does not grant permission to send.
- A client UUID makes a media submission idempotent. Reusing it with different
  content is rejected. PostgreSQL commits the message and an immutable attachment
  snapshot before queue delivery; duplicate jobs do not repeat a successful send.
- The Worker uploads the private bytes directly to the provider, stores the
  returned attachment ID, then sends that ID. R2 keys and tokens are never
  returned to the browser. External operations stay outside database transactions.
- Known rejected sends can be retried using the same message and provider upload.
  The retry rechecks ownership, channel access, lifecycle, and reply window.
  Ambiguous sends and failures without evidence of a safe rejection stay failed.
  Media retries require explicit human action, with at most two retries after the
  initial attempt, separated by at least 30 and 120 seconds. A longer provider
  Retry-After is persisted and enforced. Failed media preparation before any
  recipient send is attempted is also safe to retry within those bounds.
- Deleting library media prevents new selections and sends. Already committed
  messages retain their snapshot and authorized download, including pending sends.
  Library deletion is a soft deletion; this release has no object garbage collector.
  Uploaded, deleted, and orphaned objects can therefore continue to incur storage
  costs. Replacing content requires a new upload rather than overwriting bytes.

## Input limits

The application accepts PNG/JPEG/GIF up to 8 MiB; PDF/TXT/ZIP/DOCX,
MP3/WAV/OGG/M4A, and MP4 up to 25 MiB. These are conservative application limits,
not a claim that every permitted file is accepted by every provider account.
Extension, declared MIME, file signature, nonempty size, and UTF-8 text are checked.
This boundary does not fully decode uploaded media or scan files for malware.
Provider rejection is displayed through the existing failed delivery state.

Recording uses browser microphone permission and MediaRecorder, previews a mono
PCM WAV, and stops after 60 seconds. Cancellation releases the microphone and
does not upload or send. Unsupported microphone or decoding capabilities display
an error and preserve the upload alternative. Templates are limited to 100-character
names and 2,000-character text; library searches return at most 100 items.

## Migration and release verification

Apply forward migrations `0022_happy_betty_brant.sql` and
`0023_complex_valkyrie.sql`, and `0024_easy_betty_brant.sql` with the direct migration database URL before deploying
this application version. They add library tables, nullable message retry keys,
attachment references, provider upload records, and retry eligibility timestamps;
existing messages remain valid.
Application deployment does not run migrations. Retain the private R2 binding.

Automated acceptance uses real PostgreSQL and the Worker routes/queue with thin
provider and storage substitutes. Browser acceptance covers recording preview and
cancellation, editable templates, upload failure recovery, workspace isolation,
library selection, and committed media delivery after library deletion.

Actual Messenger acceptance remains pending. Use a dedicated test account to
message the connected Page, open that conversation in the target DeepSales
environment, and obtain its internal UUID from the Network request
`/api/workspaces/<workspaceId>/conversations/<conversationId>/messages`.
Using neutral content, verify actual image, file, audio, and video receipt;
revoke channel access and verify refusal; record account capabilities and API
version without committing account identifiers, credentials, or raw logs.

The provider contract reference is the
[Meta Messenger Platform collection](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api?entity=request-22794852-e8ea7834-a144-4efb-9802-94c9e3148acc).
Substitute tests do not satisfy the actual-account gate.
