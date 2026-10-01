import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('runs the entire recovery handler every 30 minutes in both deployment configs', () => {
  for (const file of ['wrangler.jsonc', 'wrangler.jsonc.example']) {
    const path = new URL(`../${file}`, import.meta.url)
    if (file === 'wrangler.jsonc' && !existsSync(path)) continue
    const config = JSON.parse(readFileSync(path, 'utf8'))
    expect(config.triggers.crons).toEqual(['*/30 * * * *'])
  }
})
