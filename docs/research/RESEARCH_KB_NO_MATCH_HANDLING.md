# 知识库无关联知识时的处理方案调研

调研日期：2026-09-16

## 结论摘要

“检索不到知识”不应直接等同于“必须转人工”。更稳妥的生产策略是把下面几种状态分开处理：

1. **闲聊或通用请求**：例如问候、讲笑话、改写文本。可以直接回答，但不得借此编造公司产品、价格、物流、售后等事实。
2. **业务问题但问题不完整**：先澄清一次，例如缺少商品、订单或地区信息。
3. **业务问题且知识库确实无答案**：返回安全的事实性不足提示，或在业务风险较高时转人工。
4. **明确要求人工、高风险、强烈负面情绪、重复无法回答**：直接转人工，并把会话上下文交给人工。

因此，推荐把“无关联知识”作为一个**决策信号**，而不是单独的最终动作。对当前项目，最小可行方向是先增加“闲聊/通用请求”分流，并把无知识处理改成“澄清或安全兜底；特定条件才转人工”。

## 当前项目观察

项目规格已经定义了两条重要边界：普通问候可以不依赖知识库回答；任何公司特定事实都必须由检索到的知识支撑。[V1_IMPLEMENTATION_SPEC.md](../implementation/V1_IMPLEMENTATION_SPEC.md#108-ai-debounce-and-response)

当前实现大致是：先做配置化转人工检查，再做向量检索，最多取 6 个满足距离阈值的 chunk，最后让模型返回 `ANSWER | HANDOFF`。模型返回 `HANDOFF` 时，`handoffOnNoKnowledge` 会决定是否真正转人工；知识事实未被有效 chunk 支撑时，`enforceGrounding` 也会转人工或返回事实性兜底。[Worker route](../../apps/worker/src/index.ts#L1974) [AI response flow](../../apps/worker/src/index.ts#L2010) [`enforceGrounding`](../../apps/worker/src/ai.ts#L423) [`applyHandoffPolicy`](../../apps/worker/src/ai.ts#L461)

问题在于，当前提示词明确强调“公司事实必须由知识块支持”，但没有同样明确地告诉模型“闲聊和创作请求可以在没有知识块时正常回答”。于是“讲个笑话”可能经历以下路径：

```text
讲个笑话
  -> 知识库 0 命中
  -> 模型把无知识理解为无法回答
  -> HANDOFF / NO_KNOWLEDGE
  -> handoffOnNoKnowledge=true
  -> 转人工
```

这属于路由策略过于粗粒度，不代表知识库检索成功记录与消息发送成功记录本身矛盾。

## 常见处理方案对比

| 方案 | 适用条件 | 优点 | 主要问题 |
| --- | --- | --- | --- |
| **无命中即转人工** | 强合规、高风险、人工资源充足 | 最安全、实现最简单 | 闲聊误转；人工成本高；用户体验差 |
| **无命中直接安全兜底** | 低风险 FAQ、允许自助服务 | 不打断会话，成本低 | 可能让用户反复追问；不能解决复杂业务问题 |
| **先澄清一次** | 有业务意图但缺少对象、条件或范围 | 能挽回很多“检索失败其实是问题不完整”的情况 | 多一轮对话；必须限制次数避免循环 |
| **先做意图/领域分流** | 同时包含闲聊、业务问题、人工请求 | 能把“讲笑话”和“退货政策”分开；规则清晰 | 需要维护少量分类规则或分类器 |
| **查询改写后重检索** | 用户表达口语化、简称多、问题复杂 | 能降低误判为无知识的概率 | 增加延迟和模型调用；不能解决真正没有资料的问题 |
| **混合检索或重排** | 向量检索漏召回、关键词很关键 | 对专有名词、型号、政策编号更稳 | 增加数据库/模型复杂度，应先用指标证明需要 |
| **分级转人工** | 不同问题风险差异大 | 可把人工留给高风险和连续失败场景 | 需要记录风险、失败次数和原因 |
| **外部通用知识兜底** | 明确允许回答非公司知识的问题 | 对一般知识问题覆盖更广 | 可能泄漏边界、产生未经授权的业务建议；不适合直接回答公司事实 |

## 行业资料给出的共同做法

### 1. 用“无匹配/低置信度”作为事件，再决定后续动作

Dialogflow 将意图匹配置信度阈值和 no-match 事件分开，未达到阈值时可以触发兜底流程，而不是把所有情况都绑定到同一个动作。[Dialogflow intent matching](https://docs.cloud.google.com/dialogflow/cx/docs/concept/intent)

这对应到本项目，就是至少区分：

- `NO_HIT`：没有 chunk 过检索阈值；
- `WEAK_MATCH`：有结果但相关性弱或不确定；
- `GROUNDED`：答案使用的 chunk 合法且足够支撑回答；
- `OUT_OF_SCOPE`：问题本来就不是公司知识库问题。

### 2. 兜底通常是逐级的：理解、澄清、降级、转人工

Copilot Studio 的 fallback/handoff 指南把兜底拆成寻求理解、重新表述、消除歧义、说明能力边界，以及在无法继续时转人工；目标是避免直接把用户丢进死胡同。[Design graceful fallbacks and handoffs](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/cux-fallbacks)

对客服场景可简化成：

```text
首次低置信度 -> 澄清/请用户换一种说法
再次低置信度 -> 安全兜底，或按风险转人工
明确要求人工 / 高风险 / 负面情绪 -> 直接转人工
```

### 3. 普通对话可以有单独的生成式兜底

Dialogflow 的生成式 fallback 明确把问候、告别、重复、等待等基础对话与知识型匹配分开，并在生成失败时回退到预设回复。[Generative fallback](https://docs.cloud.google.com/dialogflow/cx/docs/concept/generative-fallback?authuser=19)

这支持当前项目增加一个很小的“通用对话”路由：讲笑话、问候、感谢、简单改写等不必因为知识库 0 命中而转人工；但系统提示词仍须禁止借此回答未被知识支撑的公司事实。

### 4. 检索失败时可以做一次检索修复，但不应无限重试

AWS Bedrock 的知识库检索能力包含重排、查询分解和迭代检索等方式，用于复杂查询或召回不足的场景。[Knowledge base retrieval](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-how-retrieval.html) [Reranking](https://docs.aws.amazon.com/bedrock/latest/userguide/rerank.html)

CRAG 论文的核心也是先评估检索质量，再决定是否纠正检索、过滤文档或采用其他检索动作，而不是盲目相信第一次召回。[Corrective Retrieval Augmented Generation](https://arxiv.org/abs/2401.15884)

实践上建议最多做一次轻量修复：查询改写或澄清二选一；如果仍无可靠知识，不要继续增加 agent loop。

### 5. 转人工应携带上下文，并把失败原因纳入观测

Microsoft 的 Bot Framework handoff 模式强调，转接时应让人工接管并传递会话上下文/记录，而不是只发一条孤立的“正在转人工”。[Transition conversations from bot to human](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-design-pattern-handoff-human?view=azure-bot-service-4.0)

RAG 评估通常至少分别关注检索质量、相关性和回答是否被上下文支撑，而不是只看模型 API 是否成功。[Azure RAG evaluation](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/rag/rag-llm-evaluation-phase)

## 推荐给当前项目的策略

### 第一阶段：最小改动

1. 在知识库检索和 `NO_KNOWLEDGE` 转人工之前增加通用请求分流。
2. 在系统提示词中明确：问候、笑话、闲聊和一般创作请求可直接回答；公司事实必须有知识 chunk 支撑。
3. 对业务问题的 0 命中，默认先返回一次澄清或安全事实性兜底，不要默认立即转人工。
4. 保留以下直接转人工条件：明确要求人工、高风险业务、明显负面情绪、连续一次澄清后仍无答案、附件/模型运行故障等。
5. 给每次决策记录 `route`、`retrieved_chunk_count`、最高相关性/距离、`handoff_reason` 和是否经过澄清。不要为了观测新增保存完整敏感原文。

推荐的决策流：

```text
明确要求人工 / 高风险 / 负面情绪
  -> HANDOFF

问候 / 讲笑话 / 通用创作
  -> ANSWER（不使用知识库，不声称公司事实）

公司业务问题
  -> 检索
     -> 可靠命中：基于 chunk 回答
     -> 问题不完整：澄清一次
     -> 无可靠知识：安全兜底；高风险或再次失败则 HANDOFF
```

### 第二阶段：有数据再增强

只有当日志证明大量“本来有答案但 0 命中”时，再增加查询改写、关键词/向量混合检索或重排。不要一开始同时引入分类器、重排模型、外部搜索和多轮 agent，这些解决的是不同问题，会让“为什么转人工”更难排查。

建议先建立一组最小回归样本：

| 输入 | 预期路由 |
| --- | --- |
| 讲个笑话 | `ANSWER`，不查公司知识 |
| 你好 / 谢谢 | `ANSWER` |
| 你们的退货政策是什么 | 有命中则 grounded answer；无命中按策略兜底或转人工 |
| 多少钱 | 澄清商品/规格，而不是立即转人工 |
| 我要找人工客服 | `HANDOFF` |
| 连续两次询问均无公司知识支撑 | `HANDOFF` 或进入人工队列 |

## 不建议的默认方案

- 不建议把“检索 0 条”永久绑定为“立即转人工”，除非该工作区明确是高风险、强人工服务模式。
- 不建议让通用模型在没有知识 chunk 时猜测价格、库存、物流、退换货、承诺或政策。
- 不建议为了挽救所有 0 命中直接接入公网搜索；公司知识、客户隐私和答案授权边界会变复杂。
- 不建议无上限地查询改写和重试；一次修复或一次澄清足够作为第一版。

## 参考资料

- [Microsoft Azure RAG prompt engineering](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/rag/rag-prompt-engineering)
- [Google Dialogflow CX intents and confidence threshold](https://docs.cloud.google.com/dialogflow/cx/docs/concept/intent)
- [Google Dialogflow CX generative fallback](https://docs.cloud.google.com/dialogflow/cx/docs/concept/generative-fallback?authuser=19)
- [Microsoft Copilot Studio graceful fallbacks and handoffs](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/cux-fallbacks)
- [Microsoft Bot Framework bot-to-human handoff](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-design-pattern-handoff-human?view=azure-bot-service-4.0)
- [AWS Bedrock knowledge base retrieval](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-how-retrieval.html)
- [AWS Bedrock reranking](https://docs.aws.amazon.com/bedrock/latest/userguide/rerank.html)
- [Corrective Retrieval Augmented Generation paper](https://arxiv.org/abs/2401.15884)
- [Microsoft Azure RAG LLM evaluation](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/rag/rag-llm-evaluation-phase)
