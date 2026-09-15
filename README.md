# DeepSales

Lean V1 is a React SPA and Hono Cloudflare Worker backed by PostgreSQL. T03 adds
workspace-scoped Facebook OAuth, Page selection, encrypted Page tokens, and
connection health on top of the authenticated workspace shell.

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
pnpm test:integration # uses the local deepsales_test database by default
Copy-Item .env.example .env.test # edit DATABASE_URL to deepsales_test
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
