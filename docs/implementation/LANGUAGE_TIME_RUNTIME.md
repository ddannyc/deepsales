# Published language selection and trusted current time

Ticket #40, T25 preserves fixed reply language and adds a separately published
automatic-language switch and IANA time zone. Automatic mode defaults off;
time zone defaults to UTC. The existing required reply-language field is the
initial fallback in automatic mode. English remains supported in both modes.
Legacy snapshots and history restoration use fixed mode and UTC when these
fields are absent. Saving or restoring a draft does not change live settings.

## Language selection

The first AI answer with identifiable customer language establishes that language
for the current Conversation. Until then, the same response model uses at most
the first three meaningful customer texts in its current input to identify the
main language. Uncertain identification returns no selection and uses the
configured fallback, leaving later early input eligible to establish language.
There is no separate detection request or additional billing operation.

The deterministic low-information guard excludes numbers, emoji and URL-only
messages; it requires at least four letters, or two when Han characters are
present. It also excludes common English/Chinese greetings and acknowledgements
listed in `isLanguageBearingText`. The model must additionally decline ambiguous
or low-information language identification. These are project parameters, not
claims about another product's detection algorithm. No confidence setting or
additional classifier dependency is introduced.

Once established, ordinary later input in a different language does not change
the reply language. The same model classifies explicit current requests to change
reply language and returns a validated BCP-47 tag plus an explicit-switch flag.
The answer must use that language. A changed proposal without the flag is invalid
output and follows existing safe failure handling. Low-information input cannot
persist a selection even if the model proposes one. Missing or malformed selection
metadata in automatic mode is also invalid output, not a normal single-turn skip.

PostgreSQL saves a selection atomically with a valid AI reply after the existing
ownership, latest-input and channel-authorization checks. Cancelled generations,
duplicate delivery and fixed-language runs cannot change automatic-language state.
State is scoped to the current Conversation; it is not a customer-profile edit or
cross-channel memory. A retry reads canonical state. Isolated single-turn tests
use the same policy without creating or changing a real Conversation.

## Current time

Every live and isolated model request receives a service-clock UTC instant and
its local date/time in the published zone. The zone is validated and canonicalized
with Intl. The prompt explicitly forbids customer text and historical timestamps
from substituting this clock. Time zone remains explicit in the prompt, page and
history/diagnostic configuration preview; browser time zone is never inferred.
Including both instant and zone distinguishes repeated local hours at daylight
saving transitions. Trusted time does not substitute for company knowledge.

## Migration and acceptance

Apply `0030_language_time.sql` after the preceding migrations and a database
backup, before deploying this release. It adds two defaulted configuration fields
and a nullable Conversation language; no immutable version records are rewritten.
Older code ignores these fields. This implementation does not deploy or migrate
production.

Unit tests cover fallback/low-information selection, explicit switching, malformed
model metadata, bounded samples, cross-midnight dates and both DST transitions.
Real PostgreSQL tests cover persistence and stale-input cancellation. The real
Worker queue with thin model substitutes covers English selection, low-information
input, ordinary later French input, explicit switching, published zone versus
draft edits and duplicate jobs. Browser acceptance covers save/publish/history
restoration and isolated test completion. Real-model language recognition and
response quality, including false-switch rates, still need neutral live examples;
substitute tests do not prove model quality or real-channel acceptance.
