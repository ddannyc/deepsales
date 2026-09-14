# DeepSales

Lean V1 is a React SPA and Hono Cloudflare Worker backed by PostgreSQL. T03 adds
workspace-scoped Facebook OAuth, Page selection, encrypted Page tokens, and
connection health on top of the authenticated workspace shell.

## Local setup

```powershell
pnpm install --frozen-lockfile
Copy-Item apps/worker/.dev.vars.example apps/worker/.dev.vars
$env:DATABASE_URL = 'postgresql://user:password@localhost:5432/deepsales'
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
pnpm test:integration # requires DATABASE_URL; skips when absent
$env:E2E_DATABASE_URL = 'postgresql://user:password@localhost:5432/deepsales_e2e'
pnpm test:e2e          # resets/migrates the E2E database and owns the Worker lifecycle
```

`pnpm test:e2e` only needs `E2E_DATABASE_URL`; its database name must end in
`_e2e` or `-e2e`. The runner injects test-only Worker settings and never uses
the application `DATABASE_URL`.

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

Replace the placeholder Hyperdrive ID in `apps/worker/wrangler.jsonc`, set
`APP_URL`, `BETTER_AUTH_SECRET`, `META_APP_SECRET`, `META_VERIFY_TOKEN`,
`TOKEN_ENCRYPTION_KEY`, and `AI_API_KEY` with Wrangler. Set `AI_BASE_URL` to the
Alibaba Cloud International Model Studio region/workspace-compatible base URL, then keep the
Alibaba embedding and LLM variables from `wrangler.jsonc`:

```powershell
pnpm db:migrate
pnpm run deploy
```

Migrations always use the direct database URL and are never run by application deploys.
