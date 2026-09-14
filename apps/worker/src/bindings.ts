export type Bindings = {
  APP_URL: string
  AUTH_RATE_LIMITER: RateLimit
  BETTER_AUTH_SECRET: string
  HYPERDRIVE: Hyperdrive
  WEBHOOKS_QUEUE?: Queue
  WORKSPACE_REALTIME?: DurableObjectNamespace
  META_APP_ID: string
  META_APP_SECRET: string
  META_VERIFY_TOKEN: string
  META_GRAPH_API_VERSION: string
  TOKEN_ENCRYPTION_KEY: string
}
