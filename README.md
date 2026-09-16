# DeepSales

DeepSales is an early-stage shared inbox for Facebook conversations. It is a
React SPA and Hono Cloudflare Worker backed by PostgreSQL/pgvector, Cloudflare
Queues, Durable Objects, R2, and an Alibaba-compatible AI provider.

This repository is source code for self-hosted development. It is not a hosted
service and does not currently promise production readiness. Each deployment
needs its own Cloudflare, Neon/PostgreSQL, Meta, and AI-provider accounts.

## Repository layout

- `apps/web` — React frontend.
- `apps/worker` — Hono API, queues, webhooks, authentication, and realtime.
- `packages/db` — PostgreSQL schema, migrations, and domain operations.
- `e2e` — Playwright end-to-end tests.
- `scripts` — local setup and migration helpers.

`apps/worker/wrangler.jsonc` contains non-secret deployment identifiers and
configuration. Keep API keys, access tokens, database URLs, and auth/encryption
secrets in ignored environment files or Cloudflare Worker Secrets.

## Local setup

```powershell
pnpm install --frozen-lockfile
Copy-Item apps/worker/.dev.vars.example apps/worker/.dev.vars
Copy-Item .env.example .env.local
pnpm db:migrate
$env:CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = $env:DATABASE_URL
pnpm dev
```

Open `http://127.0.0.1:8787/login`. The Worker never reads `DATABASE_URL`; Wrangler's
local Hyperdrive override connects local development to PostgreSQL.

## Checks

```powershell
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
Copy-Item .env.example .env.test # edit DATABASE_URL to deepsales_test
$env:APP_ENV = 'test'
pnpm db:migrate
pnpm test:integration
pnpm test:e2e          # resets/migrates the test database and owns the Worker lifecycle
```

Use the same `DATABASE_URL` name in each environment file. Put the development
connection in ignored `.env.local`, and the test connection in ignored
`.env.test` (or the developer-specific `.env.test.local`). The shared loader selects the test file for Vitest, E2E, and
`APP_ENV=test pnpm db:migrate`.

Integration tests require a local test database. E2E resets the same test
database before migrating it, so do not run integration tests concurrently with
E2E. The database name must end in `_test` or `_e2e`.

If a development database, or an approved production maintenance window,
contains vectors from an older embedding model, apply the migration, then run
`psql $env:DATABASE_URL -f scripts/reindex-knowledge.sql`. It preserves inline
source text and R2 keys, removes all active chunks, resets processable documents
to `UPLOADED`, and lets the scheduled documents queue reindex them with Alibaba
embeddings. While metadata is unset, retrieval rejects queries, so old and new
vectors are never mixed. Do not run this SQL as an online production migration.

## Deploy

Create Hyperdrive with caching disabled because authentication, authorization, and
read-after-write flows require fresh reads:

```powershell
pnpm exec wrangler hyperdrive create deepsales --connection-string=$env:DATABASE_URL --caching-disabled
```

Replace the placeholder Hyperdrive ID and `APP_URL` in `apps/worker/wrangler.jsonc`, set
`BETTER_AUTH_SECRET`, `META_APP_SECRET`, `META_VERIFY_TOKEN`,
`TOKEN_ENCRYPTION_KEY`, and `AI_API_KEY` with Wrangler. Set `AI_BASE_URL` to the
Alibaba Cloud International Model Studio region/workspace-compatible base URL, then keep the
Alibaba embedding and LLM variables from `wrangler.jsonc`:

```powershell
$env:APP_ENV = 'production'
pnpm db:migrate
pnpm run deploy
```

`.env.local` is only for development. Put the production Neon URLs in ignored `.env.production.local`: use `DATABASE_URL` for the
pooled URL and `DATABASE_URL_UNPOOLED` for the direct migration URL. Run the production migration
separately before deployment with the direct URL.

For an online Neon migration, set `APP_ENV=production` and run `pnpm db:migrate`
(`$env:APP_ENV = 'production'; pnpm db:migrate` in PowerShell). For a test migration, use
`APP_ENV=test pnpm db:migrate` (`$env:APP_ENV = 'test'; pnpm db:migrate` in PowerShell).

## Contributing and security

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development and pull request
guidance. Report vulnerabilities privately according to [`SECURITY.md`](SECURITY.md).

## Before the first public push

- Confirm the MIT license copyright holder and third-party dependency licenses.
- Review `pnpm licenses list --prod` and retain any notices required by runtime
  dependencies.
- Enable branch protection with required CI and CodeQL checks.
- Enable Dependabot alerts, security updates, secret scanning, and private
  vulnerability reporting in GitHub.
- Review the complete Git history for credentials, customer data, deployment
  URLs, and personal author metadata.
- Run the checks in [`CONTRIBUTING.md`](CONTRIBUTING.md) and complete a real
  deployment smoke test with non-test accounts and data.

## License

This project is licensed under the MIT License. See [`LICENSE`](LICENSE).
