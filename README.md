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
$env:E2E_BASE_URL = 'http://127.0.0.1:8787'
pnpm test:e2e          # requires a migrated running app; skips when E2E_BASE_URL is absent
```

## Deploy

Create Hyperdrive with caching disabled because authentication, authorization, and
read-after-write flows require fresh reads:

```powershell
pnpm exec wrangler hyperdrive create deepsales --connection-string=$env:DATABASE_URL --caching-disabled
```

Replace the placeholder Hyperdrive ID in `apps/worker/wrangler.jsonc`, set
`APP_URL`, `BETTER_AUTH_SECRET`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, and
`TOKEN_ENCRYPTION_KEY` with Wrangler. Set `META_APP_ID` and `META_GRAPH_API_VERSION`
as Worker variables, then:

```powershell
pnpm db:migrate
pnpm deploy
```

Migrations always use the direct database URL and are never run by application deploys.
