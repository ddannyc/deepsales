export type Bindings = {
  APP_URL: string
  AUTH_RATE_LIMITER: RateLimit
  BETTER_AUTH_SECRET: string
  HYPERDRIVE: Hyperdrive
  WEBHOOKS_QUEUE?: Queue
  OUTBOUND_QUEUE?: Queue
  AI_QUEUE?: Queue
  DOCUMENTS_QUEUE?: Queue
  MAINTENANCE_QUEUE?: Queue
  OBJECTS?: R2Bucket
  WORKSPACE_REALTIME?: DurableObjectNamespace
  META_APP_ID: string
  META_APP_SECRET: string
  META_VERIFY_TOKEN: string
  META_GRAPH_API_VERSION: string
  AI_BASE_URL?: string
  AI_API_KEY?: string
  EMBEDDING_PROVIDER?: string
  EMBEDDING_MODEL?: string
  EMBEDDING_DIMENSIONS?: string
  LLM_PROVIDER?: string
  LLM_MODEL?: string
  AI_RETRIEVAL_MAX_DISTANCE?: string
  FACEBOOK_GRAPH_BASE_URL?: string
  TOKEN_ENCRYPTION_KEY: string
}
