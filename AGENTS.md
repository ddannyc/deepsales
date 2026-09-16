# DeepSales agent guide

## Project overview

DeepSales is a self-hosted Lean V1 shared inbox for Facebook Messenger. It is
a TypeScript pnpm monorepo with a React/Vite SPA, a Hono Cloudflare Worker,
and a PostgreSQL/pgvector database. The Worker also uses Cloudflare Queues,
Durable Objects, and private R2 storage. PostgreSQL is the source of truth for
domain correctness.

Before major implementation work, read the authoritative documents in this
order:

1. [Lean V1 PRD](docs/product/LEAN_V1_PRD.md)
2. [Architecture invariants](docs/architecture/ARCHITECTURE_INVARIANTS.md)
3. [Technical decisions](docs/architecture/TECHNICAL_DECISIONS.md)
4. [Implementation specification](docs/implementation/V1_IMPLEMENTATION_SPEC.md)
5. [Project context](docs/architecture/CONTEXT.md)

## Architecture and repository structure

- `apps/web`: React SPA entrypoint and plain CSS UI.
- `apps/worker`: Hono routes, authentication, Facebook adapter, queue and scheduled handlers, and realtime Durable Object.
- `packages/db`: Drizzle schema, PostgreSQL domain operations, and committed SQL migrations.
- `e2e`: Playwright browser flows.
- `config`: environment loading and test-database safety checks.
- `scripts`: local setup, E2E, and migration helpers.
- `docs`: product, architecture, implementation, operations, research, and planning records.
- `.github/workflows`: formatting, lint, typecheck, unit, audit, build, PostgreSQL integration, E2E, CodeQL, and dependency-review checks.

Keep the modular-monolith shape. Domain operations live in the Worker and
database package; Cloudflare, Facebook, storage, and AI provider details stay
behind thin adapters. Do not add per-domain packages or services for V1.

## Commands

Use Node `.node-version` (`24.21.0`) and pnpm `10.30.0`.

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm build
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
pnpm db:generate
pnpm db:migrate
pnpm audit
pnpm run deploy
```

`pnpm dev` builds the web app, then starts Wrangler Worker development. The
Worker serves the built SPA from `apps/web/dist`.

Integration and E2E tests require a local PostgreSQL/pgvector database whose
name ends in `_test` or `_e2e`. Set `APP_ENV=test` before test migrations.
`pnpm test:e2e` resets and migrates its test database; do not run integration
and E2E tests concurrently.

## Coding conventions

- Use strict TypeScript and existing module/domain seams.
- Follow `biome.json`: spaces, 100-column width, single quotes, and no semicolons.
- Validate HTTP, queue, provider, and AI-output inputs with the existing Zod boundaries.
- Prefer existing helpers and native `fetch`/runtime capabilities; add a dependency or abstraction only for a demonstrated V1 need.
- Keep database transactions short. Never perform provider, storage, queue, realtime, or other external calls inside a PostgreSQL transaction.
- Keep changes vertical and narrow; do not mix unrelated cleanup with feature work.

## Architectural invariants

Preserve the invariants already represented by the schema, domain code, and
integration tests:

- Human and AI are one first-class `Member` model. `User` is authentication; AI members have no login identity.
- All conversation ownership changes go through the assignment boundary (`executeAssignment`) and write `ConversationAssignment` history. Do not update `conversation.assignee_member_id` directly from routes or handlers.
- PostgreSQL transactions, locks, constraints, and indexes decide ownership, capacity, lifecycle, idempotency, AI commit authorization, and delivery state. Queues, Durable Objects, realtime, memory, and caches are not the authority.
- A channel identity has at most one `OPEN` conversation. Duplicate Facebook message IDs must be durable-idempotent.
- AI output may commit a customer-visible message only while the AI is still assigned and the run's customer input is still current. Stale runs are cancelled; a valid committed `PENDING` message remains deliverable after later ownership changes.
- AI handoff sets `HUMAN_ONLY` and keeps it through human assignment until close or an explicit human-to-AI transfer.
- Queue fields describe unassigned conversations only; successful assignment clears them. `routing_constraint` is independent and may persist after assignment.
- Company-specific AI answers must be grounded in configured knowledge or safely fall back/handoff.
- Facebook identifiers, Page tokens, Messenger-window state, and provider errors stay in the Facebook boundary, not core Conversation or Member models.
- Realtime is an invalidation mechanism. UI state must be recoverable from canonical API/database reads.

## Security and secrets

- Never commit `.env*`, `.dev.vars*`, tokens, customer data, production logs, or provider credentials. Only the example files belong in the repository.
- Put Worker secrets in Cloudflare Worker Secrets; keep non-secret deployment variables in `apps/worker/wrangler.jsonc`.
- The Worker uses Hyperdrive for PostgreSQL. Migration tooling uses a direct database URL, preferably `DATABASE_URL_UNPOOLED`; do not put migration URLs in Worker secrets.
- Preserve raw-body Facebook HMAC verification, same-origin mutation checks, rate limits, workspace authorization, encrypted Page/source tokens, private R2 objects, and redacted provider errors.
- Do not log tokens, OAuth state/codes, external user IDs, inbound text, prompts, knowledge text, raw attachment URLs, or customer data.

## Database and migrations

- Treat `packages/db/src/schema.ts` and `packages/db/drizzle/*.sql` as one change: update the schema, run `pnpm db:generate`, review the generated SQL, and commit the migration and metadata.
- Migrations are forward-only. Production migrations are a separate operator step with a direct URL; application deploy does not run them automatically. Destructive changes require backup and explicit operational handling.
- Keep pgvector provider/model/dimension compatibility intact. Changing the embedding space requires the documented reindex workflow; do not mix vector spaces or run `scripts/reindex-knowledge.sql` as an online production migration.

## Testing expectations

- Add or update the smallest relevant test with behavior changes, especially for security and data-handling paths.
- Use unit tests for pure adapters, parsing, validation, AI policy, and file handling.
- Use real PostgreSQL integration tests for constraints, transactions, locks, uniqueness, assignment races, AI freshness/ownership races, idempotency, and delivery state.
- Run the relevant Playwright flow for browser, route, queue, or user-facing changes. The E2E runner uses fake Facebook/AI services and a real test database.

## Frontend rules

For any frontend or user-facing UI work, read [docs/DESIGN.md](docs/DESIGN.md)
before implementation. Keep detailed design rules there rather than copying
them into this guide.

The current frontend is a React SPA in `apps/web/src/main.tsx` with plain CSS
in `apps/web/src/styles.css`, native `fetch`, and local React state. Preserve
that shape and the existing async states (`PENDING`, `SENT`, `FAILED`, loading,
and error states); do not add a UI framework, global state library, or query
library without an explicit requirement.

## Change boundaries

- Implement frozen Lean V1 only. Deferred V1.1 features need an explicit product decision.
- Do not introduce D1, Redis, Kafka, microservices, external vector stores, alternate runtimes, or speculative provider abstractions without a measured V1 blocker and an explicit decision.
- Do not bypass domain boundaries or move correctness into Cloudflare services to simplify a caller.
- Follow the existing workspace/tenant authorization model on every read and write.
- Preserve unrelated worktree changes and keep the diff limited to the requested files.

## Definition of done

A change is done when the requested behavior is implemented, relevant tests and
documentation are updated, no secrets or unrelated edits are present, and the
affected validation passes: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`,
`pnpm test`, plus relevant integration, E2E, and `pnpm build` checks. For
database changes, the reviewed forward migration and operational notes are
included. Inspect the final diff before handoff.
