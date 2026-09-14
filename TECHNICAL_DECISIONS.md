# Technical Decisions — Lean V1

## 1. Primary Stack

### Repository
TypeScript monorepo.

### Frontend
- React 19
- Vite
- TypeScript

### Backend
- Hono
- TypeScript

### Database
- PostgreSQL
- pgvector

### Data Access
- Drizzle ORM / Drizzle SQL tooling

### Primary Runtime
- Cloudflare Workers

### Background Jobs
- Cloudflare Queues

### Realtime
- Cloudflare Durable Objects + WebSocket hibernation where needed

### Object Storage
- Cloudflare R2

### PostgreSQL Connectivity
- Hyperdrive to external PostgreSQL
- preferred providers: Neon or Supabase PostgreSQL

### AI
Alibaba Cloud International Model Studio.

- LLM: `qwen3.8-flash` when T11 is implemented.
- Embedding: `qwen3.7-text-embedding`, 1,536 dimensions for T08.
- Vector store: PostgreSQL + pgvector.
- T08 uses native `fetch`; the provider boundary remains provider-neutral.

### Testing
- TypeScript compiler
- Vitest
- Playwright
- integration tests against PostgreSQL

## 2. Deployment Goal

Lean V1 should run with very low idle resource cost.

Preferred production shape:

Cloudflare Worker  
+ Queues  
+ Durable Objects  
+ R2  
+ external serverless PostgreSQL

Railway/Node is the fallback runtime if a Worker limitation blocks implementation.

Do not build a dual-runtime implementation in advance.

## 3. Why PostgreSQL, Not D1

PostgreSQL is intentionally retained because Lean V1 depends on:

- transactions
- row locking
- partial/conditional uniqueness
- deterministic concurrency handling
- pgvector

D1 may be useful for other products, but it is not the Lean V1 source of truth.

## 4. Why Hono

Hono is a small TypeScript web framework with strong Cloudflare compatibility and a clean Node fallback.

Use Hono for:

- webhook routes
- authenticated API routes
- channel adapter endpoints
- health endpoints

Do not turn Hono route handlers into domain logic containers.

## 5. Why React + Vite

This is an authenticated SaaS application, not an SEO-first content site.

Vite + React keeps the client model simple and gives AI coding agents strong TypeScript/compiler/browser feedback.

Do not introduce Next.js unless a specific requirement proves necessary.

## 6. Modular Monolith

Logical modules:

- `identity`
- `members`
- `channels`
  - `facebook`
- `customers`
- `conversations`
- `assignments`
- `ai`
- `knowledge`
- `infrastructure`

Avoid microservices.

A reasonable monorepo shape is:

```text
apps/
  web/
  worker/

packages/
  domain/
  db/
  shared/
  ui/
```

Exact folders may be refined by `/to-spec`, but module boundaries must follow the domain.

## 7. Cloudflare Isolation

Create thin interfaces such as:

```ts
interface JobQueue {
  enqueue<T>(topic: string, payload: T): Promise<void>;
}

interface RealtimePublisher {
  publish(topic: string, event: unknown): Promise<void>;
}

interface ObjectStorage {
  put(...): Promise<...>;
}
```

V1 implements only the Cloudflare-backed versions.

Do not create Railway/Node fallback adapters until migration is actually required.

## 8. Critical Database Responsibilities

Use PostgreSQL for:

- one OPEN conversation per channel identity
- assignment ownership transitions
- assignment capacity re-checks
- takeover race resolution
- AI response commit authorization
- message idempotency
- delivery status
- durable AIResponseRun state

For critical paths, prefer explicit transactions and locking over implicit ORM behavior.

## 9. Queue Topics

Suggested logical queues:

- `webhooks`
- `outbound`
- `ai`
- `documents`
- `maintenance`

Do not run long LLM/document work in webhook request handlers.

## 10. Realtime

Realtime is a UI delivery mechanism, not a consistency mechanism.

Use realtime for:

- new message notification
- conversation list refresh
- assignment changes
- AI generating indicator
- message delivery-status changes

If a realtime event is lost, the UI must still be able to recover canonical state from normal API/database reads.

## 11. Knowledge / RAG

Use PostgreSQL + pgvector.

Lean V1 does not need:

- Qdrant
- Pinecone
- Milvus
- Elasticsearch
- a Python RAG service
- LangChain server

Flow:

document  
-> extraction  
-> chunks  
-> embeddings  
-> pgvector search  
-> AI response

Complex OCR/layout parsing is deferred unless real documents prove it necessary.

## 12. AI Provider Boundary

Domain code must not call a provider SDK directly.

T08 uses this provider-neutral application seam:

```ts
interface EmbeddingProvider {
  embed(input: string[]): Promise<number[][]>;
}
```

The production T08 adapter is `AlibabaEmbeddingProvider`, implemented with native
`fetch` against the configured Alibaba Cloud International Model Studio
compatible embeddings endpoint. T11 will add an `LlmProvider` for
`qwen3.8-flash`; it is not implemented in T08.

Every KnowledgeBase records the provider, model, and dimensions of its active
vectors. Ingestion and retrieval reject a mismatch, so different vector spaces
cannot be mixed in one active KnowledgeBase. Switching models requires clearing
the active chunks and reindexing the retained source documents.

## 13. Authentication

Use a mature TypeScript-compatible authentication approach that works cleanly on Cloudflare and PostgreSQL.

`/to-spec` should select the concrete library after checking current runtime compatibility.

Do not build a custom password/security framework from scratch.

Regardless of library:

- User remains separate from Member
- workspace role lives in WorkspaceUserAccess
- AI members do not authenticate

## 14. Testing Gates

Every implementation ticket should finish with:

```text
typecheck
lint
unit tests
integration tests
relevant Playwright E2E
```

Critical concurrency paths must have integration tests against PostgreSQL.

Mock-only tests are insufficient for:

- uniqueness
- transaction locking
- assignment races
- AI commit races

## 15. AI Coding Rules

AI agents must:

- read the authoritative docs before major implementation work
- follow vertical-slice tickets
- add tests with each ticket
- avoid introducing packages without necessity
- prefer framework/runtime-native capabilities
- preserve architecture invariants
- run validation commands before completion

AI agents must not:

- silently redesign domain entities
- substitute D1 for PostgreSQL
- add Redis
- split the monolith
- move correctness into Durable Objects
- invent V1.1 functionality
