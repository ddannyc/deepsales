# 当前技术栈最佳实践调研结论

调研范围：Hono、Cloudflare Workers/Hyperdrive、Neon、Drizzle、Vitest。只采用官方文档或官方仓库示例，结论针对“HTTP/Worker 测试”和“PostgreSQL/迁移测试”分层使用的方案。

## 总结

当前方向是合理的，但不存在一套测试配置能同时覆盖所有边界。推荐保留两层：

1. **Hono `app.request()`**：测试路由、请求/响应和注入的 `c.env`。
2. **Workers Vitest plugin**：少量测试真实 Worker runtime、Cloudflare bindings 和 Hyperdrive 接入。
3. **Node/Vitest + PostgreSQL**：测试 Drizzle、SQL、事务和领域数据行为。

因此，当前方案可评为“接近最佳实践”；主要缺口不是框架选择，而是数据库测试隔离和线上迁移目标保护。

## 分项结论

| 主题 | 官方推荐 | 评估与建议 |
| --- | --- | --- |
| Hono `app.request()` | Hono 官方直接推荐用 `app.request()` 创建请求并断言 `Response`；第三个参数可注入 `c.env`。 | 适合快速、确定性的路由测试，应继续使用。它不能替代真实 Worker runtime 测试。 |
| Workers Vitest plugin | Cloudflare 对 Workers/Pages 项目推荐 `@cloudflare/vitest-plugin`；它在 Workers runtime 中运行测试，并提供 bindings、Miniflare 和按测试文件隔离的存储。 | 对涉及 `env`、Queues、R2、`workerd` 行为的测试应补充使用；不必把所有纯 Hono/数据库测试迁移过去。 |
| Hyperdrive 本地开发 | `wrangler dev` 可通过 `localConnectionString` 或 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` 直连数据库，但此时不模拟 Hyperdrive 的连接池和查询缓存；`wrangler dev --remote` 才使用已部署的 Hyperdrive。 | 本地开发用本地/专用数据库直连是正确的；需要验证 Hyperdrive 特性时增加显式 remote smoke test，并把它视为会影响远程数据的测试。官方还提供了用 Vitest 管理 TCP server 的 Hyperdrive 测试示例。 |
| Neon 分支与迁移 | Neon 分支彼此隔离且有独立连接串；官方建议按开发者、PR 或测试运行创建分支。Neon 同时建议 ORM/迁移工具使用 direct（非 `-pooler`）连接。 | 分支优先、迁移使用 direct URL 是正确方向。不要让“当前分支”无提示地成为生产迁移目标；推荐 preview/test branch 验证后，再由受保护的发布流程迁移 production。 |
| Drizzle Kit 迁移连接 | `drizzle-kit migrate` 应读取迁移文件、查询迁移记录并只执行未应用迁移；连接信息可放在 `drizzle.config.ts`，也支持按环境使用多份 config。 | 使用版本控制中的 SQL migration + `drizzle-kit migrate` 是团队协作的稳妥做法。Neon 上迁移配置应优先 direct/unpooled URL；不要把连接串硬编码进仓库。 |
| Vitest 环境变量 | `test.env` 会把变量注入测试中的 `process.env` 和 `import.meta.env`，但不会注入 `globalSetup` 所在的主进程。 | 测试专用数据库 URL 用测试 config 注入是合适的；不要依赖开发/生产进程环境“碰巧”提供测试变量。 |
| Vitest global setup | `globalSetup` 在测试 worker 创建前运行一次；需要向测试传值时使用 `provide`/`inject`。 | 迁移一次、启动测试服务器、创建临时数据库等全局资源适合放这里；每个文件或每个测试的数据清理不应只靠 `globalSetup`。 |
| Vitest 测试隔离 | Vitest 默认开启测试文件隔离，但这主要是运行时/module scope 隔离，不会自动回滚或清空外部 PostgreSQL。默认文件并行也不等于数据库隔离。 | 数据库集成测试必须使用独立数据库/branch/schema，或在明确的 setup/teardown 中清理数据。关闭文件并行只能降低竞争，不能代替数据隔离。 |

## 推荐落地顺序

1. **保持测试分层**：`app.request()` 测 HTTP；Workers plugin 测 Cloudflare runtime/bindings；Node/Vitest 测真实 PostgreSQL 行为。
2. **先解决数据库隔离**：本地可使用每次运行的临时数据库或 schema；CI/预览环境优先使用每个测试运行独立的 Neon branch，避免共享测试库残留数据和并行互相污染。
3. **保护迁移目标**：迁移命令明确指定 branch；先在 preview/development branch 执行，再在受保护的 production 发布步骤执行。production 不应只是本地配置文件里的默认隐式目标。
4. **减少重复初始化**：把一次性的迁移或测试服务器启动放入 `globalSetup`；把 per-file/per-test 清理留在测试 setup/teardown。
5. **按需补 Workers plugin**：只有测试需要 Cloudflare 运行时或 binding 真实语义时再增加 plugin suite，不为纯业务单元测试引入额外复杂度。

## 官方来源

- [Hono Testing](https://hono.dev/docs/guides/testing)
- [Cloudflare Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Cloudflare Workers Vitest recipes（含 Hyperdrive）](https://developers.cloudflare.com/workers/testing/vitest-integration/recipes/)
- [Cloudflare Hyperdrive local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/)
- [Neon database branching workflow](https://neon.com/docs/get-started-with-neon/workflow-primer)
- [Neon connection pooling and migrations](https://neon.com/docs/connect/connection-pooling)
- [Drizzle Kit `migrate`](https://orm.drizzle.team/docs/drizzle-kit-migrate)
- [Drizzle migration fundamentals](https://orm.drizzle.team/docs/migrations)
- [Vitest `env`](https://vitest.dev/config/env)
- [Vitest `globalSetup`](https://vitest.dev/config/globalsetup.html)
- [Vitest `setupFiles`](https://vitest.dev/config/setupfiles)
- [Vitest projects](https://vitest.dev/guide/projects)
- [Vitest configuration and isolation](https://vitest.dev/config/)
