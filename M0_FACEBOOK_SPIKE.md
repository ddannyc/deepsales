# M0 Facebook Messenger Technical Spike

## Purpose

Before implementing the full product, prove the highest-risk external integration:

**Facebook Messenger <-> Cloudflare/Hono <-> Facebook Messenger**

This is a technical feasibility spike, not a full product feature.

## Goal

A real Facebook test user sends a text message to a test Facebook Page.

The system:

1. receives the webhook
2. validates/parses it
3. logs or stores the minimal event/message information needed for the spike
4. sends a fixed text reply through the Messenger Send API
5. the user receives that reply

## Success Criterion

This exact loop works reliably in the intended deployment environment:

```text
Facebook test user
  -> Messenger
  -> Meta webhook
  -> Cloudflare Worker / Hono
  -> fixed reply through Meta Send API
  -> Facebook test user receives reply
```

Do not proceed to large-scale V1 implementation until this works.

## Questions the Spike Must Answer

1. Can Meta webhook verification and delivery work correctly against the deployed Worker URL?
2. What exact Page/User permissions are required for the test setup?
3. Can the app obtain/store/use the required Page access token correctly?
4. What webhook payload identifies:
   - Page
   - external customer identity
   - message ID
   - text body
5. How does Meta represent duplicate/retried webhook delivery?
6. Can the Worker send a text message to the correct PSID?
7. What errors occur when the Page token is invalid or insufficient?
8. What deployment/configuration secrets are required?
9. Are there any Cloudflare Worker runtime incompatibilities with the chosen Meta API client approach?
10. Does the normal Messenger reply-window behavior match the assumptions in the Lean V1 PRD?

## Spike Scope

Implement only:

- Hono webhook endpoint
- Meta webhook verification
- minimal signature validation as required
- minimal environment/secrets configuration
- parsing one inbound text message
- basic duplicate protection if needed for reliable testing
- fixed outbound text reply
- basic structured logging
- deployed test environment

Do not implement:

- Workspace
- User
- Member
- Conversation domain
- Assignment
- AI
- Knowledge base
- React inbox
- production-grade multi-tenant OAuth flow
- historical sync
- general event abstraction
- reusable multi-provider channel framework beyond the minimum interface boundary

## Deployment Target

Primary:

- Cloudflare Workers

Use a minimal real deployment, not only a local tunnel, because the spike must validate the intended production runtime.

## Suggested Minimal Endpoints

```text
GET  /webhooks/facebook
POST /webhooks/facebook
GET  /health
```

Exact Meta verification details should follow the current official Meta documentation at implementation time.

## Required Configuration

At minimum, expect secrets/config similar to:

- Meta App ID
- Meta App Secret
- Webhook Verify Token
- Facebook Page ID
- Page Access Token
- Graph API version

Do not hardcode secrets.

## Logging

Log structured, redacted diagnostics for:

- webhook received
- page identifier
- external message identifier
- inbound message type
- send attempt
- send success/failure
- Meta error code/message

Never log access tokens or secrets.

## Deliverables

The spike is complete when the repository contains:

1. runnable/deployed Hono Worker
2. documented environment variables
3. exact setup steps for the Meta test app/page
4. automated tests for request parsing where practical
5. evidence/log notes of one successful real end-to-end message
6. notes on any discovered Meta/Cloudflare constraints
7. a clear recommendation:
   - `GO`
   - `GO WITH CHANGES`
   - `NO-GO`

## Stop Conditions

If the spike reveals a blocker, do not work around it by redesigning the full product.

Record the blocker first.

Examples:

- required Meta permission cannot be obtained for intended use
- Worker runtime cannot support a required cryptographic/API operation
- reply semantics materially differ from PRD assumptions
- production webhook requirements conflict with chosen deployment model

Then revisit the relevant technical decision deliberately.
