# Knowledge asset references and AI delivery

Issue #28, stage T35, reuses the private media library and existing knowledge
index. A manager adds a text document with an optional library asset selection;
the text is its description, limited to 2,000 Unicode code points. Existing
embedding compatibility, indexing states, quota reservation and retrieval apply.
Descriptions do not claim to extract or inspect the file's contents.

Only ready descriptions in the AI's selected knowledge base are retrieved.
Their references require the same workspace, a retained library asset and no
soft deletion. The knowledge list reports unavailable references separately
from index readiness. Removing a knowledge entry or library reference makes it
unavailable to future retrievals. To replace a description, delete its knowledge
entry and add the replacement through the existing document controls.

The model may choose one `mediaAssetId` and must cite its retrieved description.
IDs outside that collection fail grounding even for a factual-free reply. No
provider URLs or storage keys are given to the model. Tests preview the selected
reference and authorized download, recording the result without creating a real
conversation, changing assignment or sending to a channel.

Live commit runs the existing assignment, input freshness and channel checks,
then verifies the selected asset again against this run's persisted retrieved
chunks and pinned knowledge base. It locks the description and asset while
committing all text parts and one attachment in the same short transaction.
Unavailable references produce a diagnostic `MEDIA_UNAVAILABLE` and the existing
safe runtime handoff, without sending a stale file. Grounding failures retain
the configured factual-free fallback or handoff policy.

The attachment stores immutable delivery metadata and the private storage key.
Deleting the library asset or knowledge description after commit cannot change
that message. Text remains subject to the existing maximum of three segments;
the attachment references the final text message as its predecessor, waits for
confirmed success plus one second, and pauses if that predecessor fails. Provider
calls remain outside transactions. Unsupported media, expired windows, missing
objects and provider rejection use existing durable FAILED states; unknown
results remain paused and are not automatically resent.

Text and attachment share the originating run's logical reply group. Analytics
count that answer once and only mark it sent when all its content has succeeded.
The generation and index calls remain within their existing usage operations.

Forward migrations `0032_knowledge_asset_refs.sql` and
`0033_ai_media_reply_order.sql` add the document reference and ordered media
ledger. Production requires a database backup and a separate migration step
before deploying the application. This implementation performs no production
migration, deployment or real-channel send.

Checks cover invalid/deleted references, retrieval isolation, exact persisted
private delivery metadata, duplicate commits, post-commit takeover and deletion,
sandbox non-delivery, model reference grounding, and the browser flow from an
authorized private upload through indexing to a real queue's SENT state using
thin AI/Facebook fakes and the PostgreSQL test database.
