# Hono / Cloudflare Workers 测试研究

研究日期：2026-09-15

## 结论

本仓库适合采用两条测试路径：

1. 普通 Node.js Vitest：测试 Hono 路由、请求/响应和业务逻辑。
2. 独立的数据库集成测试：由 Vitest 配置加载本地测试数据库，不依赖命令行是否预先设置 `DATABASE_URL`。

只有在需要验证 `workerd`、Cloudflare bindings、Queues、R2、Durable Objects 或 Hyperdrive 行为时，才引入 Cloudflare Workers Vitest 集成。它不能替代 Postgres 测试数据库配置。

## 官方资料结论

### Hono `app.request()`

Hono 官方测试指南建议直接调用 `app.request()`，取得 `Response` 后断言状态码、响应体和 headers。测试请求可以传入 pathname、`Request` 或完整的 `RequestInit`。

Hono 还支持把测试用的 `c.env` 作为 `app.request()` 第三个参数传入，因此可以直接注入 mock binding，例如 `DB`、密钥或其他 Worker 环境对象。当前仓库的 [`apps/worker/src/index.test.ts`](apps/worker/src/index.test.ts) 已采用这个方式。

Hono 的官方文档只定义请求和 `env` 注入方式，并明确指出测试环境取决于运行时；没有定义 Rails 风格的数据库环境、`DATABASE_URL` 命名、migration 生命周期或清理约定。数据库测试配置应由 Vitest、数据库驱动和项目自己的测试 harness 负责。

### Vitest 配置与测试环境

- Vitest 默认 mode 是 `test`，可用 `--mode` 覆盖；不同 mode 可由 `loadEnv(mode, ...)` 选择对应的 `.env.<mode>` 文件。
- Vitest 不会自动把 `.env` 中所有变量注入测试；官方建议使用 `loadEnv(mode, process.cwd(), '')`，再设置 `test.env`，这样未加 `VITE_` 前缀的 `DATABASE_URL` 也能在测试中的 `process.env` 使用。
- `setupFiles` 在每个测试文件前运行；`globalSetup` 在 Node.js 主进程中运行。需要启动本地数据库或 TCP 服务时，后者更合适。
- Vitest 的 `projects` 可以把 unit、database integration 和其他运行时测试拆成不同项目，分别使用自己的 include、setup 和 pool。

对本仓库而言，`packages/db/vitest.integration.config.ts` 已是合适的数据库测试配置入口；集成测试直接读取 `process.env.DATABASE_URL`，由配置的 `test.env` 注入。仓库提交 `database.test.ts` 作为配置加载器，连接串放在被忽略的 `.env.test.local`（变量名为 `DATABASE_URL`），没有该变量时使用本地默认地址；它会拒绝远程测试主机。

### Cloudflare `@cloudflare/vitest-pool-workers`

Cloudflare 当前文档已将 `@cloudflare/vitest-pool-workers` 标记为旧名称，并说明由 `@cloudflare/vitest-plugin` 替代；API 和 Vitest 配置保持不变。新代码应使用新包名，不应为了数据库环境配置而引入旧包。

Workers Vitest 集成会在本地 `workerd`/Miniflare 中运行测试，提供真实的 Workers runtime API 和 bindings，并按测试文件隔离存储。测试配置可以读取 `wrangler.jsonc`，测试中可使用 `cloudflare:workers` 和 `cloudflare:test`。当前官方插件要求 Vitest 4.1+；本仓库目前使用 Vitest 3.2.4，因此升级应作为单独的兼容性变更处理。

Cloudflare 官方配置还支持通过 `globalSetup` 启动本地 TCP 服务，再用 `provide()` / `inject()` 把端口注入 Hyperdrive 配置；官方示例包含 Postgres/Hyperdrive 场景。这适合验证 Worker 内部的 Hyperdrive binding 和 `workerd` 行为，但仍然需要项目自己负责数据库 schema、fixture、隔离和清理。

## 对本仓库的建议

1. 保持 [`apps/worker/src/index.test.ts`](apps/worker/src/index.test.ts) 这类测试使用普通 Vitest + `app.request(path, init, bindings)`。它们不需要真实数据库，也不需要 Cloudflare test pool。
2. 为数据库集成测试配置固定的 [`database.test.ts`](database.test.ts)，从被忽略的 `.env.test.local` 读取个人 `DATABASE_URL`，再在各自的 Vitest 配置中用 `test.env` 注入。测试命令即可直接运行，不再依赖开发者当前 shell 的 `DATABASE_URL`。
3. 继续要求测试 URL 指向本地 Postgres，并最好使用明确的测试数据库名，例如 `deepsales_test`；环境文件是默认值，不能取消本地 URL 守卫。
4. 将 unit 与 `*.integration.test.ts` 分成不同 Vitest include/project。当前仓库已让 Worker 的 `test:unit` 排除集成测试，并提供独立的 `test:integration` 配置。
5. 只有需要验证 Cloudflare runtime/binding 时，才新增独立的 Cloudflare Vitest 配置；届时使用 `@cloudflare/vitest-plugin`、`wrangler.jsonc` 和官方 Hyperdrive `provide`/`inject` 模式。不要把它当作 Rails 式数据库环境管理器。

## 官方一手来源

- [Hono Testing](https://hono.dev/docs/guides/testing) — `app.request()`、请求断言和第三个参数注入 `c.env`。
- [Hono App API](https://hono.dev/docs/api/hono#request) — `app.request()` 的 API 定义。
- [Cloudflare Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/) — Workers runtime 测试能力和当前推荐方案。
- [Cloudflare: Migrate to Vitest plugin](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/) — `@cloudflare/vitest-pool-workers` → `@cloudflare/vitest-plugin`，配置/API 不变。
- [Cloudflare: Write your first test](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/) — `cloudflareTest()`、Wrangler 配置、`cloudflare:workers` 和 `cloudflare:test`。
- [Cloudflare: Vitest configuration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/) — bindings、`setupFiles`、动态 `provide`/`inject` 和 Hyperdrive 配置。
- [Cloudflare Workers SDK Hyperdrive test example](https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/hyperdrive) — 官方 GitHub 的 Hyperdrive + Vitest 示例。
- [Vitest environment variables](https://vitest.dev/guide/features#environment-variables) — `loadEnv()` 和 `test.env` 加载非 `VITE_` 变量。
- [Vitest configuration](https://vitest.dev/config/) — 默认 `test` mode 和 Vitest 配置文件规则。
- [Vitest setup and teardown](https://vitest.dev/guide/learn/setup-teardown) — `setupFiles`、`globalSetup`、fixtures 和数据库清理场景。
- [Vitest projects](https://vitest.dev/guide/projects) — 在 monorepo 中拆分不同测试项目。
