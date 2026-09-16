# M0 Facebook Messenger Technical Spike — Findings

Date: 2026-09-13  

Status: **COMPLETE**  
Verdict: **GO**

## Evidence

| Link | Result |
| --- | --- |
| Meta verification GET -> deployed Hono Worker | Verified at 2026-09-13 16:36:01 Asia/Hong_Kong |
| Real Messenger text -> signed webhook -> Page/PSID/message parsing | Verified at 2026-09-13 16:37:01 Asia/Hong_Kong; inbound ID `m_ESGmK…Do0Vmwg` |
| Deployed Worker -> Graph Send API | `send_succeeded`; outbound ID `m__ND_lq…WWIIFWWA` |
| Wrangler local Worker runtime -> health / verification / signed POST | Verified: `200`, challenge echo, `200 EVENT_RECEIVED` |
| Deployed Cloudflare Worker -> public health | Verified `200` on 2026-09-13 at the private deployment URL (redacted) |
| Deployed webhook without verify-token secret | Verified fail-closed: `403 Forbidden` |
| Fixed reply -> real Facebook user | Tester confirmed receipt of `M0 received your message.` |

The frozen M0 success loop completed against the deployed Worker:

```text
real Facebook user -> Messenger -> Meta webhook -> Cloudflare Worker / Hono
-> fixed reply through Graph Send API -> real Facebook user
```

The initial message did not reach the Worker until the Page/app `messages`
subscription was completed. This is a required setup step, not a product or
runtime incompatibility. Tokens, App Secret, verify token, PSID, and inbound
message text were not recorded.

## Meta findings and permissions

- Runtime mapping for an inbound text webhook:
  `entry[].id` = Page ID, `messaging[].sender.id` = Page-scoped user ID (PSID),
  `messaging[].message.mid` = external message ID, and
  `messaging[].message.text` = text body.
- The Send API request is
  `POST /v26.0/{page-id}/messages` with a Page access token, recipient PSID,
  `messaging_type: RESPONSE`, and a text message.
- `pages_messaging` is required. The person issuing the Page token must be able
  to perform the Page `MESSAGE` task.
- `pages_manage_metadata` is required when subscribing the app to Page
  webhooks through the API. `pages_show_list` is needed only if the future V1
  connection flow lists Pages; M0 can select the Page in the App Dashboard.
- While the app is in Development mode, use a Facebook account with an app
  role and access to the Page. Serving people without app roles requires Live
  mode plus the applicable Advanced Access/App Review approval.
- Meta documents the standard Send API window as 24 hours after the person
  messages the Page. M0's real immediate `RESPONSE` succeeded. The expired
  window and exact production error remain untested.
- `message.mid` is the intended V1 durable idempotency key. Actual Meta retry
  timing and confirmation that a retry preserves the same `mid` have not been
  observed in this environment.
- Invalid/expired token and insufficient-permission error codes remain to be
  captured from the real Page. The Worker records redacted HTTP status and
  Meta error code/subcode/type/message.

The real M0 run did not deliberately invalidate the Page token, force a webhook
retry, wait for the 24-hour window to expire, or test a public user without an
app role. These are explicitly still unverified; none blocks the narrow M0
feasibility result.

The historical fixed-page M0 harness used `META_APP_SECRET`,
`META_VERIFY_TOKEN`, `META_PAGE_ID`, and `META_PAGE_ACCESS_TOKEN`. The current
V1 flow stores selected Page credentials encrypted in the database; see
[`DEPLOYMENT.md`](DEPLOYMENT.md) for the current Worker secrets. `META_APP_ID`
is setup metadata, not a credential. `META_GRAPH_API_VERSION` is pinned to
`v26.0`; `M0_FIXED_REPLY` is non-secret Worker configuration.

## Cloudflare findings and limits

- Hono, native `fetch`, `TextEncoder`, and Web Crypto HMAC-SHA-256 passed a
  Wrangler local-runtime signed request; no Meta or Node compatibility SDK is
  needed.
- The Worker validates the signature before acknowledging, then uses
  `executionCtx.waitUntil()` for the Send API call so Meta receives a fast
  `200 EVENT_RECEIVED` response.
- `waitUntil()` gets at most 30 seconds after the response and has no durable
  retry. It is acceptable only for M0; V1 must use the already-decided
  Cloudflare Queue/outbound delivery flow.
- Current Workers limits relevant to M0 include 128 MB memory, 50 subrequests
  per invocation on Free, and 10 ms Free-plan CPU time. M0 makes one outbound
  subrequest per text event and only performs small JSON/HMAC work.
- M0 duplicate suppression is isolate-local and capped at 1,000 message IDs.
  It is deliberately not a V1 guarantee. V1 must enforce webhook idempotency
  with PostgreSQL uniqueness as required by `INV-15`.
- Secrets belong in Wrangler encrypted secrets; `.dev.vars` is local-only and
  gitignored. Logs contain IDs and Meta errors but never tokens, App Secret,
  verify token, PSID, or inbound text.

## Decision impact

No change to `TECHNICAL_DECISIONS.md` or `LEAN_V1_PRD.md` is required. The real
deployment supports the frozen Messenger/Cloudflare direction, and the known
M0 shortcuts already have V1 decisions: Cloudflare Queues for durable outbound
work and PostgreSQL uniqueness for durable webhook idempotency.

M0 is `GO`. This document records the historical feasibility gate; current
development has continued beyond M0.

## Primary references

- [Meta Messenger Platform API collection](https://www.postman.com/meta/messenger-platform-api/collection/iyp204x/messenger-platform-api)
- [Meta Messenger Send API](https://www.postman.com/meta/messenger-platform-api/folder/vilwbh4/send-api)
- [Meta Messenger webhook setup](https://developers.facebook.com/docs/messenger-platform/webhooks)
- [Meta Graph API versions](https://developers.facebook.com/docs/graph-api/changelog/versions)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare execution context](https://developers.cloudflare.com/workers/runtime-apis/context/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
