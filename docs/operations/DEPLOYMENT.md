# DeepSales 部署步骤

本文档适用于当前 Lean V1 实现：React SPA、Cloudflare Worker、Neon PostgreSQL、pgvector、Cloudflare Queues、Durable Object 和 R2。`pnpm run deploy` 只部署应用；数据库迁移单独执行。

## 执行分类

首次部署才需要执行：

- `pnpm install --frozen-lockfile`
- `wrangler login` / `wrangler whoami`
- 创建 Hyperdrive、五个工作 Queues 和共享 DLQ，并把 Hyperdrive ID 写入本地未跟踪的 `apps/worker/wrangler.jsonc`
- 配置 Worker Secrets
- 首次单独执行生产数据库迁移，然后 `pnpm run deploy`
- 配置 Meta OAuth 回调、Webhook 和 Page 订阅

后续发布通常只需要：

```powershell
pnpm install --frozen-lockfile   # 依赖或 lockfile 变更时执行
pnpm typecheck
pnpm lint
pnpm test
$env:APP_ENV = 'production'
pnpm db:migrate
pnpm run deploy
```

后续发布不需要重复创建 Hyperdrive、Queues、Durable Object，也不需要重复配置 Secrets 或 Meta 回调。只有更换数据库、Cloudflare 账号、Meta App 或密钥时，才重新执行对应的首次部署步骤。

## 前置条件

- Node.js、pnpm 已安装。
- 一个启用 `vector` 扩展的 Neon PostgreSQL 数据库；迁移使用直连 URL，应用查询使用 pooled URL。
- Cloudflare 账号和 Wrangler 登录权限。
- Meta App、App Secret、Webhook Verify Token、Alibaba Cloud International Model Studio API key，以及可连接的 Facebook Page。

所有命令均在仓库根目录执行。

首次部署前，如果本地配置文件还不存在，从示例复制一份。真实配置文件已被 Git 忽略，不要提交：

```powershell
if (-not (Test-Path apps/worker/wrangler.jsonc)) {
  Copy-Item apps/worker/wrangler.jsonc.example apps/worker/wrangler.jsonc
}
```

## 1. 安装依赖并登录 Cloudflare

```powershell
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler whoami
```

## 2. 创建或确认 Cloudflare 资源

临时设置用于创建 Hyperdrive 的直连地址。不要把真实连接串写入仓库：

```powershell
$env:DEEPSALES_HYPERDRIVE_DATABASE_URL = 'postgresql://...'
```

创建 Hyperdrive，并关闭缓存：

```powershell
pnpm exec wrangler hyperdrive create deepsales --connection-string=$env:DEEPSALES_HYPERDRIVE_DATABASE_URL --caching-disabled
```

将返回的 Hyperdrive ID 写入本地 `apps/worker/wrangler.jsonc` 的 `hyperdrive[0].id`，替换其中的占位值。仓库提交的是 [apps/worker/wrangler.jsonc.example](../../apps/worker/wrangler.jsonc.example)。

创建队列；已存在的队列跳过：

```powershell
pnpm exec wrangler queues create deepsales-webhooks
pnpm exec wrangler queues create deepsales-outbound
pnpm exec wrangler queues create deepsales-ai
pnpm exec wrangler queues create deepsales-documents
pnpm exec wrangler queues create deepsales-maintenance
pnpm exec wrangler queues create deepsales-dlq
pnpm exec wrangler r2 bucket create deepsales-objects
```

`WORKSPACE_REALTIME` Durable Object 和 `AUTH_RATE_LIMITER` 会由 Wrangler 配置管理。`deepsales-objects` 用于保存私有附件。

## 3. 执行数据库迁移

迁移必须使用直连数据库 URL。`.env.local` 仅用于开发；将生产 Neon 连接信息放在被忽略的
`.env.production.local`：`DATABASE_URL` 填 pooled URL，`DATABASE_URL_UNPOOLED` 填直连 URL。
然后显式选择生产环境：

```powershell
$env:APP_ENV = 'production'
pnpm db:migrate
```

`DATABASE_URL` 和 `DATABASE_URL_UNPOOLED` 只供迁移工具使用，不要配置为 Worker Secret；Worker 只通过 `HYPERDRIVE` 访问数据库。

## 4. 配置 Worker Secrets

先在本地未跟踪的 `apps/worker/wrangler.jsonc` 中替换 `APP_URL`、`META_APP_ID` 和其他目标环境占位配置。
`AI_BASE_URL` 应使用目标 Alibaba Cloud International Model Studio 区域和 workspace 的兼容地址。

逐项执行，命令会提示输入值：

