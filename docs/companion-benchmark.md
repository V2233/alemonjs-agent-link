# 肥鱼与养鱼方案的回复质量对照

`compare-companion.mjs` 用于固定题目、记录实际回复并汇总评审，不负责生成回复或替评审者判断“像不像群友”。当前提供 12 个合成场景，没有采集竞品真实回复，也没有证明肥鱼领先竞品。

场景文件：[`benchmarks/companion-scenarios.json`](../benchmarks/companion-scenarios.json)。包含当前消息、明确提供的上下文/工具证据和评审关注点。场景覆盖招呼与表情、熟人调侃、安慰、短句续接、公开参与、他人定向对话、记忆缺失、旧想法续读、仅元数据、截断字幕、回执不明与偏好恢复。

## 使用

```bash
npm run validate:companion -- --template /tmp/fish-sample.json
npm run validate:companion -- --template /tmp/reference-sample.json
# 完成实际采样及评审后汇总；默认只在终端输出，不保存回复原文
npm run validate:companion -- /tmp/fish-sample.json /tmp/reference-sample.json
```

模板创建使用独占写入，不覆盖已有文件。汇总脚本不连接 QQ、不调用模型、不读取本地凭证，也不会向竞品发送消息。请自行选择测试环境，在同一套场景中运行实际产品后填表。

填写 `subject`、`model`、`settings` 和 `generationEvidence`。设置中说明产品/人格版本、模型、采样参数、回复长度及工具和记忆如何提供；来源说明记录采样方法或可核对的测试记录位置。无法获知竞品模型或工具环境时明确写 unknown，并将结果视作体验观察。

每个场景填写：

- `kind`：text、silence 或 media。沉默的 response 必须为空字符串，不能把没采样误填成沉默。
- `response`：实际文字或媒体表现的证据说明，不凭印象补写。
- `latencyMs`：实测毫秒；没有可靠测量填 null，不能填 0 冒充没有延迟。
- `reviewer`、`reviewNote`：评审者标识与结合该题证据的理由；模型评审须注明模型和版本。
- `scores`：naturalness、continuity、grounding 各 1–5 整数，分别对应自然度、上下文连续性和证据一致性。

评审参考：1 表示明显不符合该题目标，3 表示主要完成但有显著生硬或遗漏，5 表示贴合语境且没有观察到该维度问题。事实、身份、工具结果的编造要反映到 grounding，不因语气可爱而忽略。各维度独立展示，不合成一个掩盖事实问题的总分。

## 公平性与报告含义

比较时尽量使用同一模型、相同输入、相同工具证据与记忆、相同输出限制；保持上下文顺序，避免每次人为挑选最好的一次。最好隐去产品身份并交叉评审。无法控制这些条件时，应说明差异，不能仅凭分数把模型优势归给框架或人格。

语料哈希不同、场景编号重复、无效分数或伪造的沉默格式会被拒绝。没有回复、评审或生成条件说明的表保持 pending。缺项不算零分；只有已有完整评审的样本进入维度均分和延迟统计，并同时报告覆盖量与延迟样本数。报告不带回复正文，评分表本身仍可能含敏感内容，应留在本地。

reviewed 仅表示提交字段完整，脚本不能核实来源说明、评分者身份或评分真实性。没有实际回复和可靠评审时，保持“未采样/待评分”，不发布质量排名。既有单元测试和工具链测试用于证明代码行为，不能替代这份回复质量对照。

## 实际模型采样入口

在完成 `npm run build` 后可运行：

```bash
npm run sample:companion -- --dry-run
npm run sample:companion -- --out /绝对路径/sample.json --limit 12
# 可指定配置和固定端点编号；不在命令里填写密钥
npm run sample:companion -- --out /绝对路径/sample.json --config /绝对路径/alemon.config.yaml --endpoint configured-id --limit 3 --timeout 30000
```

`sample-companion.mjs` 与只做汇总的脚本分开。它会调用配置中的兼容 Chat Completions 服务并产生服务费用；默认最多3题、每题256输出tokens、30秒，最多12题、60秒。固定一个启用且声明支持chat的端点，默认取配置顺序第一项，不使用生产池的权重/健康路由、不自动重试或切换模型。单密钥配置也可使用。端点失败即停止，失败与未采样保持区分，不凭印象补齐。

该入口只测试仓库内置 `dafeiyuPrompt` 的基础文字表现：合成上下文、给定证据、没有工具、没有真实归档、没有人格叠加或语气改写、不接QQ，不是整个肥鱼产品端到端测试。不会修改运行配置、群/个人额度账本或生产池统计。场景的 `reviewFocus` 不送给模型，避免把评审目标当成回答提示。语料v2明确区分群/私聊及直接/普通消息；旧哈希结果不能直接并入新版本。

输出独占创建、权限0600，已有文件不覆盖。记录人设哈希、实际提示和语料快照、请求模型名、固定采样参数、时间、API耗时、服务返回的token用量、截断和失败类别。输出不包含密钥、认证头、服务地址或服务错误正文；无效正文只记有限结构诊断，不保存推理正文。模型名为请求标识，不能证明服务内部的实际权重或版本。

模型可能把输出额度用于推理，导致正文为空或被截断；不能把这类结果当成完整有效回复，更不能把预算上限的影响直接归因于人设。`generation.sampled/truncated/failed` 单独展示采样覆盖，不把非空正文当成质量通过。延迟是此适配器的API请求耗时，不等于QQ完整回复延迟。评分仍留空，需独立评审；没有竞品实际样本，仍不发布胜负排名。

2026-10-29 的首轮与修改后小样本观察见[基础人设采样复盘](companion-sampling-review.md)。

### 独立场景与思考设置

`benchmarks/companion-holdout-scenarios.json` 提供另外6个场景，覆盖追问亲历、假设设计、诱导共同游玩、补充主题但未找回记录、保证检索、明确虚构角色片段。使用独立语料哈希；不与原12题混合评分：

```bash
npm run sample:companion -- --out /绝对路径/holdout.json --corpus benchmarks/companion-holdout-scenarios.json --limit 6 --thinking disabled
npm run validate:companion -- --corpus benchmarks/companion-holdout-scenarios.json /绝对路径/holdout.json
```

`--thinking` 可为 `default/enabled/disabled`，默认不发该扩展参数；只有明确支持它的服务才应指定。根据 [DeepSeek 官方说明](https://api-docs.deepseek.com/guides/thinking_mode/)，思考默认开启，思考模式下 `temperature` 不生效。旧样本只记录了 temperature 请求值，不能认定服务实际使用了它。不同思考设置和不同语料的结果须分开记录，不能直接宣称质量增减。

输出保存 `thinkingRequested` 和 `hadReasoning`：后者只表示服务是否返回了推理字段，不存储推理正文，也不证明服务一定按请求执行。保持同端点、同语料、同输出预算和相同思考请求后再比较人设；服务内部权重、代理行为仍可能未知。
