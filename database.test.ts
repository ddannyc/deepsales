import { assertTestDatabaseUrl, loadAppEnv } from './config/env'

const { databaseUrl: url } = loadAppEnv('test')
if (!url) throw new Error('Test DATABASE_URL is required.')
assertTestDatabaseUrl(url, { localOnly: true })

export default { url }
