# DeepSales 下一版本功能规格

规格确认：2026-10-10。交付状态更新：2026-10-14。规格已发布为 [#14](https://github.com/ddannyc/deepsales/issues/14)，仍保持开放；17 张合并功能票中 14 张已完成关闭，3 张等待真实渠道或模型验证。当前状态及验证范围见 [任务索引](../planning/NEXT_VERSION_ISSUES.md)。T64 保留条件草稿；Instagram 暂缓，群聊移出范围。

## Problem Statement

现有共享收件箱能完成 Messenger 的基本接待、知识回答和人工接管，但客服还不能在同一工作台维护完整客户资料、搜索和追踪会话、发送媒体、复用素材、翻译或获得可编辑建议。管理员缺少独立长期摘要、高级 AI 设置、测试和版本诊断，也无法可靠执行主动回访和群发计划。

用户已将八张截图中可见的缺口列为下一版本优先范围；随后明确移出此次群聊及 Instagram 功能，并撤回销售专属转人工需求。本规格描述最终范围，不修改冻结 Lean V1 文档。既有 #10/#12 继续单独交付当前 Conversation Context，不重复发布或扩写为全部下一版本功能。

## Solution

在现有 React、Worker、PostgreSQL、队列和私有对象存储中逐步补齐客服工作台、客户资料、出站内容、AI 配置与测试、长期摘要和自动采集、工具与技能、主动回访、群发、分析与用量。本轮仅实现 Messenger 渠道；Instagram 接入、账号验证、媒体收发及阅读状态全部暂缓。

每项交付必须贯通持久状态、授权接口、页面和行为验证。单聊免打扰与群发继续在范围内；群组接入、群聊筛选、群聊触发和连续接待均不在本次范围；不新增 Instagram 功能或对应验证任务。禁用按钮、无效开关或假服务展示不算对应能力已补齐。

## User Stories

以下编号对应截图差距 ID；A05 仅含单聊免打扰，C08 已移出。共 56 条范围内故事，已有基础需补完整闭环。A03/A11/A12/B03 的渠道能力本轮限于 Messenger；Instagram 部分明确暂缓，不计已补齐。

1. **A01** — As a support agent, I want authorized personal, team, AI, waiting and historical conversation views, so that I can find the work I should handle.
2. **A02** — As a support agent, I want conversation search and combined filters with active-condition counts, so that I can locate a customer without manually scrolling.
3. **A03** — As a support agent, I want persistent personal unread state and genuine customer read receipts, so that I can distinguish my reading from the customer's reading.
4. **A04** — As a support agent, I want an unreplied filter based on successful replies, so that I do not overlook customer messages.
5. **A05** — As a support agent, I want to mute and filter my direct conversations, so that I can manage interruptions without changing ownership.
6. **A06** — As a support agent, I want personal saved views and authorized shared views, so that I can reuse useful filters.
7. **A07** — As a support agent, I want customer and conversation tags with common filtering, so that the inbox and audiences use consistent customer facts.
8. **A08** — As a support agent, I want original text and translated text plus send-time confirmation, so that I can communicate across languages without losing the original.
9. **A09** — As a support agent, I want authorized AI hosting controls, so that I can stop or resume AI through recorded domain actions.
10. **A10** — As a support agent, I want internal conversation notes, so that teammates can coordinate without sending those notes to customers.
11. **A11** — As a support agent, I want reusable phrases, materials, uploads, audio recording and emoji, so that I can send appropriate real channel content.
12. **A12** — As a support agent, I want a customer sidebar with contact fields, ownership, language and explicit social-identity links, so that I can maintain an accurate profile.
13. **A13** — As a support agent, I want actual advertising referral history, so that I can understand the customer's entry point without invented ad information.
14. **A14** — As a support agent, I want paginated conversations and older messages including closed episodes, so that earlier communication remains accessible.
15. **A15** — As a support agent, I want editable AI reply suggestions that I send myself, so that I can use assistance while retaining ownership.
16. **B01** — As an administrator, I want named campaigns on selected channels, so that proactive sends are managed and recoverable.
17. **B02** — As an administrator, I want searched and filtered recipient selection with an explicit audience snapshot, so that I know who will receive a campaign.
18. **B03** — As an administrator, I want recipient customer and channel identities displayed together, so that linked identities do not cause accidental duplicate sends.
19. **B04** — As an administrator, I want ordered rich campaign content, so that recipients receive the intended text and media sequence.
20. **B05** — As an administrator, I want persisted campaign translations, so that retries reuse the same customer-facing version.
21. **B06** — As an administrator, I want one random content item or all items per recipient, so that the selected sending rule remains stable during retries.
22. **B07** — As an administrator, I want default and custom pacing within provider limits, so that campaigns send at an allowed rate.
23. **B08** — As an administrator, I want recurring campaign rounds that can be paused or cancelled, so that scheduled repetition remains controlled.
24. **B09** — As an administrator, I want immediate and timezone-aware scheduled sends, so that execution happens at the intended time.
25. **B10** — As an administrator, I want genuine ordinary, utility, marketing and mapped subscription capabilities, so that each message type uses its actual approval and recipient contract.
26. **B11** — As an administrator, I want per-recipient campaign results and safe recovery, so that failures and unknown delivery outcomes remain visible.
27. **C01** — As an administrator, I want automatic early-language selection and explicit customer-requested switching, so that AI uses a consistent appropriate language.
28. **C02** — As an administrator, I want an optional measured fast mode with standard mode as the default, so that I can choose an understood speed and quality trade-off.
29. **C03** — As an administrator, I want editable AI persona generation and improvement, so that generated instructions remain under my publishing control.
30. **C04** — As an administrator, I want authorized variables and tool references in instructions, so that AI can use controlled information and actions.
31. **C05** — As an administrator, I want independent customer summaries shared across explicitly linked identities and AI members until I clear them, so that later episodes retain useful context.
32. **C06** — As an administrator, I want natural tone, bounded waiting, reply splitting and optional fallback, so that AI replies follow configured observable behavior.
33. **C07** — As an administrator, I want condition and weekly-schedule stopping distinct from skipping one turn and handoff, so that I can control replies without silently changing ownership.
34. **C09** — As an administrator, I want private incoming audio transcribed into attributed input, so that AI can understand supported voice messages.
35. **C10** — As an administrator, I want trusted current time in a configured timezone, so that customer text cannot substitute the system clock.
36. **C11** — As an administrator, I want documents, structured questions and private materials in knowledge, so that grounded replies can use appropriate evidence and assets.
37. **C12** — As an administrator, I want proactive AI follow-up using the complete rule contract, so that eligible customers can be contacted safely after a delay.
38. **C13** — As an administrator, I want typed information collection with protected human-edited values, so that AI improves profiles without overwriting human decisions.
39. **C14** — As an administrator, I want AI to append only authorized tags, so that tagging remains controlled and traceable.
40. **C15** — As an administrator, I want published ad-ID mapping uploads, so that AI uses configured advertising information rather than automatically inventing or fetching it.
41. **C16** — As an administrator, I want ordered natural-language skills with only the first match executed, so that multiple matches do not multiply actions.
42. **C17** — As an administrator, I want validated built-in actions and external API tools with encrypted credentials and diagnostics, so that configured capabilities operate within authorization.
43. **C18** — As an administrator, I want configuration and testing guidance, so that I can reach a working published AI without hidden setup steps.
44. **C19** — As an administrator, I want an isolated multi-turn test console, so that I can test drafts without customer messages or routing side effects.
45. **C20** — As an administrator, I want batch question results, evidence and failure states, so that I can compare behavior without unsupported automatic scoring claims.
46. **C21** — As an administrator, I want neutral simulated customer data and resettable test memory, so that tests do not change real customer profiles.
47. **C22** — As an administrator, I want feedback and authorized answer diagnostics, so that I can inspect the configuration and knowledge used for a poor answer.
48. **C23** — As an administrator, I want immutable published versions restored only to a draft, so that history review does not unexpectedly roll back live independent resources.
49. **C24** — As an administrator, I want real AI handling, reply, handoff, failure and usage statistics, so that retries are not mistaken for additional successful work.
50. **C25** — As an administrator, I want durable limits and visible usage with human handoff when quota is exhausted, so that new paid calls stop without losing customer input.
51. **C26** — As an administrator, I want generic custom handoff conditions through the existing assignment boundary, so that safety routing is configurable without sales-specific defaults.
52. **D01** — As an administrator, I want immediate follow-up rule CRUD and enablement, so that changed or disabled rules invalidate old pending work.
53. **D02** — As an administrator, I want one of two follow-up clocks per rule, so that timing starts after the last accepted AI reply or a new AI assignment.
54. **D03** — As an administrator, I want optional follow-up instructions and authorized tools whose necessary actions finish before sending, so that the message does not claim unfinished work.
55. **D04** — As an administrator, I want all eligible customers or controlled audience conditions, so that eligibility is checked again before execution.
56. **D05** — As an administrator, I want one trigger per stable rule and Conversation with bounded safe retries, so that editing, re-enabling and duplicate jobs do not create extra opportunities.

## Implementation Decisions

### Authority, boundaries and permissions

- 此规格是用户明确批准的下一版本扩展。保持 Member 同一模型、User 身份分离、单一所有者、Assignment 历史、HUMAN_ONLY 持续性、一个身份一个 OPEN Conversation、grounding、新鲜度、合法已提交消息独立送达及 PostgreSQL 权威。
- 保持模块化单体。扩展现有客户、会话、分配、AI、知识、渠道与送达模块；外部服务通过薄适配器和 native fetch。没有新服务、通用流程引擎、替代数据库或运行时。
- OWNER/ADMIN 管理全局定义、AI 发布/历史/测试/分析、工具、额度、群发和渠道。AGENT 在现有渠道/会话授权内查看、阅读、备注、建议、个人视图和免打扰；客户字段/标签编辑沿用可操作会话的权限，不能扩展到不可见身份或会话。共享视图由管理员维护，不建立自定义角色系统。
- 所有权相关操作仍经唯一分配边界。客户资料中的“归属”是资料字段，不能直接覆盖 Conversation assignee。内注与测试记录不是客户 Message。
- 跨渠道资料共享不能突破 MemberChannelAccess。长期摘要保留贡献渠道的来源；成员缺少任一贡献渠道权限时不提供混合摘要，只使用其有权限的当前上下文，并显示安全的记忆不可用原因。不得仅因身份关联就读取隐藏渠道对话。
- 数据库变更使用短事务、锁、工作区约束、唯一性和 forward migration；队列/定时扫描只领取持久待办。请求外部 provider、R2 或模型均在事务外。队列 payload 使用 ID 和版本，realtime 仅使客户端重新读取规范状态。

### Inbox and customer facts

- 保留五个固定视图，新增授权团队/历史入口、搜索、组合过滤和条件计数；标签、字段、成员、时间过滤共用客户事实来源。cursor 稳定排序，列表与消息分别分页，切换视图及 realtime 刷新不跳过第二页或打断历史滚动。
- 未读是每个人工成员的持久阅读水位；只标记实际加载并确认可见的入站范围。新入站超出已读水位重新未读，AI 回复不替人工已读。未回只在最新客户输入之后出现 SENT 的 AI/人工有效回复才清除；PENDING、FAILED、内注、建议和测试都不清除未回。
- SENT 保留“发送 API 接受”的意义。delivery/read 另存 provider 事件、可靠 provider 时间及身份水位；乱序和重复回执不倒退。不得用本地 HTTP 完成时间冒充 provider 时间，不能映射时保留未知而非猜测。
- 客户资料和客户级/会话级属性、标签、人工来源及历史值可查看；属性支持文本、数字、预定义选项，级别创建后不可变。人工填写值受保护，人工明确允许后 AI 才能覆盖；提取必须经过类型、来源、对象、权限和当前版本校验。
- 身份关联是明确的管理员/授权操作，不按同名同头像自动合并，不能跨工作区；更改关联不重写 Message 历史、Conversation 所有权或渠道发送资格。解绑停止摘要共享并清除受影响摘要，各自从新沟通形成记忆。
- 个人免打扰只影响该成员提醒和过滤，不改变其他成员提醒、入站持久化、所有权或 AI 路由。内部备注永不外发；仅把有权限的内注用于内部展示，不默认送给模型或客户。
- 独立 referral 和消息内 referral 均幂等保存，不制造虚构客户输入；来源、广告 ID、取得时间和可得字段可追溯，缺失信息保持缺失。

### Outbound content and channel contracts

- 人工媒体/录音复用私有存储、附件验证和现有 PENDING/SENT/FAILED 送达。按具体渠道验证格式、大小、类型、权限和发送目的；浏览器只访问授权资源。provider 读取私有素材使用受限上传或短期单对象授权，不能公开整个对象桶。
- 话术、素材库和知识素材共享受控引用；删除/替换素材不破坏合法已提交消息所引用的发送版本。表情是文字，不建立独立消息引擎。
- 原文、译文、目标语言及发送版本分别保留。人工发送先确认译文；群发每个执行轮次/身份翻译结果持久化，重试不重新翻译。人工 AI 建议需人工确认，不能自动取得所有权或外发；新客户输入使旧建议失效。
- 保留普通自动消息窗口限制。人工专属许可不借给 AI/群发/回访；广告入口例外只有在渠道资格得到验证时启用。主动更新与回应发送目的由适配器区别处理。
- 本轮仅实现 Messenger 渠道；Instagram 账号连接、授权验证、文字接待、媒体及 seen 状态不实现、不发布任务。既有身份关联与权限边界继续保留，不引入另一套渠道认证。
- utility、付费 marketing 和截图订阅类型分开接入：真实权限、模板审批、收件资格、地区、许可、撤销/到期、费用和限流均有能力验证门槛。未映射的订阅类型先完成证据核对，不用旧产品或 marketing opt-in 冒充。未获资格可解释限制，但不计功能完成。
- marketing 返回 tracking ID 的发送异步完成，不按普通 message_id 模式提前标成功。权限变化、频率限制和重试遵循对应 provider 契约，不因自定义节奏或循环绕过限制。

### Configuration versions, tests and live resources

- 发布形成不可变 AI 主配置版本，运行和测试记录所用版本；历史可预览、选择测试及还原到草稿，重新发布才上线。还原不回滚独立回访规则、属性定义、标签规则、外部工具或客户实际值。
- 还原后列出已删除/停用引用；修复或主动移除才能发布，不自动恢复旧工具或静默跳过。普通新发布也校验引用的当前资格。
- 主配置、自然回复设置、停止设置、广告开关/映射、自定义技能及顺序保存为草稿后发布；属性和回访 CRUD/启停、标签规则、外部工具定义保存即生效。标签功能开关需要发布。现有通用 handoff 的主配置开关继续随发布；新增独立条件定义的生效方式在同一页面明确说明。
- 即时资源记录修订版本。定义变化后重新校验尚未提交的结果/尚未执行的动作，必要时重新生成；撤权立即阻止尚未领取执行授权的动作。外部请求已开始或已完成时不能承诺自动撤回副作用；结果提交仍检查当前授权，恢复不能重复成功动作。
- 多轮测试隔离真实 Customer、Conversation、分配和外发，支持草稿/已发布/历史版本及模拟属性、标签、来源、语言和记忆。清空取消旧运行并重置模拟记忆，晚到返回不能写回。写工具只能用替身/沙箱，不能因“测试”名称直接请求生产写接口。
- 批量测试使用问题集，逐题记录回答、依据、状态、配置版本、失败/取消和逻辑用量；不添加未经证实的自动评分。单项重试与取消有持久记录，不污染生产客户。真实 handoff、回访和渠道权限仍需另行真实验收。
- 人设生成/优化及指导流程只生成可编辑草稿，人工比较/保存/测试/发布；诊断展示实际配置版本、知识引用、输入范围、动作状态、失败或取消原因。内容仅从授权存储读取，不复制进公开日志。

### Customer Memory and input handling

- Customer Memory 是独立长期摘要，不是属性集合或跨会话全文。按同工作区同客户跨 Conversation/AI 使用，仅人工明确关联的渠道身份共享；当前上下文 #12 继续单独交付。
- 管理员清除提高摘要的清除边界，使旧摘要和旧更新任务失效；清除前历史不自动重建，新沟通可形成新记忆。解绑同样清除受影响共享摘要。关闭读取不等于删除，既存摘要仍保留到主动清除；未启用时不执行新增摘要更新调用。
- 更新仅处理清除边界之后、尚未摘要的授权客户/有效 AI/人工通信；摘要带来源范围和修订版本，更新前后校验身份关联与清除边界。摘要不把未知内容改写为事实，客户历史不能作为公司政策/产品事实的 grounding 替代。
- 自动语言依据前几轮有效客户文字确定主要语言后沿用，客户明确要求切换时更新；低信息输入不改变已确定语言，未能识别时使用配置回退。固定语言模式继续使用配置值。可信当前时间来自服务端时钟和配置时区。
- ASR 只处理受支持的私有入站音频，转写绑定原消息并标记来源，不假称原始客户文字；格式/大小/长度和转写输出校验，费用受保护，重复任务复用转写。
- 对无法解析内容：匹配通用 handoff 条件仍转人工；否则启用兜底则发送相应输出语言的配置兜底，关闭则记录 Single-turn Skip。坏 JSON、空模型输出、提供方或运行故障不是正常跳过，保留安全故障处理。
- Single-turn Skip 不产生空 Message、不改变所有权、不设置 HUMAN_ONLY、不停止后续有效输入；内部诊断可以看到原因，客户收件箱仍接收入站。
- 自然语气、等待合并及拆分是不同设置，保留 AI 身份。生成使用当前输入截止点，新消息取消旧等待/生成。拆分属于一个逻辑回答：在一次合法提交检查中持久化全部内容段及顺序，再按间隔送达；因此后续接管不删除已合法提交段，部分失败保持可见且不自动重发结果不明的段。
- 快速模式默认关闭，标准模式默认；保持安全、grounding、工具授权和新鲜度检查。现有已关闭思考的参数不能充当新策略。以同一代表性问题集比较实际响应分布、回答质量和工具成功率后采用有效策略，未证明提速则 C02 仍未交付，不提供伪有效开关。

### Stop, handoff, tools and skills

- 持续停止、本轮跳过、转人工是不同动作，不增加 Conversation 生命周期状态。条件停止在当前 Conversation 持续；每周时段停止结束后由客户新消息恢复；停止后仍持久接收输入，不能丢失消息。
- 停止条件使用受控属性、标签、逻辑回复轮次或每周时段，组内 AND、组间 OR；关闭文字/图片可配置并遵循发送资格和 grounding。逻辑轮次包含回访，一个拆分回答只算一轮，不把重试或未提交生成当新回复。
- 停止阻止新回复和待提交回访，不自动转人工；客户明确要求人工等既有安全 handoff 继续走分配边界，HUMAN_ONLY 和容量规则不改变。不复制无人时继续 AI 或自动绕过容量等不同策略，不加入销售预设。
- 变量使用已授权联系人、客户级/会话级属性、标签、当前上下文、可信时间和逻辑轮次；缺失值明确为空/未取得，不能臆造、当作权限或形成任意 SQL/URL。
- 内置动作只调用已授权领域边界：通用 handoff、记录、单轮跳过、知识检索和素材引用/发送；外部工具是带输入类型、鉴权、输出映射、超时及状态的 API 定义，不是通用工作流引擎。
- 外部工具凭据加密、界面只显示是否已配置。出站 HTTPS origin 需在部署允许集合，禁止用户/模型动态指定主机、内网地址、协议或重定向；仅受控参数编码进预定路径、query/body。需要任意公共域名时先证明安全的网络校验能力，不绕过 SSRF 边界。
- 工具执行先在短事务领取当前授权的持久动作记录，再在事务外调用；写动作具有稳定调用 ID、对象/权限检查和独立结果账本。无 provider 幂等或结果查询证明时，发送结果不明暂停，不重试潜在已执行写入。只读安全调用可以有限重试。
- 自定义技能由自然语言条件和执行指令组成，可引用变量、知识、工具。管理员排序，按顺序仅执行首个匹配技能；技能不绕过前置安全路由和当前所有者，未匹配沿用正常 grounded 答复。
- 广告学习读取该 AI 发布的单张广告 ID 映射表，验证上传并整表替换，发布后生效；没有映射不自动抓取或臆造广告资料。

### Follow-up rules and recovery

- 每条规则有稳定 ID、AI Member、开关、修订、延迟、一个计时类型、可空要求及受众条件。CRUD/启停保存即生效；启用不追溯此前沉默客户。
- 最后 AI 回复类型从发送 API 确认成功计时；重新分配 AI 类型从分配边界提交的 AI 分配记录计时。只有该规则生效后的有效锚点才排程，不能伪造新客户输入。两类规则均绑定当前 Conversation、AI owner、输入截止点和规则修订。
- 新客户消息取消旧计时；最后回复型在后续有效 AI 回复后重计，分配型在新的有效 AI 分配后重计。同一规则/Conversation 已触发后，编辑、修改锚点、关闭再开启均不恢复机会；新 Conversation 重置。删除记录不删除已经发生的触发事实；重新创建是新的规则 ID，界面说明不是原规则修改。
- 数据库保证一次触发，不偷换成“一次成功提交”。一次触发包含生成、必要动作和消息状态，安全失败在同一记录内有限重试；结果不明暂停。回访失败/取消/已触发事实可见，重复队列、重启、重试不重复逻辑额度。
- 不同规则同时到期串行领取执行；先按到期时间、创建时间及稳定 ID 排序，每条重新校验。新客户输入、接管、停止或关闭取消后续未提交项。先前已提交回访可更新最后回复锚点，因此后续项使用重新校验后的实际到期时间，而非强行连续发送旧到期任务。
- 要求为空时根据授权当前上下文生成，知识事实仍 grounded。受众为全部合格客户或属性/标签等 AND 组、OR 分组；生成、动作和提交前分别检查对象、owner、输入、规则修订、停止、预算及渠道资格。
- 必要动作成功后才提交消息；逐项持久化动作结果，恢复不重复成功动作。动作已成功而后因新消息/接管不能发送时，显示部分完成状态，不假称外部事务整体回滚。
- 合法已提交 PENDING 消息沿用原有送达不变量；后来关闭/接管/规则关闭不取消合法内容，但适配器送达时仍校验实际 provider 许可。

### Campaigns, accounting and analytics

- 计划保存名称、渠道、消息类型、受众快照、内容版本、随机/全部规则、翻译、发送节奏、立即/定时、循环及操作者。保存和执行是明确动作，不默认把保存当立即发送。
- 工程默认采用保存时明确选择的身份快照，循环不自动加入新客户；执行时逐个重查发送/授权资格。关联展示不合并不同渠道外部身份；同计划轮次同渠道身份只领取一次，不能因客户重新关联而重复选入。
- 每一轮持久化身份与轮次顺序、内容块选择、翻译版本和逐块发送状态；随机结果产生后不可在重试时重选。暂停/取消停止未开始的轮次/收件项，合法已提交消息独立送达。
- 循环按保存时区和日历计划生成唯一轮次，明确夏令时缺失/重复时刻处理。停机恢复只恢复已有未完成轮次及下一次未来日程，不突发补发全部错过的历史循环。
- 系统默认节奏与自定义节奏都受 provider 实际限流和收件资格约束；429 等限制按其重试时间退避，未知写结果暂停。每个收件人显示等待、成功、失败、跳过、结果不明和安全解释，不能把接受当送达或已读。
- 用量账本区分逻辑操作、实际 provider 尝试和成本。一个逻辑回答即使拆分、重新调度或安全重试也只扣一次应用额度；批量每题、回访及独立测试/生成/摘要/转写/翻译操作分别有稳定操作 ID 和类型。provider 重试可能实际增加成本，实际尝试必须记录，不能宣称 provider 免费重试。
- 调用前领取持久预约，成功/失败按逻辑操作结算并释放未用预约；取消的未开始调用不扣额度，已实际调用的逻辑操作算一次，不因 provider 错误无限返还并重复调用。管理员配置的硬限额和新调用预约不能超额；没有设置限额时显示未设限，不伪造货币余额。
- 额度耗尽仍保存客户输入，经既有分配边界 HUMAN_ONLY 转人工；无人则排队，不等待额度恢复偷偷重新接回 AI。测试/后台摘要/批量等非真实接待调用则停止并提示，不对真实 Conversation 产生 handoff。
- 统计按真实持久事件和逻辑 ID 计算接待、回复、handoff、失败、skip、取消及用量；区分人工/AI、生产/测试、时间区间/时区/成员/配置版本。零数据、处理中和失败可见，不把生成尝试和重试视为额外成功。

### Explicit engineering defaults

以下是可逆的初始项目参数，不是参考产品已公开的默认值；在相关任务中实测并保留可解释的限额，不增加无需求的高级配置入口。

| 项目 | 初始契约 | 验证 |
| --- | --- | --- |
| 初始摘要功能 | 默认关闭；关闭不删除已存摘要 | 升级后原接待不新增摘要费用 |
| 摘要触发 | 客户通信沉默 10 分钟后；10 分钟是项目默认 | 新输入取消旧待更新，清除和解绑使旧任务失效 |
| 摘要预算 | 摘要最多 1,000 Unicode code points；每批按顺序最多 50 条、8,000 code points，剩余独立排程 | 不跳过未处理中段、不无限一次读取；超长消息截取注明输入截断 |
| 输入等待 | 沿用 2 秒；连续输入最多等待 30 秒后尝试领取当前输入，新输入仍执行新鲜度检查 | 不是强制在过期输入上输出，避免无限等待和旧回复 |
| 长回答拆分 | 默认关闭；启用时以约 500 code points 为目标，最多 3 段、间隔 1 秒；每段遵循 provider 硬限额 | 不靠拆分截掉回答尾部，超限在生成预算内处理；一回答一逻辑轮次/额度 |
| 安全重试 | 首次后最多 2 次，间隔至少 30/120 秒；provider 更长 retry-after 优先 | 每次再查资格，未知结果不走重试，耗尽保持失败可诊断 |
| 外部工具 | 单次 10 秒、响应最多 64 KiB、每轮最多 3 次工具调用 | 结果类型验证，终止有状态；不能借工具链绕过预算或权限 |
| 群发默认节奏 | 同渠道串行、至少 1 秒间隔，并执行 provider 的更严格约束 | 不承诺 1 秒对所有 provider 合法 |
| 批量测试 | 每批最多 100 题，默认串行，可取消未开始题 | 题级恢复及预算不重复，扩并发前以实际耗时验证 |
| 时间 | 没有明确配置时使用 UTC 并显示时区；计划必须保存选定时区 | 不能把用户浏览器时区隐式当计划时区 |
| 快速模式门槛 | 至少 50 条中性代表样例，对比标准模式至少两次；P50/P95、质量和工具成功率均报告 | 安全/权限/grounding 零新增失败；量化速度/质量结果后采用有效策略，不宣称固定提速保证 |

## Testing Decisions

沿用已讨论的最高测试边界：Worker 的真实路由、AI/出站队列及 scheduled handler，连接迁移后的真实 PostgreSQL；模型、渠道、工具和私有存储使用已有薄适配器替身。浏览器用现有 Playwright 流程。没有额外横向测试框架或单独服务。

- 好的测试断言可观察结果：授权用户看到何种资料/状态、哪些输入产生消息/动作、失败是否可恢复、到底外发几次。避免镜像实现或只断言开关可保存。
- 延续当前 AI/送达/分配数据库集成先例：唯一性、并发 claim、clear 与 summary 写回、解绑/撤权、人工属性编辑、旧配置引用、同时到期规则、新输入/接管/停止先后、合法提交之后接管、重复队列与未知结果暂停均用真实数据库验证。
- 单元/契约测试覆盖条件 DSL、模型/工具输出、语言低信息及明确切换、JSON/文件/转写边界、时区/夏令时、广告映射、receipt/referral、错误脱敏、URL/参数/输出映射安全和计费单位；错误输出不能被当正常 skip。
- Playwright 覆盖侧栏编辑/标签/身份、保存过滤、未读未回/历史、内注/免打扰、媒体/翻译/建议、版本还原/失效引用、测试重置/批量取消、规则/工具/技能编辑、回访、群发状态和额度耗尽。替身断言内注、草稿、测试和未确认建议从未真实外发。
- 实际账号验证由独立任务记录能力、版本、权限撤销、实际入站/外发/媒体/回执、模板审批/许可/费用、营销异步结果；实际模型基准记录配置与问题集版本。只使用中性内容，不提交账号数据、provider 凭据或原始日志。
- 每个实现任务完成受影响的 format、lint、typecheck、unit、integration、Playwright 和 build；集成/E2E 顺序执行。数据库变更提交审阅的 schema、forward migration、metadata 及操作说明。测试替身通过不替代真实平台门槛。

## Out of Scope

- 此次群聊及为群聊新增 Telegram、WhatsApp、企业微信接入。
- 销售专属价格、购买意图、下单转人工规则/开关/输出拦截或订单确认模型。
- 自动按同名合并客户、跨工作区记忆、无限历史全文记忆、独立资源全局一键回滚。
- Instagram 全部相关功能及实际账号契约验证暂缓；非截图证明的任意渠道、消费者 Web 群/桌面 Hook 接入。
- 通用流程图引擎、自动发给客户的人工建议、未经证实的批量自动评分、商业充值系统。
- 修改冻结 V1 基线、重开已撤回任务、重复发布 #12、Git 提交、部署或擅自真实外发。

## Further Notes

规则与官方契约以 [一手资料研究](../research/NEXT_VERSION_RULES_RESEARCH.md) 为证据入口，截图编号及覆盖以 [功能矩阵](../planning/NEXT_VERSION_FEATURE_PARITY_PLAN.md) 为准；所有产品选择及最终确认见 [需求记录](../planning/NEXT_VERSION_DISCOVERY.md)。任务已据此修订并发布，不按旧验收直接实现。

尚未验证的真实账号权限、订阅映射和模型效果保持明确门槛，不将这些事实缺口偷换为新增产品问题或已完成能力。发布任务时分开事实验证票与具体实现票，只有满足相关门槛才可领取相应实现。

本规格使用中性描述，不记录用户禁止名称、包含该名称的链接或私有业务内容。中文界面，首批客户通信验收英语；能力不限定英语。
