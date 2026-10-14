# 下一版本规则与渠道一手资料研究

研究日期：2026-10-10。范围：八张截图、T26/T27 及关联任务。公开资料研究与产品规则确认已完成，[正式规格](../implementation/NEXT_VERSION_SPEC.md) 已发布为 [#14](https://github.com/ddannyc/deepsales/issues/14)，任务拆分随后获批并进入实现。本文保留研究时的证据与限制；2026-10-14 的交付及剩余真实验证见 [任务索引](../planning/NEXT_VERSION_ISSUES.md)。研究过程本身未操作真实账号或发送客户消息。

## 证据与使用范围

本轮采用新版 AI 帮助中心截至 2026-10-09 的专题、Meta 官方文档及 Meta 自有 Postman 示例。旧 AI 教程、通用 API 示例与新版专题冲突时，按适用产品版本和入口分别解释，不把旧规则覆盖到新版。

- **文档已核实**：官方明确描述产品行为或 API 契约。引用跟随相应结论。
- **截图已确认**：仅证明可见字段、入口和当前配置状态，不能推导默认值或内部算法。
- **未决**：公开资料不足、接口未访问到或需实际账号资格验证；未检索到不等于功能不存在。
- **项目设计**：数据库授权、幂等、预算、保留期限等内部选择，不声称复制了参考平台内部实现。

原始外部研究位于仓库外的 `%TEMP%/deepsales-reference-review-20261010/`：

- `AI_SETTINGS_PRIMARY_SOURCE_RESEARCH.md`：AI-R01–AI-R16，一手链接、更新日期和逐项未决。
- `CHANNEL_PRIMARY_SOURCE_RESEARCH.md`：CH-R01–CH-R17，渠道权限、事件及模板契约。
- 官方页面摘记与旧核对记录同目录保管；包含用户禁止名称的来源不复制到仓库。本笔记仅引用不含该名称的官方 URL，不复述客户截图内容。

以下结论不恢复价格、购买意图或下单咨询专属转人工。现有 Member、单一所有者、Assignment、容量、HUMAN_ONLY、PostgreSQL 权威、grounding 与输入新鲜度不变量继续有效。

研究后第一轮产品决定见 [需求记录](../planning/NEXT_VERSION_DISCOVERY.md)：长期记忆保留至管理员清除；历史仅还原 AI 发布配置到草稿、独立资源不回滚；回访从发送接口确认成功计时，安全失败有限重试复用同一记录、结果不明暂停；无法解析附件采用可选兜底/本轮跳过，通用转人工仍有效。此次群聊相关功能已移出，下面的群聊资料仅作研究追溯，不构成接入授权或当前交付依赖。

第二轮 Q7–Q14 全部选择 A：清除前历史不自动重建，明确关联客户跨渠道共享摘要；失效历史引用修复或主动移除后才可发布；回访提供两种计时入口，编辑/重新开启不重置当前会话已触发事实，必要动作成功后才发消息；默认标准模式、管理员可启用经测量的快速模式；Instagram 首次采用关联 Facebook Page 路径。这些是项目产品决定，不声称公开文档证明了未披露的内部实现。

第三轮 Q15–Q21 全部选择 A：解除关联清除受影响的共享摘要，各自从新沟通形成记忆；人工属性受保护；即时定义变化重新校验未完成结果/动作，撤权立即阻止未执行动作；技能只执行首个匹配项；不同回访规则串行重新校验；额度耗尽保留入站并转人工；自动语言接受明确切换。用户已回复“可以”确认最终共享理解；工程默认明确标注为项目参数，任务发布仍需粒度审阅。

## AI 配置、记忆和测试

| 能力 / 关联任务 | 文档已核实的行为 | 仍需明确的边界 |
| --- | --- | --- |
| 语言 / T25 | 自动模式根据客户前几轮消息识别主要语言，确定后沿用；固定语言仍可选。[官方配置说明](https://help.helpknow.net/docs/C1UtfF80) | 语言不明、切换语言及重置身份的项目规则；不能改成每条消息任意切换 |
| 快速模式 / T49、T63 | 速度提升伴随回答质量、转人工和工具调用成功率权衡。[官方配置说明](https://help.helpknow.net/docs/C1UtfF80) | 模型、推理参数、默认值及速度/质量验收阈值未公开；T63 实测有效策略后交付 T49 |
| 长期记忆 / T28、T01 | 客户长期摘要在沉默后更新；同项目同客户跨会话、跨 AI 使用，与结构化属性独立。内测需开通。[官方记忆说明](https://help.helpknow.net/docs/bjvT3uhM) | 沉默时长、摘要预算/清除/期限、身份和跨渠道匹配规则未公开；#12 继续只补当前会话上下文 |
| 拟人 / T32、T50、T51 | 包括自然语气、等待聚合、长回答拆分上限/间隔，以及无法解析消息的可选兜底；保存后发布生效。[官方回复设置](https://help.helpknow.net/docs/LyBYMb6H) | 隐藏参数未公开；已在规格列工程默认、输入新鲜度及部分送达状态 |
| 兜底 / T50 | 兜底按输出语言翻译，可配置随机话术；未开启时参考实现对无法解析消息不回复。[官方回复设置](https://help.helpknow.net/docs/LyBYMb6H) | Q5 已选可选兜底/单轮跳过、通用 handoff 及故障安全保留；不推导销售静默政策 |
| 语音与时间 / T31、T25 | 语音识别理解入站内容；当前时间可选时区。[官方配置说明](https://help.helpknow.net/docs/C1UtfF80) | 识别失败、付费调用、转写来源及可信时钟由项目约束；没有语音出站的对齐依据 |
| 测试与批量 / T20、T22 | 可设置模拟客户、重置用户含记忆；批量问题对应逐题回答及依据/状态，消耗消息额度。[测试配置](https://help.helpknow.net/docs/C1UtfF80)、[批量测试更新](https://help.helpknow.net/docs/kaCfYkL6) | 未证实预期答案自动评分、并发、取消、历史版本测试契约；普通问答测试不能证明真实转人工/回访 |
| 历史还原 / T18 | 发布保留历史；支持预览、还原当前配置，再发布生效。[版本说明](https://help.helpknow.net/docs/C1UtfF80) | 历史是否包含实时规则/工具未公开；不能承诺跨资源一键回滚 |

拟人及快速设置只对齐可观察行为，保留 AI 身份标识；文档中的示例人设不成为项目预置指令。等待、拆分和重试仍须符合新鲜度及已提交消息送达边界。这是项目约束。

## 属性、标签、广告、变量及技能

| 能力 / 关联任务 | 文档已核实的行为 | 对草稿的影响 |
| --- | --- | --- |
| 属性采集 / T02、T48 | 文本、选项、数字；用户级和会话级，级别创建后不可改。新值覆盖，历史记录保留当时值；配置 CRUD/启停实时生效。[属性采集](https://help.helpknow.net/docs/3F9aGk4F)、[生效规则](https://help.helpknow.net/docs/k3uvDNON) | T28 长期摘要与 T48 属性采集已分开；T02 两级属性共用规范数据源，人工保护是项目决定 |
| 标签 / T29 | 预先定义标签值和判断描述，AI 追加匹配标签；开关发布，规则保存实时生效。[标签说明](https://help.helpknow.net/docs/duPsQaiV) | 收敛为授权集合内追加；人工管理、模型陈旧写入及删除冲突另定 |
| 广告学习 / T05、T30 | 来源广告 ID 查配置的广告/商品映射表；每 AI 一张表，重新上传替换，需发布。未填资料不会自动抓取。[广告学习](https://help.helpknow.net/docs/zwmibjkV) | 仅接收 referral 不足以补齐，需映射管理、验证及知识 grounding；不扩大成任意广告抓取 |
| 变量及内置动作 / T36、T53、T40 | 变量包括联系人、自定义属性/标签及 AI 轮次；位置决定可选集合。工具含转人工、记录、单轮跳过、知识检索/素材发送。[变量与工具](https://help.helpknow.net/docs/HK21H4oK) | 内置领域动作与第三方 API 分票；测试写操作必须沙箱化，真实权限由服务端判断 |
| 外部插件 / T54 | 插件组织工具，工具定义 API、鉴权、输入位置/类型、输出映射与调试；工具保存实时生效。[插件与 API 工具](https://help.helpknow.net/docs/4OJXbjX9) | 主配置引用与实时工具定义分别追溯；密钥、URL/权限校验、超时和未知写结果暂停是项目必需设计 |
| 自定义技能 / T37 | 自然语言触发条件与执行指令可引用变量、知识和工具；需发布。[自定义技能](https://help.helpknow.net/docs/ym5SYzlR) | 无通用流程图引擎证据；项目已选择管理员排序，只执行首个匹配技能，不声称这是未披露的官方内部顺序 |

### 配置生效边界

不同资源的生效方式应分别建模，不能只看页面顶部的发布提示：

| 资源 | 官方生效方式 | 证据 |
| --- | --- | --- |
| 主配置、拟人、停止、群聊 | 保存后发布 | [主配置](https://help.helpknow.net/docs/C1UtfF80)、对应专题 |
| 属性 CRUD/启停、回访 CRUD/启停 | 保存即生效 | [技能生效规则](https://help.helpknow.net/docs/k3uvDNON) |
| 标签功能开关 / 标签规则 | 开关发布 / 规则保存即生效 | [标签说明](https://help.helpknow.net/docs/duPsQaiV) |
| 广告开关与映射表、自定义技能 | 发布 | [技能生效规则](https://help.helpknow.net/docs/k3uvDNON) |
| 外部工具定义 | 保存即生效 | [插件工具](https://help.helpknow.net/docs/4OJXbjX9) |
| 通用转人工及历史还原包含哪些实时资源 | 本轮未能确定完整生效/历史契约 | [转人工专题](https://help.helpknow.net/docs/cUbTq33R) |

版本、运行读取时点和即时撤权需要单独约定。若选择统一发布，必须标为本项目差异并显式决定，不能写成已对齐事实。

## 停止、转人工、群聊与回访

### 自动停止与通用转人工

自动停止可用属性/标签/轮次条件或每周时段，条件组内 AND、组间 OR；可设置结束文字/图片。条件停止持续到当前会话结束，时段停止结束后需客户新消息恢复。停止不自动转人工，回访计入轮次，已停止会话不继续回访。停止条件可问答测试，时段需实际渠道。[官方停止说明](https://help.helpknow.net/docs/nzGiamuD)

内置“停止回复”动作只跳过本轮，与持续停止分开。[内置动作说明](https://help.helpknow.net/docs/HK21H4oK)

通用转人工支持自定义/属性条件、接待时段和分配方式。文档还描述无人可用时继续 AI 或退出、指定分配可不受容量约束等选项；这些与本项目既有容量及 HUMAN_ONLY 契约有差异，不能未经决定复制。无统一价格/下单专属触发要求。[新版转人工说明](https://help.helpknow.net/docs/cUbTq33R)

任务已拆为 T50 本轮跳过、T33 会话停止和 T52 通用转人工。停止后的入站消息仍须进入规范收件箱，不能因参考 AI 分析页不显示而删除或漏收。

### 群聊产品规则（已移出本次范围）

新版群聊设置支持任意消息，或 @AI / 任一关键词；首次触发进入连续接待，群内 5 分钟无新消息退出。可按显示名称排除内部成员，保存后发布，需真实群验证。官方提及企业微信、Telegram、WhatsApp，但未说明各自是否采用官方 API。[官方群聊设置](https://help.helpknow.net/docs/e8pCIhY0)

这是参考产品规则，不能证明 Messenger/Instagram 群接口存在。显示名碰撞、@解析和接待期的持久授权是项目必须处理的边界；旧版“每条都要 @”不覆盖新版连续接待语义。

### 回访规则

两种计时入口为最后 AI 回复及重新分配 AI；客户回复取消旧计时，后续 AI 回复重新计时。规则保存实时生效，不回溯启用前沉默客户。要求可空，面向全部或条件客户，条件组内 AND、组间 OR；关闭、转人工、自动停止阻止待触发回访。[官方回访规则](https://help.helpknow.net/docs/YdSovW0t)

回访可同步执行已配置动作；同规则每个参考 AI 会话最多触发一次，不同规则各自可触发。文档未说明失败消耗名额、规则重建、事务/重试或“最后回复”的精确发送阶段。[官方回访规则](https://help.helpknow.net/docs/YdSovW0t)

因此：

- 研究前 T38 的“至多一次有效提交”不能当作“触发一次”的同义词；现已修订为一次触发记录包含生成/动作/消息及同记录内安全恢复。
- 最后回复锚点现已选定发送 API 接受，不是应用提交或真实送达。
- 重新分配锚点已被官方证明，用户现已决定纳入本轮，每条规则选择一个计时入口。
- 真实 handoff/回访需实际渠道验收；安全沙箱可以测试内部逻辑，但不能替代平台资格验证。
- 主动事件不能把旧客户输入伪装为新输入。项目已选择必要动作先成功、再发送消息；同规则/Conversation 一次，安全重试复用记录，不同规则串行校验；通知授权和恢复工程细则在规格中明确。

## 渠道接口与消息资格

### 截图能够确定的渠道

S1 可见 Messenger 与 Instagram 身份；S2 选择 Messenger 群发，列出普通、订阅、营销及通知模板；S4 显示身份/客户/账号关联列。关闭的渠道下拉没有证明完整渠道列表。S1 的群组筛选与 S5 的群聊设置未标明真实群传输渠道。证据为本地 S1/S2/S4/S5，目录见 [截图差距矩阵](../planning/NEXT_VERSION_FEATURE_PARITY_PLAN.md)。

### 标准窗口、主动消息与人工权限

Meta 2026-09-28 政策区分入口：多数标准窗口为 24 小时；点击 Messenger/Direct 广告后客户发送首条消息，可能得到最长 7 天窗口。这不是任意 referral 的普遍授权。人工客服的 7 天窗口仅供手动回复，不能借给 AI、回访或自动群发。[官方消息政策](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview/?locale=en_US)

回复与主动更新的发送目的需分别处理；旧三类标签已在 2026-04-27 起失效，不能用作模板捷径。[官方发送说明](https://developers.facebook.com/docs/messenger-platform/send-messages)

本轮未取得一个能直接证明该广告例外资格的确定返回字段或全部开放条件。保留现有窗口实现，待规格和账号验证后才调整；有效 API 版本不冻结平台政策。配置使用 v26.0，官方表列 2026-07-29 发布、到期待定。[官方版本表](https://developers.facebook.com/docs/graph-api/changelog/versions)、[当前部署配置](../../apps/worker/wrangler.jsonc#L133)

### 模板与营销须拆分

| 类型 / T45 | 文档已核实 | 未决 / 接入要求 |
| --- | --- | --- |
| Messenger utility | 有专用权限、模板审批与状态；非营销用途。[官方 utility API](https://developers.facebook.com/docs/messenger-platform/send-messages/utility-messages/) | `page_utility_messaging` 实际授权、模板/收件资格及状态订阅字段要验证；审批不允许夹带营销 |
| 付费 marketing | 有技术供应商/应用审核、地区、许可及费用要求。[官方 marketing 概览](https://developers.facebook.com/docs/marketing-messages-on-messenger/) | 自托管应用能否满足准入、账号和接收地区、预算需真实核对 |
| marketing 订阅与发送 | 订阅 token、撤销/到期、下一可发送时间；返回 tracking ID，后续异步事件报告结果。[订阅 token](https://developers.facebook.com/documentation/business-messaging/messenger-platform/marketing-messages-on-messenger/get-subscription-tokens)、[发送 API](https://developers.facebook.com/documentation/business-messaging/messenger-platform/marketing-messages-on-messenger/send-messages) | 不能复用普通立即返回 message_id 的完成状态；单 token 间隔与额外频率限制都须执行 |
| 截图“订阅模板” | 尚未正向映射到当前 provider 产品 | 不把新闻订阅、一次通知、营销 opt-in 或旧循环通知互换；此部分仍未决 |

营销还有独立频率上限；遇到限制不能立即反复重试。自定义节奏和循环不能扩大平台许可。[官方 marketing 变更说明](https://developers.facebook.com/documentation/business-messaging/messenger-platform/marketing-messages-on-messenger/changelog)

模板资料中的订单示例不要求新增订单领域；只实现取得资格的消息类型与真实模板数据。禁用按钮或占位页面不代表 B10 已补齐。

### 阅读、送达与广告来源

Messenger delivery 可含消息 ID 和 watermark，read 使用 provider 水位；Instagram 使用独立 seen 事件。发送 API 接收与真实送达/阅读分开，`mark_seen` 是商家确认已看入站消息。[官方 webhook 概览](https://developers.facebook.com/docs/messenger-platform/webhooks/)、[read 事件](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/message-reads)、[delivery 事件](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/message-deliveries)、[发送 API](https://developers.facebook.com/docs/messenger-platform/send-messages)

水位需按真实 Page/客户对及可靠 provider 时间映射，不能使用 HTTP 完成的本地时间冒充 provider 发送时间。Instagram seen 的具体 payload 本轮未完整取得；T08 可收敛 Messenger 部分，Instagram 映射仍待补证据。这个映射安全约束是本项目设计。

referral 可独立出现，也可嵌在入站消息内；首次广告入口与重开线程不同。T05 需处理两者，独立 referral 不应制造虚构客户消息，缺少广告标题/图片保持缺失；广告 ID 不自动赋予广告 API 权限。[referral 事件](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messaging_referrals)、[message 事件](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messages)

### Instagram、媒体及群组边界

Instagram 专业账号私信具备独立认证/权限契约，需选定 Instagram Login 或关联 Page 的一种路线；高级访问及媒体限制按账号/渠道验证。官方明确专业账号群聊不支持，一次会话面对一个客户。[Instagram 官方消息接口](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api)

现有 Messenger 媒体发送可用，但格式、大小、上传复用和 provider 访问私有文件的机制仍需定契约；不能把全部 R2 文件公开。素材/话术库也不自动等于 provider quick-reply 按钮。[官方发送接口](https://developers.facebook.com/docs/messenger-platform/send-messages)、[Meta 自有 API 示例](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api)

Facebook `group_feed` 处理群中商业 Page 帖子评论及私人回复，是另一类互动，不证明多人 Messenger 群聊接口。现有 Page-to-PSID 接口没有足够群聊证据，不能把检索受限解释为全平台永远不存在群接口。[官方 group_feed](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/group-feed)、[官方发送接口](https://developers.facebook.com/docs/messenger-platform/send-messages)

T46 可收敛为截图已证明的 Instagram 私信接入；T47 已按 2026-10-10 用户决定移出，群聊接入、触发和连续接待不进入本次实现或发布。

补充核对：Instagram Login 不要求关联 Facebook Page，关联 Page 路径可复用现有 Facebook 授权结构，但当前 Messenger 权限不等于 Instagram 权限。用户已选择首次采用关联 Page 路径；实际权限与应用审核仍须验证，不同时实现两条认证路线。[Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login)、[关联 Page 接入](https://developers.facebook.com/docs/messenger-platform/instagram/get-started)

## 当前仓库事实

本轮先用 CodeGraph 定位并读取当前源码，再查部署配置。以下是本项目事实，不是参考平台结论：

| 项目事实 | 直接证据 | 影响 |
| --- | --- | --- |
| Page 权限只有 pages_messaging、pages_manage_metadata、pages_show_list | [权限集合](../../apps/worker/src/facebook.ts#L3) | 不证明 Instagram、utility、marketing 或群聊已获权 |
| 仅订阅 messages；规范化要求事件含 message | [订阅](../../apps/worker/src/facebook.ts#L106)、[规范化](../../apps/worker/src/facebook.ts#L327) | 独立 read/delivery/referral 未形成业务链路 |
| 出站仅 RESPONSE 文字，成功取得 message_id | [适配器](../../apps/worker/src/facebook.ts#L143) | 主动群发/回访目的及新类型不能无条件复用 |
| 完成函数置 SENT，providerSentAt 为本地 now | [完成记录](../../packages/db/src/outbound.ts#L328) | SENT 表示发送 API 已接受，不证明客户送达/已读；T38“已送达”文字需改口径或增加真实回执依赖 |

补充源码核对：Alibaba 请求已经设置 `enable_thinking: false`，因此仅添加同值“快速”开关没有运行差异。官方说明思考存在耗时、token 与质量权衡，但未提供本项目延迟保证；用户已选定默认标准、可启用快速，工程策略须以代表性问题集实测选择。[模型思考说明](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)

当前无非空文字的附件消息固定走不支持附件转人工，模型输出仅有 ANSWER/HANDOFF；混合文字与附件只将文字送入模型。Q5 因此需要显式新增本轮跳过语义，不能把空输出或坏 JSON 当静默成功。提供方失败的安全处理继续保留。逐条源码和测量建议保存在仓库外 `AI_RUNTIME_BASELINE_AUDIT.md`；尚未运行真实模型基准。

## 已落实的任务修订与验证门槛

下列修订已落实到规格 #14 和任务草稿，尚未发布新的实施票或完成实际实现。

| 草稿 | 必须修正 / 可收敛结果 |
| --- | --- |
| T01 / #12 | 保持当前 Conversation 上下文，另立长期摘要任务，不扩写旧票 |
| T02、T28、T48 | 客户级/会话级属性与长期摘要分票；人工保护、保留/清除/解绑和来源规则已定 |
| T18 | 仅还原 AI 配置到草稿再发布；独立规则/工具与客户值不回滚；失效引用修复或主动移除后才可发布 |
| T20、T22 | 增加用户含记忆重置；批量基本问题集/结果可收敛，不强加自动评分；真实回访/分配另验 |
| T25 | 自动语言按客户早期语言确定后沿用，低信息及重置行为明确 |
| T29 | AI 追加授权标签；区分功能开关发布与规则实时 |
| T30 | 加广告/商品映射维护、替换与发布；缺少映射不能臆造答案 |
| T32、T49–T51、T63 | 自然语气/等待、快速、兜底/跳过、拆分已分票；快速模式先过实际基准门槛 |
| T33、T50、T52 | 持续停止、本轮跳过和通用转人工分票，条件/时段/恢复和逻辑轮次写入规格 |
| T36、T37、T53、T54 | 变量、内置工具、外部插件和自然语言技能分票；实时变更与首个匹配契约明确 |
| T38–T40 | 两种计时入口均纳入；安全重试复用触发记录，编辑/重新开启不重置名额，必要动作成功后发送；继续明确并行命中、实时变更、恢复和受众条件 |
| T08、T41 | 接收/送达/已读分开；provider 时间、水位、主动发送目的及窗口验证明确 |
| T45、T55–T58、T64 | utility、marketing、订阅各自分票并有正向契约/资格门槛，保留费用约束 |
| T46、T59–T61 | 用户最新决定全部暂缓：不发布账号验证、文字接入、媒体或 seen 实施票 |
| T31、T62 | ASR 先验证实际提供方/私有音频契约，不用展示音频充当识别 |
| T47 | 群聊已移出本次范围，保留未交付记录，不发布或实施 |

## 规格工程参数与事实验证

1. **工程参数**：摘要触发/长度预算、等待/拆分默认值、有限重试次数及退避、未知结果核对恢复、逻辑额度与 provider 成本分别记账、实时定义版本与输入截止点；在规格标明工程依据或项目默认。
2. **已确认规则**：共享/清除/解绑、人工属性保护、即时定义变更、技能命中、语言和额度；回访两种入口/一次触发/串行校验/动作先成功及失败策略不重问。
3. **渠道事实**：Instagram 全部功能及账号验证暂缓，原路线选择仅为历史；Messenger 实际权限、utility/marketing 准入及费用、订阅选项映射、广告窗口资格仍待验证；群聊分支关闭。
4. **效果验收**：代表性问题集测量快速模式实际延迟、回答质量与工具成功率，不承诺未经测量的提速比例。
5. **真实验收**：使用中性消息/文件，验证权限撤销、私信入站/外发、回执、广告入口和媒体；应用替身不能证明平台开放能力。

研究阶段完成时，产品选择及最终共享理解已确认，规格与任务修订待粒度和依赖审阅；后续已获批准并实施，状态见当前任务索引。不将 T26/T27 公开研究结束写成全部真实资格已验证，或所有条件草稿已可领取。

## 验证限制

本轮只读取官方文档、截图和源码；未登录账号、查看真实网络请求、查询生产授权、联系官方客服或调用真实外发 API。Meta web 抓取部分受限，使用原站 HTTP UTF-8 读取；少数字段拼写、示例版本和真实资格仍需 v26.0 账号验证。

本研究未运行应用测试、提交 Git、修改业务代码或发布实施票；后续规格已发布 #14。群聊移出、Instagram 相关功能及验证暂缓；其余截图功能继续在下一版本优先范围；接口未开放、资格未获或规则未决的部分仍算未交付。


## 最新范围说明

2026-10-10 用户决定先不开发 Instagram 相关功能；本文件保留已取得的公开研究作为历史证据，不授权本轮开展 Instagram 账号验证或实现。T46/T59/T60/T61 均暂缓。

## 后续任务发布状态

用户已批准拆分，55 个新任务及原生阻塞关系已发布并核对，见 [任务发布索引](../planning/NEXT_VERSION_ISSUES.md)。公开研究结束不代表真实资格已验证；T64 条件实现、Instagram 和群聊均未发布。此前研究阶段的未发布说明是历史记录。
