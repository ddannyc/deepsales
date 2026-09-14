# DeepSales 部署步骤

本文档适用于当前 T08 版本：React SPA、Cloudflare Worker、Neon PostgreSQL、pgvector、Cloudflare Queues 和 Durable Object。应用部署不会自动执行数据库迁移。

## 执行分类

首次部署才需要执行：

- `pnpm install --frozen-lockfile`
- `wrangler login` / `wrangler whoami`
- 创建 Hyperdrive、三个 Queues，并把 Hyperdrive ID 写入 `wrangler.jsonc`
- 首次执行 `pnpm db:migrate`
- 首次 `pnpm run deploy`（创建 Worker）
- 配置 Worker Secrets
- 配置 Meta OAuth 回调、Webhook 和 Page 订阅

后续发布通常只需要：

```powershell
pnpm install --frozen-lockfile   # 依赖或 lockfile 变更时执行
pnpm typecheck
pnpm lint
pnpm test
pnpm db:migrate                  # 有新的 migration 时执行
pnpm run deploy
```

后续发布不需要重复创建 Hyperdrive、Queues、Durable Object，也不需要重复配置 Secrets 或 Meta 回调。只有更换数据库、Cloudflare 账号、Meta App 或密钥时，才重新执行对应的首次部署步骤。

## 前置条件

- Node.js、pnpm 已安装。
- 一个可用的 Neon PostgreSQL 数据库，以及生产环境直连 `DATABASE_URL`。
- Cloudflare 账号和 Wrangler 登录权限。
- Meta App、App Secret、Webhook Verify Token、OpenAI API key，以及可连接的 Facebook Page。

所有命令均在仓库根目录执行。

## 1. 安装依赖并登录 Cloudflare

```powershell
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler whoami
```

## 2. 创建或确认 Cloudflare 资源

设置数据库直连地址：

```powershell
$env:DATABASE_URL = 'postgresql://...'
```

创建 Hyperdrive，并关闭缓存：

```powershell
pnpm exec wrangler hyperdrive create deepsales --connection-string=$env:DATABASE_URL --caching-disabled
```

将返回的 Hyperdrive ID 写入 [apps/worker/wrangler.jsonc](apps/worker/wrangler.jsonc) 的 `hyperdrive[0].id`。如果配置中的 ID 已属于当前 Cloudflare 账号，可直接复用。

创建队列；已存在的队列跳过：

```powershell
pnpm exec wrangler queues create deepsales-webhooks
pnpm exec wrangler queues create deepsales-outbound
pnpm exec wrangler queues create deepsales-documents
pnpm exec wrangler queues create deepsales-dlq
pnpm exec wrangler r2 bucket create deepsales-objects
```

`WORKSPACE_REALTIME` Durable Object 和 `AUTH_RATE_LIMITER` 会由 Wrangler 配置管理。T07 使用 `deepsales-objects` 保存私有附件。

## 3. 执行数据库迁移

迁移必须使用直连数据库 URL：

```powershell
pnpm db:migrate
```

不要把 `DATABASE_URL` 配置为 Worker Secret；Worker 只通过 `HYPERDRIVE` 访问数据库。

## 4. 首次部署 Worker

部署会同时构建 Web 静态资源和 Worker：

```powershell
pnpm run deploy
```

记录 Wrangler 输出的 Worker URL，例如：

```text
https://deepsales.<account>.workers.dev
```

## 5. 配置 Worker Secrets

逐项执行，命令会提示输入值：

```powershell
pnpm --filter @deepsales/worker exec wrangler secret put APP_URL
pnpm --filter @deepsales/worker exec wrangler secret put BETTER_AUTH_SECRET
pnpm --filter @deepsales/worker exec wrangler secret put META_APP_SECRET
pnpm --filter @deepsales/worker exec wrangler secret put META_VERIFY_TOKEN
pnpm --filter @deepsales/worker exec wrangler secret put TOKEN_ENCRYPTION_KEY
pnpm --filter @deepsales/worker exec wrangler secret put OPENAI_API_KEY
```

要求：

- `APP_URL` 填最终 HTTPS 地址，不要带结尾 `/`。
- `BETTER_AUTH_SECRET` 使用至少 32 个字符的随机值。
- `META_VERIFY_TOKEN` 使用随机值，并在 Meta 配置中使用同一个值。
- `TOKEN_ENCRYPTION_KEY` 必须是 Base64 编码的 32 字节随机密钥。
- `OPENAI_API_KEY` 用于生成知识库 embeddings；不要写入 `wrangler.jsonc`。
- `META_APP_ID` 和 `META_GRAPH_API_VERSION` 已在 `wrangler.jsonc` 的 `vars` 中配置；如使用其他 Meta App，请先修改它们。
- 生产环境不要配置测试用的 `FACEBOOK_GRAPH_BASE_URL`。

设置完 Secret 后重新部署：

```powershell
pnpm run deploy
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
