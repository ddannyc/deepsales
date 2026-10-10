# Inbox collaboration runtime

Implements #21 (T11–T13) for existing one-to-one Messenger conversations.

## Internal notes

Notes use `conversation_internal_note`, independently of customer `message` rows.
Only active authorized human members can read or create them; agents also require
channel access. Notes never enqueue outbound delivery and are excluded from AI
history and knowledge retrieval. The separate notes panel displays author, time,
and text, with 50-item cursor pages. Closed conversations remain readable but
reject new notes.

Creation locks the conversation and uses a client UUID scoped to conversation
and author. Retrying identical text returns the existing note, including after
close; changing text with the same key is rejected. Failed or uncertain saves
retain the draft and key in the current panel. Editing starts a new submission.
Author names are snapshots, retained if the member is deleted. Realtime only
invalidates state; reopening or refreshing reads the canonical API.

## Personal mute

`conversation_member_mute` persists one preference per member and conversation.
The personal list filter can exclude or show muted conversations and is included
in saved views. Other members retain their own preferences. Muting never changes
assignment, routing, unread watermarks, message persistence, or AI execution.
The current application has no sound or system notifications; the UI explicitly
states that this setting currently affects personal list filtering only.

## AI hosting

Hosting is the existing canonical assignment to an AI member, not a separate
flag. **接管** uses the existing takeover operation and assignment history,
cancelling uncommitted stale runs. **交给 AI 托管** requires selection and explicit
confirmation, then uses the existing transfer operation. Permissions, channel
access, runtime usability, published configuration and capacity remain checked
server-side. A capacity override retains the existing additional confirmation.
Explicit transfer to AI clears `HUMAN_ONLY`. An already committed valid pending
customer message remains deliverable after takeover.

## Migration and validation

Apply reviewed forward migrations `0020` and `0021` using the documented direct
database migration workflow before deploying the application. They add the two
tables and indexes without rewriting customer messages or assignment history.
Application deployment does not run migrations.

Worker/PostgreSQL tests cover concurrent note retries, separate message/outbound
paths, pagination, closed history, workspace/channel authorization, revoked
access, personal filter isolation and unchanged inbound assignment. The AI
consumer test checks notes are absent from retrieval and model prompts. Existing
PostgreSQL takeover/commit race tests cover both lock orders and retained valid
commits. Playwright covers uncertain saves and retry, pagination, provider send
count, personal mute persistence/isolation, new inbound messages, list filters,
and explicit AI transfer confirmation and takeover.
