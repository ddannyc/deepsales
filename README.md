# DeepSales

DeepSales is an early-stage shared inbox for Facebook Messenger. It is a
React SPA and Hono Cloudflare Worker backed by PostgreSQL/pgvector, Cloudflare
Queues, Durable Objects, R2, and Alibaba-compatible AI APIs.

This repository is for self-hosted development. It is not a hosted service and
does not currently promise production readiness or support. Each deployment
needs its own Cloudflare, Neon/PostgreSQL, Meta, and AI-provider accounts.

## Repository layout

- `apps/web` — React frontend.
- `apps/worker` — Hono API, queues, webhooks, authentication, and realtime.
- `packages/db` — PostgreSQL schema, migrations, and domain operations.
- `e2e` — Playwright end-to-end tests.
- `scripts` — local setup, migration, and test helpers.

`apps/worker/wrangler.jsonc` contains non-secret deployment identifiers and
configuration. Keep API keys, access tokens, database URLs, and auth/encryption
secrets in ignored environment files or Cloudflare Worker Secrets.

## Documentation

The full documentation index is in [`docs/README.md`](docs/README.md).

Repository guides:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development and pull request checks.
- [`SECURITY.md`](SECURITY.md) — vulnerability reporting and data-handling rules.
- [`docs/operations/DEPLOYMENT.md`](docs/operations/DEPLOYMENT.md) — production provisioning and deployment.

Product and architecture:

- [`docs/product/LEAN_V1_PRD.md`](docs/product/LEAN_V1_PRD.md) — frozen product requirements.
- [`docs/architecture/CONTEXT.md`](docs/architecture/CONTEXT.md) — project vocabulary and routing policy.
- [`docs/architecture/ARCHITECTURE_INVARIANTS.md`](docs/architecture/ARCHITECTURE_INVARIANTS.md) — non-negotiable correctness rules.
- [`docs/architecture/TECHNICAL_DECISIONS.md`](docs/architecture/TECHNICAL_DECISIONS.md) — stack and design decisions.
- [`docs/architecture/DATABASE_ER.md`](docs/architecture/DATABASE_ER.md) — database relationships.
- [`docs/implementation/V1_IMPLEMENTATION_SPEC.md`](docs/implementation/V1_IMPLEMENTATION_SPEC.md) — implementation contract.

Research and planning are grouped under [`docs/`](docs/):

- `docs/research/` — Messenger feasibility and technical research notes.
- `docs/planning/` — implementation ticket drafts retained until a project tracker is connected.

## Local setup

```powershell
pnpm install --frozen-lockfile
Copy-Item apps/worker/.dev.vars.example apps/worker/.dev.vars
Copy-Item .env.example .env.local
# Edit both copied files with local, non-production values.
# Set this to the same local URL used by .env.local.
$env:CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = 'postgresql://user:password@localhost:5432/deepsales'
pnpm db:migrate
pnpm dev
```

Open `http://127.0.0.1:8787/login`. The Worker reads local secrets from
`apps/worker/.dev.vars` and uses the Hyperdrive override above for PostgreSQL;
`DATABASE_URL` is used by the migration and test tooling, not by the Worker
request path.

## Checks

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm audit
pnpm build
```

Integration and E2E tests need a separate local test database. Its name must end
in `_test` or `_e2e`; the E2E runner resets the database before migrating it.
Do not run integration tests concurrently with E2E tests.

```powershell
Copy-Item .env.example .env.test
# Edit .env.test and use a database such as deepsales_test.
$env:APP_ENV = 'test'
pnpm db:migrate
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
```

If a development database, or an approved production maintenance window,
contains vectors from an older embedding model, apply the migration, then run
`scripts/reindex-knowledge.sql`. Do not run that script as an online
production migration; see [`docs/operations/DEPLOYMENT.md`](docs/operations/DEPLOYMENT.md).

## Deployment

See [`docs/operations/DEPLOYMENT.md`](docs/operations/DEPLOYMENT.md) for the complete provisioning and release
runbook. `pnpm run deploy` builds and deploys the Web assets and Worker; it does
not run database migrations. Production migrations must be run separately with
the direct database URL.

## License

This project is licensed under the MIT License. See [`LICENSE`](LICENSE).
