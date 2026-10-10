# 会话阅读与回执

对应 #18。范围为 Messenger 的完整历史、人工成员阅读确认、未回复查询与真实回执。

## 历史与查询

保留五个 OPEN 视图，增加独立 `view=closed` 历史入口。历史仅供阅读；关闭后再次入站
沿用既有生命周期创建新的 OPEN 会话，不直接重开 CLOSED 行。

列表使用 `cursor`，消息初次使用 `history=latest`，通过 `before` / `olderCursor` 向前加载。
原有消息 `cursor` / `nextCursor` 增量接口继续有效。游标保留 PostgreSQL 微秒精度，
同一时间的 UUID 为稳定次序。互斥方向不能同时请求。

浏览器刷新重新读取已加载的列表页和消息范围，合并时按消息 ID 去重，并保留选中会话。
视图、标签、消息筛选和会话切换有请求代次保护。更早消息加载保留滚动锚点。
`attention=unread|unanswered` 可与既有视图、标签组合，权限仍由工作区和频道决定。

## 人工成员已读与未回复

`POST conversations/:id/read` 接受最多 100 个客户消息 ID。它只确认调用成员实际提供的
输入，拒绝其他会话、成员出站和不存在的消息。客户端仅在前台用可见性观察器提交
已加载且进入视口的客户输入；失败提供重试。

`message_member_read` 保存精确已读覆盖，`conversation_member_read` 保存单调递进的
最新阅读水位。没有浏览的旧页仍未读，旧窗口/重复确认不能清除新入站或回退水位。
AI 出站不会替人工成员确认阅读。不同 HUMAN 成员互不影响。

未回复只在当前最后客户输入之后存在非空 MEMBER 出站且状态为 SENT 时清除。
PENDING、FAILED 和非消息状态不会清除。业务提交路径在会话锁内记录消息创建时刻，
避免事务开始时间与实际插入次序相反。SENT 仍仅表示发送 API 接受。

## Messenger 回执

新连接/重新连接 Page 订阅 `messages,message_deliveries,message_reads,message_echoes`。
回执沿用原始请求 HMAC 验证，再进入经过 Zod 验证的 `facebook.receipt` 队列任务。
解析器只保留身份、MID 和时间，不保存 echo 的文字或附件内容。

Facebook 边界按 Page + 外部身份解析唯一 ChannelIdentity，数据库保存 delivery/read
的最大水位，以及精确 MID 送达和 echo 提供的发送时间。重复、乱序和并发更新均单调。
未知身份不会创建客户或会话。客户关联/解绑不会改变回执归属；回执跨该身份的关闭历史有效。

精确 delivery MID 可独立确认送达；watermark 只有在同一身份/MID 的 echo 提供可靠
provider 时间时才能映射。Graph Send API 本地完成时间不再充当 provider 时间。
旧数据中的本地时间也不会用于回执推断。缺少 echo 或回执时显示“送达状态未知”，
SENT、送达、客户已读保持独立。外部 Page 人工发送的未知 echo 不创建消息。

协议依据为 [Meta 官方示例的 delivery/read 实现](https://github.com/fbsamples/messenger-platform-samples/blob/main/node/app.js)
及 [Messenger Webhooks](https://developers.facebook.com/docs/messenger-platform/webhooks/)。
本次文档站访问受到限制，现有协议和替身测试不替代当前真实账号验证。

## 迁移与上线

由操作员用直连 URL 执行迁移 `0018`，再部署应用；部署不会自动迁移。
迁移只增加阅读和回执表，不删除消息、身份或现有状态。
所有已有客户输入对尚无阅读记录的人工成员默认为未读。
现有 Page 需要重新连接以扩充订阅，并在 Meta 应用的 webhook 配置启用对应字段。

真实账号回执是发布门槛：必须观察当前 Graph 版本/权限下的一次真实外发、echo、
delivery MID/watermark 和 read watermark，以及重复/撤权行为。只记录脱敏结论，
不要提交账户标识、凭据、客户内容或原始日志。未完成该检查不能声称生产回执已验收。
