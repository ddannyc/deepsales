# AI reply splitting runtime

Stage T51 of issue #40 adds `splitRepliesEnabled` to the AI draft and immutable
published snapshot. It defaults to false, including restored legacy snapshots.
Saving a draft does not change live replies; publishing does. Isolated tests
show the complete generated answer without creating outbound messages.

Enabled live answers longer than 500 Unicode code points are committed as up to
three text messages: the first two contain up to 500 code points each and the
third retains the entire remainder. The existing 2,000 UTF-16-unit response
validation remains in place, so each segment stays within the Messenger limit.
No tail is discarded and surrogate pairs are preserved.

All parts pass the existing ownership, latest-input, channel and language
checks in one PostgreSQL transaction. Their group ID is the originating run ID;
it has no foreign key so retaining committed messages does not depend on run
retention. Unique group/index keys and one terminal run prevent duplicate
commits. Database timestamps increase by one microsecond per segment to retain
order through the existing message cursor and frontend sort.

Queue consumers may arrive out of order. The database only claims a subsequent
part after its predecessor is SENT and its successful completion is at least
one second old. Until then the queue retries without creating a send attempt.
A failed predecessor marks the remaining parts FAILED with a safe paused
explanation. Existing ambiguous-send recovery prevents blind retries. Already
committed parts remain deliverable after a human takes over; fresh input still
cancels an uncommitted stale answer.

One run and one usage operation cover the full answer. Reply analytics count a
group once, count it SENT only when all parts are sent, and count it FAILED if
any part fails. Diagnostics join all parts and retain their individual states;
each part opens the same original run diagnostic.

Migration `0031_split_replies.sql` is additive. Production migration remains a
separate backed-up operator step before application deployment. No production
migration or real-channel send is part of this local implementation stage.

Validation covers Unicode/tail preservation, duplicate delivery, published
snapshot isolation, takeover after commit, a one-second claim gap, ambiguous
failure, paused suffixes, one logical reply and one budget charge. The browser
flow exercises the shared switch and real queue states against thin provider
fakes and a PostgreSQL test database.
