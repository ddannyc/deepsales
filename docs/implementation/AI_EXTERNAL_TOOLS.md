# External HTTPS tools

External plugins belong to one workspace, AI member and channel. A plugin groups
API tools under one fixed origin and credential. Managers need the intersection
of their own and the AI member's active channel grants to configure, list, debug
or insert these tools. Manager roles do not grant all channels. Definitions save
immediately; plugin/credential edits also increment dependent tool revisions.
Deletion is soft and retains action receipts. Main instructions and skills must
reference valid enabled tools when published. Runtime authorizes only main plus
the selected skill, never all matching skills.

The existing instruction picker inserts `[[tool:external:<tool UUID>]]`.
Model calls contain `tool: external` and `arguments: {definitionId, values}`.
Only declared primitive inputs are accepted. Locations are `path`, `query`, or
`body`; path segments are constrained and encoded, query uses URLSearchParams,
and body uses JSON. Models cannot choose hosts, headers or override fixed fields.
Outputs use bounded own-property field paths, at most four levels, mapped to
declared primitive types. Unselected fields and credentials never enter prompts.

## Deployment and migration

Apply the forward-only `0052_external_tools.sql` migration separately before
deployment, after `0051_ai_skills.sql`, with a direct migration URL and the normal
backup/operator process. Application deployment never migrates the database.
Development validation applied migrations only to the local test database.

Set the nonsecret Worker variable `AI_TOOL_ALLOWED_ORIGINS` to a JSON array of exact
canonical public HTTPS origins, for example `["https://api.example.com"]`.
The example configuration defaults to `[]`, disabling external egress. There are
no wildcard hosts, dynamic origins, IP literals, special/local hostnames or
redirects, including same-origin redirects. Port 443 is the only admitted port.
The operator must trust the destination and its DNS ownership/configuration.
This is deliberately not arbitrary-domain admission, DNS pinning or proof against
an untrusted provider changing its DNS to private addresses. No DNS service,
proxy or additional infrastructure is introduced.

Credentials use the existing `TOKEN_ENCRYPTION_KEY` Worker secret and shared
AES-256-GCM implementation, random 12-byte IVs and version `v1`. External
credentials additionally bind authenticated data to workspace/plugin identity.
Existing Facebook ciphertext remains compatible. Configuration reads return only
`configured`, never plaintext, ciphertext, IV or key versions. Blank edits retain
the credential only while the origin is unchanged; changing origin clears the
old credential unless an explicit replacement is supplied. The new provider never
receives a retained credential from the previous origin. Explicit clearing also
removes the credential. Replacing the encryption key is an
operator migration: back up and re-encrypt existing channel tokens and tool
credentials before switching keys. Changing the secret alone cannot decrypt old
data; no automatic key rotation or credential migration is claimed.

## Write object policy and uncertainty

A write definition must declare an `objectScope` JSON policy, for example:

```json
{"policy":"FIXED_CONFIG","description":"Authorized fixed support record","targets":[{"name":"recordId","location":"body"}]}
```

Every declared target must exist as a nonempty immutable fixed parameter. Target
inputs cannot overlap model parameters; write path variables also require fixed
values. The plugin's fixed channel supplies the local authorization scope.
The configuring manager is responsible for the API's actual effect classification
and target semantics. A fixed field is an authorized configuration binding, not
automatic verification that an arbitrary third-party object belongs to a customer
or tenant. Only configure APIs whose provider permissions and object semantics
are understood. Typed parameters, bearer credentials and an allowlisted origin
alone do not establish remote object ownership.

Each stable action retains one durable ID and ordinal in the range 0–2. Migration
0053 adds a conservative reserved execution-slot counter and durable retry time.
The entire logical turn has at most three slots across built-ins, external calls
and safe read retries; final generation cannot open a new action plan. Successful
replays compare typed argument maps independently of JSON object key order and
make no new provider request. An expired in-flight action becomes UNKNOWN,
never a new dispatch. Proven transient READ failures (transport, timeout, HTTP429
or HTTP5xx) may retry under the same action ID, rule/event, operation and charge,
after 30/120 seconds or a longer provider Retry-After. Each retry reserves another
slot atomically and rechecks current definitions, inputs, ownership and grants;
exhaustion stops dependent replies. Replaying success consumes no slot. Other
failures terminate, and dispatched WRITE failures remain UNKNOWN. There is no
invented provider idempotency header. Unknown actions pause dependent generation, and
outstanding UNKNOWN actions block further external actions in that Conversation,
including attempts from a later customer input. Human handling must investigate
the provider's authoritative records; closing/handling a conversation does not
undo an external operation. No UI control fabricates a successful reconciliation.
Provider-specific idempotency or result-query recovery remains disabled until an
actual documented provider contract is implemented and verified.

The ten-second deadline covers fetch and streamed reading. The adapter accepts
identity-encoded JSON only, requests `Accept-Encoding: identity`, and rejects
compressed responses. It caps exposed body bytes at 65,536 before decoding and
mapped output separately. Errors discard provider bodies and expose stable codes.
After possible write dispatch, timeout, connection loss, HTTP errors or invalid
responses conservatively mean UNKNOWN; they do not prove the write failed.
Cleanup aborts/cancels without waiting indefinitely for a noncooperative stream.

An observed successful receipt is retained even after reassignment, new input or
definition changes. Permission to use it for a reply is checked separately before
generation and atomically at final commit. `usedToolActionIds` references only
current successful mapped evidence; it never impersonates a knowledge chunk.
Previously committed valid messages retain independent delivery semantics.

## Testing and debug

Configuration debug, TEST and BATCH all simulate external actions before any
production credential lookup, decryption or fetch. They return visibly simulated
typed fixture values. A debug success establishes configuration/schema behavior,
not provider availability or a real write result. Live diagnostics retain stable
call ID, definition revision, status and safe failure metadata under channel grants.

Validation uses real local PostgreSQL and Worker routes/queues with fake AI,
channel and external fetch adapters, plus Playwright configuration/insertion/debug
flows. No real third-party API, paid provider request, production migration,
deployment or external send was performed for this implementation.

Retry deadlines are validated at both the HTTP adapter and durable receipt boundary.
Malformed, negative, fractional, non-finite or unrepresentable delays terminate the
known failed action with `EXTERNAL_RETRY_AFTER_INVALID`; they do not roll back its
receipt or become an earlier retry. Model-provider attempts use the same deadline
validation and persist `INVALID_RETRY_AFTER` on their operation.

Queue retries wake at most 43,200 seconds later, a conservative application window.
PostgreSQL retains the complete valid provider deadline, and every early wake must
pass the existing claim guard before dispatch. This window is below Cloudflare's
current [24-hour queue delay limit](https://developers.cloudflare.com/queues/platform/limits/);
it does not shorten the provider's requested backoff.
