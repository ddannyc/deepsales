# 下一版本当前任务索引

更新：2026-10-14，已回读 GitHub 票据状态。规格：[GitHub #14](https://github.com/ddannyc/deepsales/issues/14)。

17 张合并功能票中，14 张已完成关闭，3 张保持开放；另有 5 张真实验证票和父规格 #14 保持开放，共 9 张开放票。被合并原票的关闭仅代表任务迁移，不代表功能已验收。

## 已完成的功能票

| 票据 | 功能交付 |
| --- | --- |
| [#15](https://github.com/ddannyc/deepsales/issues/15) | 客户侧栏、属性、标签与身份关联 |
| [#18](https://github.com/ddannyc/deepsales/issues/18) | 完整会话历史、未读未回、送达与阅读状态 |
| [#34](https://github.com/ddannyc/deepsales/issues/34) | 组合搜索、筛选与保存视图 |
| [#21](https://github.com/ddannyc/deepsales/issues/21) | 内部备注、个人免打扰与托管操作 |
| [#24](https://github.com/ddannyc/deepsales/issues/24) | 人工媒体、录音、话术与私有素材发送 |
| [#35](https://github.com/ddannyc/deepsales/issues/35) | 翻译与可编辑 AI 回复建议 |
| [#26](https://github.com/ddannyc/deepsales/issues/26) | AI 发布历史、还原草稿、额度、诊断与用量分析 |
| [#37](https://github.com/ddannyc/deepsales/issues/37) | AI 引导、多轮测试与批量问题测试 |
| [#52](https://github.com/ddannyc/deepsales/issues/52) | 长期摘要、属性采集、受控标签与变量 |
| [#17](https://github.com/ddannyc/deepsales/issues/17) | 广告来源轨迹与 AI 映射学习 |
| [#40](https://github.com/ddannyc/deepsales/issues/40) | 语言时间、自然语气、等待、拆分、停止、通用转人工与附件兜底 |
| [#28](https://github.com/ddannyc/deepsales/issues/28) | 结构化问答、知识素材引用与发送 |
| [#63](https://github.com/ddannyc/deepsales/issues/63) | 内置动作、外部 API 工具与有序自定义技能 |
| [#61](https://github.com/ddannyc/deepsales/issues/61) | 主动回访计时、客户条件、变量与工具动作 |

当前会话上下文属于已有前置：规格 [#10](https://github.com/ddannyc/deepsales/issues/10) 和实现 [#12](https://github.com/ddannyc/deepsales/issues/12) 已完成关闭，代码提交 ed5d1e7 已在本地 main；不计入上述 17 张功能票。

## 仍开放的功能票

| 票据 | 已完成部分 | 剩余门槛与范围 |
| --- | --- | --- |
| [#45](https://github.com/ddannyc/deepsales/issues/45) | T41–T44：受众账本、普通群发、富内容、随机、翻译、定时及循环 | T45 utility 等待 #30；T55 marketing 等待 #31，不能据普通群发验收关闭整票 |
| [#60](https://github.com/ddannyc/deepsales/issues/60) | 提供方研究与实现契约准备 | T31 私有语音识别仍受 #32 真实提供方契约约束；用户暂缓付费验收 |
| [#69](https://github.com/ddannyc/deepsales/issues/69) | 候选策略与基准方案准备 | 等待 #68 的真实模型基准，不将未测量策略标记为快速模式已交付 |

## 真实验证票

| 票据 | 尚需确认的事实 |
| --- | --- |
| [#29](https://github.com/ddannyc/deepsales/issues/29) | 截图订阅类型的真实产品、权限、事件及发送契约；T64 仍为条件草稿，尚未发布实现票 |
| [#30](https://github.com/ddannyc/deepsales/issues/30) | utility 实际账号、模板审批与收件人资格 |
| [#31](https://github.com/ddannyc/deepsales/issues/31) | marketing 权限、地区、opt-in、费用及结果契约 |
| [#32](https://github.com/ddannyc/deepsales/issues/32) | ASR 地域、模型权限、私有音频成功/失败及 Worker 调用契约；付费验收暂缓 |
| [#68](https://github.com/ddannyc/deepsales/issues/68) | 经授权的真实模型比较：至少 50 个中性案例、至少两轮比较及质量、延迟、工具成功率与安全回归 |

## 本轮集成与验证范围

本轮新增实现已集成至 integration/next-version-completion，代码验证基线为 8073e54；截至本次核对尚未合并到 main、推送或部署。已完成关闭不等于当前生产站点已发布。

- 132 项单元、343 项真实 PostgreSQL 集成测试通过。
- 44 个浏览器场景分批通过：全量运行通过 43 项；剩余保存/发布场景修正等待接口完成后，独立复跑两次通过。
- 格式、lint、类型、构建及 Standards / Spec 独立复核通过；发现项已修复复核。
- 本轮验证使用本地替身渠道与测试数据库，未执行付费模型验收或真实外部写操作，未应用生产迁移。
- 依赖清单和锁文件未改；既有审计高风险告警尚未处理，不将审计记为通过。

## 范围与历史记录

本轮仅 Messenger；Instagram 暂缓，群聊移出，不增加价格或下单意图专属转人工规则。T26/T27 为已完成公开研究，不重复发布任务。

原票归属见 [任务合并记录](NEXT_VERSION_TICKET_CONSOLIDATION.md)，原 T01–T64 契约与阶段依赖见 [任务拆分历史](NEXT_VERSION_TICKETS_DRAFT.md)，最终范围见 [正式规格](../implementation/NEXT_VERSION_SPEC.md)。本索引已移除重复的首次发布票表，原票映射保留在合并记录与 GitHub 中。
