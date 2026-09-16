# Contributing

DeepSales is a TypeScript monorepo containing a React web app, a Cloudflare
Worker, and a PostgreSQL package. Contributions should keep workspace and
tenant data isolated and should not add provider credentials to the repository.

## Development setup

Use the Node.js version in [`.node-version`](.node-version) and the pnpm version
declared in [`package.json`](package.json). Follow the local setup instructions
in [`README.md`](README.md).

## Checks before a pull request

Run:

```powershell
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm audit
pnpm build
```

For changes that touch the database, Worker routes, queues, or browser flows,
also run these commands separately:

```powershell
$env:APP_ENV = 'test'
pnpm db:migrate
pnpm test:integration
pnpm test:e2e
```

Integration tests require a PostgreSQL database whose name ends in `_test` or
`_e2e`. The E2E runner resets that database before migrating it; do not run
integration tests and E2E tests concurrently.

## Pull requests

- Explain the user-visible or operational reason for the change.
- Add or update tests for security-sensitive and data-handling behavior.
- Keep migrations forward-only and document operational steps.
- Do not commit `.env*`, `.dev.vars`, tokens, customer data, or production logs.
- Report security issues privately as described in [`SECURITY.md`](SECURITY.md).