```powershell
pnpm --filter @deepsales/worker exec wrangler secret put BETTER_AUTH_SECRET
pnpm --filter @deepsales/worker exec wrangler secret put META_APP_SECRET
pnpm --filter @deepsales/worker exec wrangler secret put META_VERIFY_TOKEN
pnpm --filter @deepsales/worker exec wrangler secret put TOKEN_ENCRYPTION_KEY
pnpm --filter @deepsales/worker exec wrangler secret put AI_API_KEY
```

`APP_URL` 在本地 `apps/worker/wrangler.jsonc` 中配置，必须是最终 HTTPS 地址且不带结尾 `/`。

要求：

- `APP_URL` 填最终 HTTPS 地址，不要带结尾 `/`。
- `BETTER_AUTH_SECRET` 使用至少 32 个字符的随机值。
- `META_VERIFY_TOKEN` 使用随机值，并在 Meta 配置中使用同一个值。
- `TOKEN_ENCRYPTION_KEY` 必须是 Base64 编码的 32 字节随机密钥。
- `AI_API_KEY` 用于 embeddings 和 LLM 请求；不要写入 `wrangler.jsonc`。
- `AI_BASE_URL` 使用 Alibaba Cloud International Model Studio 对应区域和 workspace 的兼容 API base URL；不要在代码中硬编码 endpoint。
- `EMBEDDING_PROVIDER=alibaba`、`EMBEDDING_MODEL=qwen3.7-text-embedding`、`EMBEDDING_DIMENSIONS=1536`、`LLM_PROVIDER=alibaba`、`LLM_MODEL=qwen3.8-flash` 保持为 Worker variables。
- `META_APP_ID` 和 `META_GRAPH_API_VERSION` 已在 `wrangler.jsonc.example` 的 `vars` 中提供占位配置；部署前必须在本地 `wrangler.jsonc` 中替换为目标 Meta App 的值。
- 生产环境不要配置测试用的 `FACEBOOK_GRAPH_BASE_URL`。

## 5. 首次部署 Worker

确认数据库迁移和 Worker Secrets 配置完成后，构建并部署 Web 静态资源和 Worker：

```powershell
pnpm run deploy
```

记录并确认 Wrangler 输出的 Worker URL 与 `wrangler.jsonc` 中的 `APP_URL` 一致，例如：

```text
https://deepsales.<account>.workers.dev
```

## 6. 配置 Meta App

在 Meta App 的 OAuth 设置中加入：

```text
https://你的域名/api/facebook/oauth/callback
```

在 Meta App 的 Webhooks 设置中配置：

```text
Callback URL: https://你的域名/webhooks/facebook
Verify Token: 与 META_VERIFY_TOKEN 相同
```

订阅 Page 的 `messages` 事件，并确保测试账号具有 App/Page 访问权限。

## 7. 上线验证

```powershell
$APP_URL = 'https://你的域名'
Invoke-RestMethod "$APP_URL/health"
Invoke-RestMethod "$APP_URL/ready"
```

两个接口都应返回：

```json
{ "ok": true }
```

随后登录 `$APP_URL/settings/facebook`，连接 Facebook Page，发送 Messenger 测试消息，接管对话并验证回复状态从 `PENDING` 变为 `SENT`。也应验证 Meta 拒绝时消息显示为 `FAILED`。

首次连接 Page 的成员会自动获得该 Page 的频道权限。若 Page 是本修复前已经连接的，首次接管提示频道权限时，进入“团队”，在对应人工成员的“渠道权限”中勾选该 Page 并保存；后续部署不需要重复设置。

查看线上日志：

```powershell
pnpm --filter @deepsales/worker exec wrangler tail
```

## 迁移与回滚

上线前先备份生产数据库。数据库迁移采用 forward-fix 策略，不执行自动回滚；破坏性迁移必须经过单独的运维确认。发布失败时先保留当前部署和日志，再修复代码或迁移后重新部署。

若数据库已有旧 embedding，需在批准的维护窗口设置直连 URL 后执行：

```powershell
$env:DEEPSALES_MIGRATION_DATABASE_URL = 'postgresql://...'
psql $env:DEEPSALES_MIGRATION_DATABASE_URL -f scripts/reindex-knowledge.sql
Remove-Item Env:DEEPSALES_MIGRATION_DATABASE_URL
```

该脚本保留 inline source/R2 key，清除旧 active chunks，将可处理文档重置为
`UPLOADED`，再由 documents queue 使用 Alibaba embedding 重建。metadata 为空期间
retrieval 会拒绝查询，避免混用旧 vector space；不要在线并行执行该脚本。
