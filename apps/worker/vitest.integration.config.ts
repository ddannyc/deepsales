import { defineConfig } from 'vitest/config'
import testDatabase from '../../database.test'

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      DATABASE_URL: testDatabase.url,
      DATABASE_URL_UNPOOLED: testDatabase.url,
    },
  },
})
