import { execSync } from 'node:child_process'

process.env.APP_ENV = 'production'
execSync('pnpm db:migrate', { stdio: 'inherit' })
