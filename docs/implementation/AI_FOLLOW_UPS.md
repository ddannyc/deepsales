# AI follow-up rules

Follow-up rules take effect immediately and independently of AI draft publication.
Managers can create, edit, enable, disable and delete rules. Each edit increments
the revision and starts a new effective interval; anchors from before that interval
do not become eligible retrospectively. Deletion retains trigger history.

A rule waits from either the most recent assignment to the current AI or its last
confirmed `SENT` reply. `SENT` means the channel send API confirmed success, rather
than a customer delivery receipt. A reply from an earlier assignment cannot revive
a timer. Later replies reset reply-based timers. Waiting requires an actual customer
message and does not insert a synthetic customer message.

Conditions reuse the customer/conversation property and tag condition model: AND
within a group and OR between groups. No groups means unrestricted audience;
invalid or inaccessible references fail closed. Preview reports current matching
conversations, with a displayed scan limit; sending still rechecks every runtime
gate. Property and tag conditions use current observed facts. They do not reconstruct
historical fact changes. A known weekly stop interval crossed since the anchor
invalidates that timer, including timezone and daylight-saving boundaries, without
emitting a stop-ending message or changing unrelated stop state.

The durable trigger identity is `(rule ID, conversation ID)`, including failed and
cancelled attempts. Editing, disabling, deleting or retrying does not restore that
opportunity. A genuinely new rule or a new conversation has a separate opportunity.
Simultaneously due rules run serially. Pending or ambiguous outbound delivery blocks
later follow-ups; confirmed replies change subsequent reply-based anchors.

Scheduled discovery reads at most 100 candidate conversations per invocation. A
keyset cursor continues the scan through the existing maintenance queue, so a full
page of nonmatching candidates cannot indefinitely hide later matches. Cron starts
from the beginning again. Cursors are scheduling hints only: repeated pages still
pass through current eligibility checks and PostgreSQL trigger uniqueness.

Each trigger authorizes an independent proactive run using bounded conversation
history. Empty requirements produce a general check-in. Company claims still need
configured knowledge. Owner, customer input, rule revision, audience, stop settings,
channel authorization/window and budget are checked again before committing output.
New input, reassignment, closure or invalidated conditions cancel uncommitted work.
A valid committed `PENDING` message remains deliverable after ownership changes.

Generation and safe failures reuse the existing bounded retry mechanism: at most
three provider attempts, with 30/120-second backoff, one trigger and one logical
charge. Unknown provider or send results pause for evidence rather than blind
retries. The event list exposes run, operation and delivery status; an operator must
resolve ambiguous delivery through the existing channel handling process.

Migration `0049_proactive_follow_ups.sql` adds rules and durable events, and permits
the `FOLLOW_UP` operation kind. It is forward-only and must be applied separately
before deployment using the documented migration process. Development validation
applied it only to the local test database. Tool selection and the dedicated
follow-up variable editor belong to the later dependent stage.
