import { defineConfig } from 'vitest/config'
import testDatabase from '../../database.test'

const databaseUrl = testDatabase.url

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      DATABASE_URL: databaseUrl,
      DATABASE_URL_UNPOOLED: databaseUrl,
    },
  },
})
