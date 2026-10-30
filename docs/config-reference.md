# 配置字段参考

`alemon.config.yaml` 的全部字段字典。字段来自代码里的校验与默认值实现：

| 来源                                                | 覆盖内容                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/dsh/config.ts`                                 | `alemonjs-agent-link` 主字段、超时/并发/长度/路径、`budget`、`replyGate` |
| `src/social/group-policy.ts`                        | `groupChat` 与按群覆盖                                                   |
| `src/agent/modules.ts`、`src/modules/*`             | `modules` 与各模块 `settings`                                            |
| `src/media/config.ts`、`src/media/speech-config.ts` | `media` 与语音引擎                                                       |
| `src/onebot/config.ts`                              | `onebot` 连接                                                            |
| `runtime/paths.mjs`、`runtime/startup.mjs`          | 配置文件位置、CLI 参数、环境变量                                         |

场景说明与最小示例见 [配置指南](config.md)，额度规则见 [额度与预算](budget.md)，媒体见 [图片与语音](media.md)，模块机制见 [模块](modules.md)，OneBot 见 [OneBot 接入](onebot.md)。

**不认识的字段不会报错，但也不会生效**；已知字段取值越界、类型不符或安全策略不满足时，读取该段配置的代码会抛错（`DSH 配置 … 无效`、`groupChat 配置无效` 等），对应功能拒绝工作而不是带上错误值运行。

## 1. 文件位置与优先级

插件模式使用 AlemonJS 宿主加载的配置文件。以下自动选择、生成配置与记忆路径规则仅适用于仓库独立启动器。

独立启动器按以下顺序确定配置文件（`runtime/paths.mjs`）：

1. `--config <路径>` 或环境变量 `CFG_PATH`；
2. 当前目录的 `alemon.config.yaml`，或当前目录存在 `.data/agent-link`，或加了 `--portable`；
3. `<home>/active-profile.json` 记住的上一次成功启动路径；
4. `<home>/alemon.config.yaml`，不存在则自动生成最小配置。

`<home>` 依次取：`AGENT_LINK_HOME` → Windows `%APPDATA%/AgentLink` → macOS `~/Library/Application Support/AgentLink` → `XDG_CONFIG_HOME/agent-link` 或 `~/.config/agent-link`。

数据目录依次取：`AGENT_LINK_DATA_DIR` → 配置在 `<home>` 时用 `<home>/data` → 其他位置用 `<配置所在目录>/.data/agent-link`。

相对路径（`workspaceRoot`、`dshHomeRoot`、`pythonExecutable`、`media.stickerRoot`、`modules.directory`）一律以**配置文件所在目录**为基准解析。改数据目录只切换路径，不搬迁旧数据。

## 2. 顶层分区

| 分区                           | 归属       | 作用                                                   |
| ------------------------------ | ---------- | ------------------------------------------------------ |
| `alemonjs-agent-link`          | 本插件     | 模型、额度、群聊策略、模块、媒体等全部业务配置         |
| `qq-bot`                       | 框架适配器 | QQ 官方机器人凭证与 Markdown 行为                      |
| `onebot`                       | 本插件     | OneBot（账号协议）连接参数，`transport: onebot` 时使用 |
| `db.redis`                     | 框架       | Redis 连接；存在时默认启用 Redis 状态后端与额度账本    |
| `master_id` / `master_key`     | 框架       | 主人身份（平台 ID 或用户指纹）                         |
| `bot_id` / `bot_key`           | 框架       | 机器人自身身份，用于避免自问自答                       |
| `apps`                         | 框架       | 子应用开关                                             |
| `disabled_*`、`processor.*` 等 | 框架       | 事件过滤与处理器节奏                                   |

## 3. 框架层字段

### 3.1 `qq-bot`

| 字段              | 类型    | 默认           | 说明                                                                |
| ----------------- | ------- | -------------- | ------------------------------------------------------------------- |
| `app_id`          | string  | 无             | QQ 开放平台机器人 AppID；与 `secret` 同时填写才会启动官方机器人连接 |
| `secret`          | string  | 无             | AppSecret。留空时启动器显示终端二维码，扫码后由适配器写入           |
| `bots`            | map     | 无             | 多机器人模式：`bots.<app_id>.secret`，键必须等于该机器人的 `app_id` |
| `default_bot`     | string  | 单机器人时自动 | 多机器人时必须指定，且必须是已配置的 `app_id`                       |
| `markdownToText`  | boolean | `false`        | 强制把 Markdown 转纯文本发送（气泡退化为文字，不推荐）              |
| `hideUnsupported` | number  | `0`            | 客户端不支持的内容降级等级 0–4；本插件的按钮/气泡在 0 时效果最好    |

### 3.2 `onebot`

仅当 `alemonjs-agent-link.transport: onebot` 时读取。

| 字段              | 类型   | 默认      | 说明                                                                      |
| ----------------- | ------ | --------- | ------------------------------------------------------------------------- |
| `url`             | string | 无        | 反向 WebSocket 地址，必须是 `ws://本地` 或 `wss://`；不能带凭证、查询参数 |
| `selfId`          | string | 无        | 机器人 QQ 号（字符串，1–16 位数字）                                       |
| `accessToken`     | string | 无        | 连接令牌；远程地址必填，不能含换行                                        |
| `timeoutMs`       | number | `10000`   | 调用超时                                                                  |
| `maxPayloadBytes` | number | `8388608` | 单帧上限                                                                  |
| `recordDirectory` | string | 无        | 语音文件读取目录，必须是本机绝对路径                                      |
| `imageDirectory`  | string | 无        | 图片文件读取目录，必须是本机绝对路径                                      |

### 3.3 `db.redis`

配了这段，未显式声明 `stateBackend` 时状态库与额度账本默认走 Redis；`budget.enabled: true` 也需要它。

| 字段                | 类型   | 默认        | 说明                 |
| ------------------- | ------ | ----------- | -------------------- |
| `db.redis.host`     | string | `127.0.0.1` | Redis 主机           |
| `db.redis.port`     | number | `6379`      | 端口                 |
| `db.redis.password` | string | 空          | 密码；为空表示无密码 |
| `db.redis.db`       | number | `0`         | 库编号               |

### 3.4 身份与过滤

| 字段                                     | 类型                 | 说明                                                                                  |
| ---------------------------------------- | -------------------- | ------------------------------------------------------------------------------------- |
| `master_id`                              | string / 列表 / 映射 | 平台用户 ID 视为主人。`master_id` 与 `master_key` 任一命中即 `IsMaster`               |
| `master_key`                             | string / 列表 / 映射 | 按平台用户指纹认定主人；例：`master_key: { 1khucc5: true }`                           |
| `bot_id` / `bot_key`                     | 同上                 | 认定机器人自身，命中后事件被标记 `IsBot`，防止自问自答                                |
| `disabled_selects`                       | map                  | 按事件名关闭处理，如 `message.create: true`                                           |
| `disabled_text_regular`                  | string               | 命中该正则的消息直接丢弃                                                              |
| `disabled_user_id` / `disabled_user_key` | 同上                 | 屏蔽指定用户                                                                          |
| `processor.repeated_event_time`          | number               | 同一 `MessageId` 去重窗口，默认 60000ms                                               |
| `processor.repeated_user_time`           | number               | 同一用户连续事件窗口，默认 1000ms；设 `processor.rateLimit.sender` 可放开对消息的限制 |
| `processor.rateLimit.sender`             | object               | 按发送者的频率限制；配置后框架不再用 `repeated_user_time` 过滤消息，改由该规则判定    |

## 4. `alemonjs-agent-link` 主字段

### 4.1 模型与运行模式

| 字段           | 类型   | 默认                | 范围/取值                           | 说明                                                                                                              |
| -------------- | ------ | ------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `apiKey`       | string | 空                  | —                                   | 模型服务密钥。留空时纯聊天、沙箱都不启动，直到补填                                                                |
| `baseUrl`      | string | 官方地址            | 无凭证、无查询参数的 **HTTPS** 地址 | 兼容 OpenAI 的模型服务地址；`provider` 决定留空时的默认值                                                         |
| `model`        | string | `deepseek-v4-flash` | 非空                                | 默认模型 ID                                                                                                       |
| `provider`     | string | `deepseek-official` | 非空                                | 提供方标识；等于 `deepseek-official` 时 `baseUrl` 默认 `https://api.deepseek.com`，用于判断「同源才能复用主密钥」 |
| `profile`      | string | `sdk`               | 非空                                | 传给 DSH 沙箱的配置档名（`DSH_PROFILE`）                                                                          |
| `transport`    | string | `qq-bot`            | `qq-bot` \| `onebot`                | 连接方式。**修改后需重启**，连接层不热切换                                                                        |
| `runtimeMode`  | string | `auto`              | `auto` \| `sandbox` \| `chat-only`  | `auto` 先纯聊天、后台准备沙箱；`sandbox` 强制沙箱，失败拒服务；`chat-only` 不装 Python、不启 Worker               |
| `stateBackend` | string | 见说明              | `local` \| `redis`                  | 状态库。未显式配置时，存在 `db.redis` 即 `redis`，否则 `local`                                                    |

### 4.1.1 模型端点池（`modelPool`）

不配置时沿用上面的单 Key；配置后，按端点的健康、权重和并发选择。个人/群绑定的 Key 仍优先于池。

最简写法是 `modelPool.keys: [sk-A, sk-B]`，每项可以是 Key 字符串或带 `key`/`api`/`model` 的对象；`key` 等同 `apiKey`，`api` 等同 `baseUrl`。`keys` 会自动展开成下面的 `endpoints`，不写的高级项使用默认值。

| 字段                        | 类型             | 默认                                        | 范围/取值                                         | 说明                                                       |
| --------------------------- | ---------------- | ------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| `enabled`                   | boolean          | `true`                                      | —                                                 | 写 `false` 关闭池，回退单 Key                              |
| `maxAttempts`               | number           | `3`                                         | 1–20                                              | 首次调用故障切换的尝试上限；得到结果后固定端点             |
| `retryBudgetMs`             | number           | `12000`                                     | 1000–300000                                       | 模型轮次总请求预算；首次失败切换共用同一预算               |
| `failureThreshold`          | number           | `2`                                         | 1–10                                              | 连续 5xx 达到几次后冷却                                    |
| `cooldownSeconds`           | number           | `60`                                        | 1–86400                                           | 429/5xx 的冷却基数；429 会指数退避                         |
| `retryStatuses`             | number[]         | `[401,402,403,404,405,429,500,502,503,504]` | 100–599，≤20 项                                   | 兼容旧配置；首次切换遵循固定安全规则，不能放宽参数错误重试 |
| `probeIntervalSeconds`      | number           | `60`                                        | 0–3600                                            | 异步健康探测间隔；0 关闭                                   |
| `probeTimeoutMs`            | number           | `5000`                                      | 1000–30000                                        | 单次 `/models` 探测超时                                    |
| `probeChat`                 | boolean          | `true`                                      | —                                                 | 启动时额外发一次极小 chat 探测计费/模型是否可用            |
| `capabilityProbe`           | boolean          | `false`                                     | —                                                 | 启动时真实探测 vision/tools 能力                           |
| `capabilityProbeTimeoutMs`  | number           | `60000`                                     | 5000–120000                                       | 能力探测超时；识图/工具调用可能较慢                        |
| `recoveryProbeSeconds`      | number           | `300`                                       | 0–86400                                           | 401/402/403 停用后多久重新探测；0 表示不自动恢复           |
| `balanceWindowSeconds`      | number           | `300`                                       | 0–86400                                           | 近期负载统计窗口；0 关闭                                   |
| `retryJitterMs`             | number           | `200`                                       | 0–5000                                            | 切换端点前的随机抖动上限                                   |
| `queueMaxWaitMs`            | number           | `0`                                         | 0–30000                                           | 主端点并发满时短暂等待，避免立刻用 fallback                |
| `balanceUrl`                | string \| object | 无                                          | 字符串或 `provider: URL` 映射；URL 必须含 `{key}` | `/额度轮转` 余额查询；映射按厂商选择，避免串用地址         |
| `balanceAlertYuan`          | number           | `5`                                         | 0–1000000                                         | 低于该余额时在 `/额度轮转` 提示补货                        |
| `keys`                      | array            | 无                                          | 1–20 个字符串或对象                               | 简写：自动生成 `key-1`… 的端点，复用主配置默认值           |
| `endpoints`                 | array            | 无                                          | 1–20 个                                           | 展开形式；与 `keys` 二选一                                 |
| `endpoints[].id`            | string           | 无                                          | `^[a-z][a-z0-9-]{0,39}$`，唯一                    | 日志和命令里使用的端点名，不含 Key                         |
| `endpoints[].provider`      | string           | 同主配置                                    | 非空                                              | 端点标签；沙箱只转发与主 `provider` 相同的端点             |
| `endpoints[].baseUrl`       | string           | 官方地址或主配置地址                        | 无凭证、无查询参数的 HTTPS                        | 端点 API 地址                                              |
| `endpoints[].apiKey`        | string           | 空                                          | 8–500 字，不能含换行                              | 直接写 Key                                                 |
| `endpoints[].apiKeyEnv`     | string           | 空                                          | 环境变量名                                        | 从环境变量读 Key；与 `apiKey` 二选一                       |
| `endpoints[].model`         | string           | 主配置 `model`                              | 非空                                              | 该端点使用的模型；请求体里的 `model` 会被改写              |
| `endpoints[].pricing`       | object           | 无                                          | `input`/`output`/`cached` 为非负数字              | 非官方端点开启额度时必填；人民币/百万 tokens               |
| `endpoints[].balanceUrl`    | string           | 按 provider 映射或池级默认                  | HTTPS，必须含 `{key}`                             | 单个端点覆盖；优先级最高                                   |
| `endpoints[].balanceStyle`  | string           | 无                                          | `newapi`                                          | New API 网关：读取 `/v1/dashboard/billing/usage`           |
| `endpoints[].fallback`      | boolean          | `false`                                     | —                                                 | 主端点全部不可用时才启用；沙箱仍可使用                     |
| `endpoints[].priority`      | number           | `0`                                         | 0–100                                             | 旧值忽略，优先级由数组顺序决定，仅用于相同负载时排序       |
| `endpoints[].account`       | string           | 无                                          | ≤80 字符                                          | 同一厂商账号共享 RPM/TPM 计数                              |
| `endpoints[].workspace`     | boolean          | `false`                                     | —                                                 | 标记为 agent_workspace 专用端点；应使用 DeepSeek 兼容协议  |
| `endpoints[].rpm`           | number           | 无                                          | 1–1000000                                         | 每分钟最多选多少次；按账号共享                             |
| `endpoints[].tpm`           | number           | 无                                          | 1–1000000000                                      | 每分钟 token 上限；按账号共享                              |
| `endpoints[].maxConcurrent` | number           | `2`                                         | 1–100                                             | 该端点同时在途请求上限                                     |
| `endpoints[].capabilities`  | string[]         | `[chat,tools,replyGate]`                    | `chat` \| `tools` \| `vision` \| `replyGate`      | 哪些请求可以使用该端点；视觉轮次需要显式 `vision`          |
| `endpoints[].enabled`       | boolean          | `true`                                      | —                                                 | 单独停用某个端点                                           |

### 4.2 开关与提示

| 字段               | 类型    | 默认   | 范围    | 说明                                                          |
| ------------------ | ------- | ------ | ------- | ------------------------------------------------------------- |
| `aiEnabled`        | boolean | `true` | —       | 总开关。`false` 时拒绝一切模型请求，命令仍可查询              |
| `aiDisabledReason` | string  | 空     | ≤500 字 | 关闭时回给用户的说明；空则用内置文案                          |
| `aiNoticeEpoch`    | string  | 空     | —       | 「AI 已关闭」提示的去重版本号；改这个值可让该提示重新推送一轮 |

### 4.3 人格

| 字段                                   | 类型   | 默认                         | 说明                                                                                                                 |
| -------------------------------------- | ------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `persona`                              | string | `dafeiyu`                    | `assistant`（阿柠檬） \| `dafeiyu`（大肥鱼） \| `xunqing`（百里寻晴）；未自定义 `defaultSystemPrompt` 时使用所选预设 |
| `defaultSystemPrompt`                  | string | `你是一个友好、可靠的助手。` | 未选中人格文件时的系统提示词；`persona: dafeiyu` 时默认换成人格提示词                                                |
| `modules.settings.persona.defaultId`   | string | 无                           | 默认人格文件编号（`^[a-z][a-z0-9-]{0,63}$`），被 `/人格 使用` 的选择覆盖                                             |
| `modules.settings.persona.commonRules` | string | 空                           | ≤4000 字，追加在所有会话的公共规则                                                                                   |

### 4.4 私聊

| 字段                       | 类型    | 默认    | 说明                                                                   |
| -------------------------- | ------- | ------- | ---------------------------------------------------------------------- |
| `privateChatAccess`        | string  | `all`   | `owner` 仅主人可私聊；`all` 任何人可私聊（仍受额度和个人目录隔离限制） |
| `privateAutoReply`         | boolean | `true`  | 私聊是否自动回复；关闭后仅显式指令响应                                 |
| `privateHistoryMaxTurns`   | number  | `10`    | 0–100，纯聊天保留的轮数；两次压缩之间最多增长到两倍                    |
| `privateHistoryTtlSeconds` | number  | `86400` | 1–2592000，历史过期时间                                                |
| `privateHistoryMaxChars`   | number  | `12000` | 1–100000，历史文本上限                                                 |

### 4.5 群唤醒

| 字段             | 类型     | 默认 | 说明                                                                               |
| ---------------- | -------- | ---- | ---------------------------------------------------------------------------------- |
| `groupWakeNames` | string[] | 见下 | 群里出现这些词即视为叫机器人。≤64 条，每条 ≤20 字，不能有前后空格、不能以 `/` 开头 |

默认值：`帮我`、`帮忙`、`帮一下`、`帮个忙`、`求助`、`求解`、`请教`、`肥鱼`、`大肥鱼`、`小肥鱼`、`肥鱼儿`、`肥鱼酱`、`鱼宝`、`鱼鱼`、`小鲸鱼`、`鲸鱼`、`deepseek`、`deep seek`、`deep-seek`、`深度求索`、`深求`、`dsh`、`ds harness`、`deepseek harness`、`agentlink`、`agent link`。

### 4.6 路径与端口

| 字段                   | 类型     | 默认                         | 说明                                       |
| ---------------------- | -------- | ---------------------------- | ------------------------------------------ |
| `workspaceRoot`        | string   | `<数据目录>/workspaces`      | Agent 工作区根目录；相对路径按配置目录解析 |
| `dshHomeRoot`          | string   | `<数据目录>/dsh-homes`       | 沙箱 HOME 根目录                           |
| `pythonExecutable`     | string   | `<数据目录>/venv/bin/python` | Python 解释器；含斜杠时按配置目录解析      |
| `pythonPackageSources` | string[] | `pypi.org`、清华镜像         | 1–20 个 HTTPS 索引地址，不允许带凭证       |
| `bridgePort`           | number   | `0`                          | 0 自动选端口；固定端口需 1024–65535        |

> `pythonExecutable` 未配置且改过 `dshHomeRoot` 时，解释器会跟着 `dshHomeRoot` 的父目录走，避免把 venv 装到旧位置。

### 4.7 超时与并发

| 字段                       | 类型   | 默认     | 范围        | 说明                   |
| -------------------------- | ------ | -------- | ----------- | ---------------------- |
| `requestTimeoutMs`         | number | `120000` | 1–300000    | 单次模型请求超时       |
| `startupTimeoutMs`         | number | `30000`  | 1–300000    | 沙箱启动等待上限       |
| `preparationTimeoutMs`     | number | `120000` | 1000–600000 | 沙箱准备上限           |
| `maxQueuedPerGroup`        | number | `3`      | 0–3         | 每会话排队请求上限     |
| `maxConcurrentRequests`    | number | `8`      | 1–100       | 全局并发请求上限       |
| `maxActiveWorkers`         | number | `16`     | 1–200       | 同时存活的 Worker 上限 |
| `maxCallsPerUserPerMinute` | number | `6`      | 1–60        | 单用户每分钟请求上限   |

### 4.8 输出长度与节奏

| 字段                    | 类型   | 默认   | 范围    | 说明                           |
| ----------------------- | ------ | ------ | ------- | ------------------------------ |
| `maxMessageLength`      | number | `1000` | 1–10000 | 单条回复字符上限，超出自动分条 |
| `streamFlushIntervalMs` | number | `500`  | 1–10000 | 流式回复最小发送间隔           |
| `bubbleDelayMs`         | number | `250`  | 0–5000  | 连续气泡之间的思考延迟         |

### 4.9 内容安全

| 字段                    | 类型     | 默认      | 说明                       |
| ----------------------- | -------- | --------- | -------------------------- |
| `inputBlockedKeywords`  | string[] | `[]`      | 命中即拒绝，不发给模型     |
| `outputBlockedKeywords` | string[] | `[]`      | 命中即拦截，不发出模型输出 |
| `maxRequestBytes`       | number   | `1048576` | 1–20MB，单次请求体上限     |

### 4.10 近期群聊参考

| 字段                        | 类型   | 默认   | 范围      | 说明                                       |
| --------------------------- | ------ | ------ | --------- | ------------------------------------------ |
| `perceptionMaxMessages`     | number | `40`   | 1–100     | 感知消息上限，包含单独保留的最近机器人回复 |
| `perceptionWindowSeconds`   | number | `1800` | 60–3600   | 感知保留窗口，独立于活跃度统计             |
| `perceptionMaxChars`        | number | `6000` | 400–12000 | 感知历史文本总字符预算，每条最多400字      |
| `recentChatMaxMessages`     | number | `20`   | 0–10000   | 采集最近多少条                             |
| `recentChatWindowSeconds`   | number | `900`  | 0–86400   | 采集时间窗                                 |
| `recentChatMaxChars`        | number | `6000` | 0–1000000 | 采集文本上限                               |
| `recentChatSummaryMaxChars` | number | `1600` | 0–1000000 | 注入提示词时的摘要上限                     |

### 4.11 保留期

| 字段            | 类型   | 默认 | 范围          | 说明                                                     |
| --------------- | ------ | ---- | ------------- | -------------------------------------------------------- |
| `retentionDays` | number | `30` | **只能是 30** | 聊天记录、记忆、心情、平台记录的保留天数，其他值直接报错 |

## 5. `budget`（额度与预算）

| 字段                       | 类型    | 默认    | 范围    | 说明                                                                                  |
| -------------------------- | ------- | ------- | ------- | ------------------------------------------------------------------------------------- |
| `enabled`                  | boolean | `false` | —       | 打开后按天计费并限制请求，需要 Redis                                                  |
| `groupDailyYuan`           | number  | 无      | 0–10000 | 旧版群共享额度，仅为兼容保留，当前不影响判断                                          |
| `privateDailyYuan`         | number  | 无      | 0–10000 | 旧版私聊额度；`personalDailyYuan` 未配置时作为回退值                                  |
| `personalDailyYuan`        | number  | `1`     | 0–10000 | 个人免费额度（跨群与私聊共享）；取值顺序 `personalDailyYuan` → `privateDailyYuan` → 1 |
| `replyGateDailyYuan`       | number  | `1`     | 0–10000 | 群感知判断（是否接话）的每日预算                                                      |
| `replyGateGlobalDailyYuan` | number  | 无      | 0–10000 | 所有群感知判断的全局日预算，防止多群叠加                                              |
| `globalDailyYuan`          | number  | `0`     | 0–10000 | 全局每日总额；**0 = 不限**，只有 > 0 才拦截                                           |
| `maxOutputTokens`          | number  | 无      | 1–8192  | 单次输出 token 上限                                                                   |

额度不足时直接回复绑定密钥的步骤，按钮与文案逐条对应（`/我的钥匙`、`/我的钥匙 私聊 添加`、`/额度`）。

## 6. `replyGate`（接话判断用的小模型）

| 字段      | 类型   | 默认                                    | 说明                                                       |
| --------- | ------ | --------------------------------------- | ---------------------------------------------------------- |
| `model`   | string | 同源时 `deepseek-flash`，官方域固定该值 | 判断「是不是在喊它」与「是不是接着它的上下文」的模型       |
| `baseUrl` | string | 主模型地址                              | 必须是无凭证、无查询参数的 HTTPS 地址                      |
| `apiKey`  | string | 同源时复用主密钥                        | 跨源时必须单独提供；留空且跨源会导致判断直接放弃（不接话） |

## 7. `groupChat`（群聊参与策略）

按群覆盖：`groupChat.overrides.<channelId>` 支持表中任意字段。

| 字段                  | 类型             | 默认            | 范围                  | 说明                                                                                 |
| --------------------- | ---------------- | --------------- | --------------------- | ------------------------------------------------------------------------------------ |
| `activity`            | string           | `active`        | quiet/balanced/active | 活跃度预设；显式数字字段优先于预设                                                   |
| `enabled`             | boolean          | `true`          | —                     | 群聊自主参与总开关                                                                   |
| `replyGateEnabled`    | boolean          | `true`          | —                     | 是否调用感知模型判断是不是在喊它、是不是接着它的上下文                               |
| `boundKeyElevation`   | boolean          | `true`          | —                     | 群里绑定自带 Key 时是否拉满参与强度；`false` 保持普通策略                            |
| `boundKeyTools`       | boolean          | `true`          | —                     | 自带 Key 的群是否自动开放网页与文件工具；`false` 只保留参与度提权                    |
| `boundKey`            | boolean          | 运行时注入      | —                     | 由运行时按「本群是否绑定 Key」注入，**不是**人工配置项；手写只影响该群是否走提权分支 |
| `batchWindowMs`       | number           | `1200`          | 0–10000               | 合并窗口，等同一批消息说完                                                           |
| `maxBatchWaitMs`      | number           | `4000`          | 1–30000               | 合并最长等待，必须 ≥ `batchWindowMs`                                                 |
| `maxBatchMessages`    | number           | `24`            | 1–100                 | 单批最多消息数                                                                       |
| `maxBatchChars`       | number           | `12000`         | 200–50000             | 单批最多字符数                                                                       |
| `interjectChance`     | number           | `0.45`          | 0–1                   | 主动插话概率                                                                         |
| `cooldownSeconds`     | number           | `30`            | 0–86400               | 两次自主发言的最小间隔                                                               |
| `maxPerHour`          | number           | `16`            | 0–100                 | 每小时自主发言上限                                                                   |
| `quietHours`          | [number, number] | `[1, 8]`        | 0–23                  | 静默时段（可跨零点）                                                                 |
| `timezone`            | string           | `Asia/Shanghai` | IANA 时区             | 静默时段与统计所用时区                                                               |
| `minRecentMessages`   | number           | `2`             | 1–100                 | 至少有多少条近期消息才考虑接话                                                       |
| `activeWindowSeconds` | number           | `300`           | 1–3600                | 判定「群还活跃」的时间窗                                                             |
| `minRelevance`        | number           | `0.15`          | 0–1                   | 话题相关度阈值                                                                       |
| `interests`           | string[]         | 见下            | ≤100 条，每条 ≤40 字  | 兴趣词表，用于话题相关度打分                                                         |
| `engagedSeconds`      | number           | `600`           | 0–1800                | 被点到后保持「对话中」的时长                                                         |
| `burstMax`            | number           | `10`            | 1–100                 | 连发窗口内最多条数                                                                   |
| `burstWindowSeconds`  | number           | `120`           | 1–3600                | 连发统计窗口                                                                         |

`quiet` 预设：插话 0.08、冷却 180 秒、每小时 4 次、近期 5 条、相关度 0.35、参与期 120 秒、突发 6 次。`balanced` 预设为旧默认（0.25 / 60 秒 / 10 次 / 3 条 / 0.2 / 300 秒 / 8 次）。显式写出的数字字段优先于预设。

`interests` 默认：`吃饭`、`美食`、`游戏`、`动漫`、`猫`、`鲸鱼`、`睡觉`、`天气`、`奶茶`、`表情包`。

`overrides` 的键是群 `ChannelId`（≤300 字），值是上表的任意子集；覆盖值同样要过校验，非法时整段 `groupChat` 报错。

## 8. `modules`（模块）

| 字段                   | 类型     | 默认                         | 范围                                  | 说明                   |
| ---------------------- | -------- | ---------------------------- | ------------------------------------- | ---------------------- |
| `directory`            | string   | `<workspaceRoot>/../modules` | 非空                                  | 本地模块目录           |
| `disabled`             | string[] | `[]`                         | 模块 ID 规则 `^[a-z][a-z0-9-]{0,63}$` | 停用列表               |
| `maxToolRounds`        | number   | `8`                          | 1–16                                  | 单轮最多工具调用次数   |
| `maxToolContinuations` | number   | `2`                          | 0–4                                   | 工具结果后的续写次数   |
| `settings`             | map      | `{}`                         | 键为模块 ID                           | 各模块自己的设置，见下 |

内置模块 ID：`bili`、`chat-history`、`expose`、`files`、`memory`、`mood`、`persona`、`platform`、`group-admin`、`proactive`、`qa`、`qzone`、`stickers`、`voice`。

### 8.1 `modules.settings.bili`

| 字段                     | 类型    | 默认    | 范围                     | 说明                                                                                                        |
| ------------------------ | ------- | ------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `enabled`                | boolean | `true`  | —                        | 打开 B 站能力                                                                                               |
| `cookie`                 | string  | 空      | ≤4096 字，不能含换行     | 账号 Cookie，等同凭证，不要外泄                                                                             |
| `timeoutMs`              | number  | `20000` | 1000–60000               | 请求超时                                                                                                    |
| `allowComments`          | boolean | `true`  | —                        | 允许评论工具；主人本轮明确要求时才可调用                                                                    |
| `allowProactiveBrowse`   | boolean | `true`  | —                        | 允许主动搭话时自行浏览                                                                                      |
| `dailyBrowse`            | boolean | `false` | —                        | 已订阅主人会话每日独立只读浏览一次，遵守安静时段与暂停                                                      |
| `dailyBrowseMaxReads`    | number  | `2`     | 1–3                      | 每次独立阅读最多尝试读取的候选数；普通主动搭话仍为 1                                                        |
| `visualRead`             | boolean | `false` | —                        | 可选下载有限大小 MP4，在 15%、50%、85% 位置取静帧交给 `media.vision`；需 PATH 中的 ffmpeg，产生视觉服务费用 |
| `dailyBrowseWindow`      | array   | 未配置  | 两个不同的 0–23 整点     | 每日阅读窗口，例如 `[18,22]`；`[22,2]` 跨午夜，沿用主动搭话时区                                             |
| `dailyBrowseTopics`      | array   | `[]`    | 最多 10 个，每个 1–40 字 | 独立阅读优先参考的选题主题                                                                                  |
| `dailyBrowseExclude`     | array   | `[]`    | 最多 10 个，每个 1–40 字 | 主动搜索标题或简介中的避雷关键词，普通手动搜索不受影响                                                      |
| `dryRun`                 | boolean | `false` | —                        | 真实发布；设为 true 时只生成预览                                                                            |
| `maxCommentsPerDay`      | number  | `5`     | 1–100                    | 每日评论上限                                                                                                |
| `commentCooldownSeconds` | number  | `60`    | 0–86400                  | 评论冷却                                                                                                    |

### 8.2 `modules.settings.memory`

| 字段            | 类型    | 默认   | 范围  | 说明               |
| --------------- | ------- | ------ | ----- | ------------------ |
| `automatic`     | boolean | `true` | —     | 是否自动整理记忆   |
| `intervalHours` | number  | `12`   | 1–168 | 整理间隔           |
| `recallLimit`   | number  | `8`    | 1–20  | 每次注入的记忆条数 |

`memory.embedding` 可选，字段为 `baseUrl`（HTTPS）、`apiKey`、`model`、`weight`（0–1，默认 `0.55`）、`maxItems`（100–2000，默认 `200`）、`timeoutMs`（1000–30000，默认 `8000`）。不配置时只用 BM25；配置后使用 OpenAI-compatible `POST /embeddings` 做语义重排，失败自动回退。详见[长期记忆](memory.md)。

### 8.3 `modules.settings.mood`

| 字段            | 类型    | 默认   | 范围    | 说明                                 |
| --------------- | ------- | ------ | ------- | ------------------------------------ |
| `baseline`      | number  | `60`   | 20–80   | 心情基线                             |
| `halfLifeHours` | number  | `6`    | 0.1–168 | 回归基线的半衰期                     |
| `modelJudge`    | boolean | `true` | —       | 是否让模型参与心情判定（有额外费用） |

### 8.4 `modules.settings.proactive`

| 字段                                        | 类型             | 默认            | 范围                  | 说明                                                   |
| ------------------------------------------- | ---------------- | --------------- | --------------------- | ------------------------------------------------------ |
| `activity`                                  | string           | `active`        | quiet/balanced/active | 主动搭话节奏预设；显式数字字段优先                     |
| `enabled`                                   | boolean          | `true`          | —                     | 主动搭话总开关                                         |
| `autoSubscribe`                             | boolean          | `true`          | —                     | 主人首次私聊时自动订阅主动搭话；说“别主动找我”仍会关闭 |
| `idleMinutes`                               | number           | `20`            | 1–1440                | 空闲多久才考虑搭话                                     |
| `minIntervalMinutes` / `maxIntervalMinutes` | number           | `30` / `90`     | 1–1440 / 1–2880       | 随机间隔区间，前者不得大于后者                         |
| `maxPerDay`                                 | number           | `8`             | 0–20                  | 每日搭话上限                                           |
| `nudge`                                     | boolean          | `true`          | —                     | 未回复时是否追问                                       |
| `nudgeMinMinutes` / `nudgeMaxMinutes`       | number           | `15` / `40`     | 1–1440 / 1–2880       | 追问间隔，必须前小后大                                 |
| `nudgeChance`                               | number           | `0.6`           | 0–1                   | 追问概率                                               |
| `maxNudgesPerDay`                           | number           | `6`             | 0–20                  | 每日追问上限                                           |
| `maxUnanswered`                             | number           | `3`             | 1–20                  | 连续未回复多少次后停止                                 |
| `quietHours`                                | [number, number] | `[23, 8]`       | 0–23                  | 免打扰时段                                             |
| `timezone`                                  | string           | `Asia/Shanghai` | IANA 时区             | 时段计算时区                                           |
| `maxChars`                                  | number           | `300`           | 40–1000               | 单条主动消息长度上限                                   |
| `ownKeyMax`                                 | boolean          | `true`          | —                     | 绑定个人 Key 的私聊是否自动拉满频率                    |

`quiet` 预设：空闲 90 分钟、间隔 180–360 分钟、每天 2 次、追问 1 次；`balanced` 为旧默认（40 分钟 / 60–180 / 4 次 / 2 次）。显式数字字段优先于预设。

> `flexible` 是运行时派生字段（由后台根据在线状态与额度算出），**不是**可配置项，写进配置不会生效。

### 8.5 `modules.settings.qzone`

| 字段                            | 类型    | 默认            | 范围                         | 说明                                   |
| ------------------------------- | ------- | --------------- | ---------------------------- | -------------------------------------- |
| `enabled`                       | boolean | `true`          | —                            | 打开 QQ 空间能力                       |
| `allowPost`                     | boolean | `true`          | —                            | 允许发说说；`dryRun: true` 时只预览    |
| `allowInteract`                 | boolean | `true`          | —                            | 允许点赞/评论；`dryRun: true` 时只预览 |
| `dryRun`                        | boolean | `false`         | —                            | 演练模式；设为 true 时只预览           |
| `maxPostsPerDay`                | number  | `5`             | 1–100                        | 每日发帖上限                           |
| `maxInteractionsPerDay`         | number  | `10`            | 1–100                        | 每日互动上限                           |
| `cooldownSeconds`               | number  | `60`            | 0–86400                      | 操作冷却                               |
| `visibility`                    | string  | `friends`       | `all` \| `friends` \| `self` | 可见范围                               |
| `diary.enabled`                 | boolean | `true`          | —                            | 自动空间日记；仍需有效的 botId/ownerId |
| `diary.botId` / `diary.ownerId` | string  | 空              | 1–16 位数字                  | 写日记的机器人与主人账号，开启时必填   |
| `diary.hour`                    | number  | `20`            | 0–23                         | 每天几点写                             |
| `diary.timezone`                | string  | `Asia/Shanghai` | IANA 时区                    | 写日记时区                             |

### 8.6 `modules.settings.stickers`（表情自动收集）

| 字段                | 类型     | 默认      | 范围                 | 说明                                                      |
| ------------------- | -------- | --------- | -------------------- | --------------------------------------------------------- |
| `autoCollect`       | boolean  | `true`    | —                    | 自动收集表情                                              |
| `autoPrivate`       | boolean  | `true`    | —                    | 所有用户私聊也收集；兼容旧键 `autoOwnerPrivate`，新键优先 |
| `autoGroups`        | string[] | `[]`      | ≤100，`平台:ID` 形式 | 允许收集的群；为空且 `autoAllGroups` 为 true 时表示全部群 |
| `autoAllGroups`     | boolean  | `true`    | —                    | 未配置 `autoGroups` 时收集所有群                          |
| `autoLabel`         | boolean  | `true`    | —                    | 自动生成名称/标签（有模型费用）                           |
| `autoMaxPerHour`    | number   | `60`      | 1–100                | 全局每小时收集上限                                        | 同一平台用户跨群聊和私聊固定最多 20 张/小时，按入队尝试计数。 |
| `autoDetect`        | boolean  | `true`    | —                    | 自动判定是否表情                                          |
| `autoMinConfidence` | number   | `0.6`     | 0–1                  | 判定置信度阈值                                            |
| `autoMaxBytes`      | number   | `2097152` | 1024–25MB            | 单个素材大小上限                                          |
| `autoMaxSide`       | number   | `1024`    | 64–2048              | 缩放后最长边                                              |
| `autoQQSync`        | boolean  | `true`    | —                    | 自动写入机器人号 QQ 收藏                                  |

### 8.7 `modules.settings.expression`（表达方式）

| 字段                  | 类型             | 默认     | 范围        | 说明                                                           |
| --------------------- | ---------------- | -------- | ----------- | -------------------------------------------------------------- |
| `automatic`           | boolean          | `true`   | —           | 自动决定语音/表情；未配置媒体时回退文字                        |
| `voiceChance`         | number           | `0.15`   | 0–1         | 符合情绪场景后的语音基础概率                                   |
| `stickerChance`       | number           | `0.35`   | 0–1         | `both` 模式下正文后补表情的概率                                |
| `stickerFallback`     | boolean          | `false`  | —           | `both` 模式下没有相关表情时是否随手发                          |
| `stickerIntentAlways` | boolean          | `true`   | —           | 明确意图（在不在/晚安等）优先尝试表情                          |
| `stickerMode`         | string           | `either` | either/both | either=表情优先，必要时补文字；both=正文后补一张               |
| `modelVoice`          | boolean          | `false`  | —           | 允许模型提出语音表达；仍受场景、时段与频次约束，会缓冲整段回复 |
| `socialPolish`        | boolean          | `true`   | —           | 群聊短回复疑似客服腔时，用便宜模型改写一次；失败回退原文       |
| `delayMs`             | [number, number] | `[0, 0]` | 0–3000      | 随机停顿区间，前值不得大于后值                                 |

### 8.8 `modules.settings.persona`

| 字段          | 类型   | 默认 | 说明                            |
| ------------- | ------ | ---- | ------------------------------- |
| `defaultId`   | string | 无   | 默认人格编号，必须是合法文件 ID |
| `commonRules` | string | 空   | ≤4000 字，所有会话共享的规则    |

### 8.9 `modules.settings.expose`

| 字段        | 类型     | 默认 | 说明                                                      |
| ----------- | -------- | ---- | --------------------------------------------------------- |
| `providers` | string[] | 全部 | 允许暴露发现的能力提供方白名单，≤100 条，去空格后精确匹配 |

### 8.10 `modules.settings['group-admin']`

| 字段        | 类型     | 默认   | 说明                                                         |
| ----------- | -------- | ------ | ------------------------------------------------------------ |
| `allGroups` | boolean  | `true` | 默认所有群可管理；设为 false 后只允许 `groups` 列出的群      |
| `groups`    | string[] | `[]`   | `allGroups: false` 时的群号白名单，≤1000 条，必须是纯数字 ID |

### 8.11 `modules.settings.stickers.panel`（本地面板）

| 字段      | 类型    | 默认        | 范围                 | 说明                                                       |
| --------- | ------- | ----------- | -------------------- | ---------------------------------------------------------- |
| `enabled` | boolean | `true`      | —                    | 是否启动仅回环的表情面板                                   |
| `host`    | string  | `127.0.0.1` | `127.0.0.1` \| `::1` | 不允许公网绑定                                             |
| `port`    | number  | `8787`      | 1–65535              | 本地面板端口                                               |
| `token`   | string  | 空          | 16–128 位，无空白    | 留空时首次启动自动写入数据目录的 `sticker-panel-token.txt` |

### 8.12 `modules.settings.qa`

| 字段             | 类型    | 默认   | 范围    | 说明                                                      |
| ---------------- | ------- | ------ | ------- | --------------------------------------------------------- |
| `autoRecord`     | boolean | `true` | —       | 记录问因/指令求助提问，并把未命中的已送达问答写入当前会话 |
| `recallLimit`    | number  | `3`    | 1–10    | 每次注入的匹配问答条数                                    |
| `matchThreshold` | number  | `3.5`  | 1–20    | 匹配门槛，越高越严格                                      |
| `maxEntries`     | number  | `200`  | 10–2000 | 每个会话自动学习条目的上限                                |

停用问答库使用 `modules.disabled: ['qa']`。内置问答分为“为什么”和“指令用法”两组，自动学习、会话隔离和清理规则见[问答库](qa.md)。

## 9. `media`（图片、语音、表情）

| 字段              | 类型     | 默认              | 范围                                    | 说明                                         |
| ----------------- | -------- | ----------------- | --------------------------------------- | -------------------------------------------- |
| `vision`          | object   | 无                | 见下                                    | 图片理解服务                                 |
| `asr`             | object   | 无                | 见下                                    | 语音转写服务，允许 `http://localhost`        |
| `tts`             | object   | 无                | 见下                                    | 语音合成服务，允许 `http://localhost`        |
| `imageGen`        | object   | 无                | 见下                                    | 生图服务，允许 `http://localhost`            |
| `speech`          | object   | 见 9.2            | —                                       | 语音引擎参数                                 |
| `allowedHosts`    | string[] | `[]`              | 精确域名，`[a-z0-9.-]`，不能以 `.` 开头 | 远程媒体下载白名单；空表示允许任意公网 HTTPS |
| `timeoutMs`       | number   | `60000`           | 1000–120000                             | 媒体请求超时                                 |
| `maxBytes`        | number   | `10485760`        | 1024–25MB                               | 单个附件上限                                 |
| `maxAttachments`  | number   | `3`               | 1–20                                    | 单条消息附件数上限                           |
| `ttsMaxChars`     | number   | `800`             | 1–4000                                  | 一次合成文本上限                             |
| `stickerRoot`     | string   | 数据目录/stickers | 非空                                    | 表情素材目录；默认会在首次使用时创建空清单   |
| `stickerMaxItems` | number   | `300`             | 1–2000                                  | 素材索引上限                                 |

### 9.1 媒体服务对象（`vision`/`asr`/`tts`/`imageGen`）

| 字段          | 类型    | 默认        | 说明                                                                                    |
| ------------- | ------- | ----------- | --------------------------------------------------------------------------------------- |
| `baseUrl`     | string  | 无          | 必填；HTTPS（`asr`/`tts`/`imageGen` 允许本机 `http://localhost`），不能带凭证或查询参数 |
| `apiKey`      | string  | 空          | 远程服务必填                                                                            |
| `model`       | string  | 无          | 必填，服务端模型名                                                                      |
| `voice`       | string  | 无          | 仅 `tts`：音色名                                                                        |
| `size`        | string  | `1024x1024` | 仅 `imageGen`：`120x120`–`9999x9999` 形式                                               |
| `stylePrompt` | string  | 空          | 仅 `imageGen`：≤2000 字风格提示                                                         |
| `ownerOnly`   | boolean | `false`     | 仅 `imageGen`：是否只允许主人使用                                                       |

### 9.2 `media.speech`（语音引擎）

| 字段             | 类型    | 默认                 | 说明                                                                                         |
| ---------------- | ------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `engine`         | string  | `auto`               | `auto` \| `system` \| `edge` \| `openai` \| `breeze` \| `cosyvoice` \| `gptsovits` \| `http` |
| `fallback`       | boolean | `true`               | 合成失败时是否回退文字                                                                       |
| `systemVoice`    | string  | 无                   | `system` 引擎的系统音色                                                                      |
| `edgeVoice`      | string  | `zh-CN-XiaoyiNeural` | `edge` 引擎音色                                                                              |
| `url`            | string  | 无                   | 自建服务地址（`cosyvoice`/`gptsovits`/`http`）或 Breeze API 根地址                           |
| `apiKey`         | string  | 无                   | 自建服务令牌；`breeze` 必填                                                                  |
| `speaker`        | string  | `中文女`             | 说话人                                                                                       |
| `sampleRate`     | number  | `22050`              | 采样率                                                                                       |
| `referenceAudio` | string  | 无                   | 参考音频路径                                                                                 |
| `referenceText`  | string  | 无                   | 参考音频文本                                                                                 |
| `language`       | string  | `zh`                 | 语言；`breeze` 作为 `language_code` 发送                                                     |
| `urlTemplate`    | string  | 无                   | `http` 引擎拼接模板                                                                          |
| `voiceId`        | string  | 无                   | `breeze` 的 voice_id（如 `voc_8yud7hz7c9q2`）                                                |
| `instruction`    | string  | 无                   | `breeze` 的表演指令，与文本同语言                                                            |
| `model`          | string  | 无                   | `breeze` 的 model_id，省略时由服务端自选                                                     |

**关于 `breeze` 引擎**：BreezeBlue（Breeze TTS）的接口是 ElevenLabs 形态，`POST /v1/text-to-speech/{voice_id}`，`xi-api-key` 或 Bearer 鉴权，返回二进制音频。配置示例：

```yaml
media:
  speech:
    engine: 'breeze'
    url: 'https://api.breeze.blue'
    apiKey: 'brz_...'
    voiceId: 'voc_8yud7hz7c9q2'
    language: 'zh'
    instruction: '清亮柔软、略带奶气的普通话少女音，语速适中，语尾轻轻上扬'
    fallback: true
```

计费按加权字符：CJK 每个字 2 单位、其他 1 单位，10 单位 = 1 credit；单次文本上限 1000 字符（默认），超过要缩短文本或分段。

**关于 `edge` 引擎**：需要先安装组件，私聊发送 `/语音引擎 安装`（在数据目录下创建 `speech-venv`，依赖 `python3` 与网络），装好后用 `/语音引擎 试听 你好` 验证。未安装 `edge-tts` 且没有配置 `media.tts` 时，`auto` 会落到 `system` 引擎（macOS `say`、Windows `System.Speech`、Linux `espeak-ng`），音色明显更机械。实测可用的中文音色：`zh-CN-XiaoxiaoNeural`（温暖，推荐）、`zh-CN-XiaoyiNeural`（活泼）、`zh-CN-liaoning-XiaobeiNeural`（东北话）、`zh-CN-shaanxi-XiaoniNeural`（陕西话）、`zh-TW-HsiaoChenNeural`、`zh-HK-HiuGaaiNeural`；`zh-CN-XiaohanNeural` 等旧音色已从微软接口下架，调用会报 `NoAudioReceived`，此时可继续用上一次有效的音色。

## 10. 环境变量

| 变量                           | 作用                                                          |
| ------------------------------ | ------------------------------------------------------------- |
| `CFG_PATH`                     | 配置文件路径，等价 `--config`                                 |
| `AGENT_LINK_HOME`              | 安装/配置主目录（`active-profile.json` 与默认数据目录的基准） |
| `AGENT_LINK_DATA_DIR`          | 覆盖数据目录                                                  |
| `AGENT_LINK_STATUS_PATH`       | 启动阶段状态文件；Worker 写、运行器读，用于启动进度展示       |
| `AGENT_LINK_PERSONAL_KEY_FILE` | 个人密钥加密存储文件，默认在数据目录下                        |
| `AGENT_LINK_TEST_PYTHON`       | 测试用 Python 路径（生产不需要）                              |
| `DSH_BWRAP_EXECUTABLE`         | 自定义 `bwrap` 路径，沙箱隔离使用                             |
| `LOG_LEVEL`                    | 框架日志级别                                                  |
| `APPDATA` / `XDG_CONFIG_HOME`  | Windows / Linux 下 `<home>` 的基准目录                        |

## 11. 仓库运行脚本

以下命令在本仓库根目录执行。安装为插件时使用宿主启动方式；本包不注册命令行。npm 脚本附加参数须放在 `--` 后，例如：

```bash
npm start -- --config /absolute/path/alemon.config.yaml
npm start -- --portable
npm run doctor -- --json
npm run init -- --config /absolute/path/alemon.config.yaml
```

| 命令              | 作用                                                     |
| ----------------- | -------------------------------------------------------- |
| `npm start`       | 启动（默认）；首次运行自动生成配置并显示路径             |
| `npm run init`    | 只生成最小配置，不启动                                   |
| `npm run doctor`  | 离线检查 Node 版本、SQLite、配置格式、必要字段与目录权限 |
| `--config <路径>` | 指定配置文件，等价 `CFG_PATH`                            |
| `--portable`      | 强制使用当前目录的配置与数据                             |
| `--json`          | `doctor` 输出结构化结果（不含密钥）                      |

## 12. 校验与生效方式

**生效方式**

- `alemonjs-agent-link` 大部分字段保存即生效：框架监听文件变化，下一次请求重新读取；模型、媒体、模块、额度、群策略都属于这一类。
- `transport` 与数据目录类字段（`workspaceRoot`、`dshHomeRoot`）需要重启或重新加载运行实例。
- 沙箱相关字段（`runtimeMode`、`pythonExecutable`、`profile`、`provider`、`apiKey`、`baseUrl`）改动后，旧沙箱实例会在下次使用时被替换；切换过程中正在执行的请求可能中断。

**校验方式**

- 主字段越界会抛 `DSH 配置 <字段> 无效：需要 <min>–<max> 范围内的整数`；
- `baseUrl` 必须是 HTTPS 且不含凭证、查询参数，否则抛 `需要不含凭证、查询参数的 HTTPS 基础地址`；
- `budget.*` 超过 0–10000 元、`maxOutputTokens` 超过 1–8192 会抛 `budget.<字段> …`；
- `groupChat`、`modules`、`media`、`onebot` 各自有独立错误文案，非法时对应功能不工作。

**容易踩的坑**

1. `retentionDays` 目前只接受 30，写别的值会直接报错。
2. `stateBackend` 不写时，有 `db.redis` 就自动用 Redis；想让额度账本走本地，必须显式写 `local`（但 `budget.enabled` 依赖 Redis）。
3. `maxQueuedPerGroup` 上限是 3，不是 10。
4. `bridgePort` 固定端口必须 ≥1024，0 才是自动分配。
5. `groupWakeNames` 不能有前后空格、不能以 `/` 开头，否则整段配置报错。
6. `replyGate.baseUrl` 与主模型不同源时必须单独给 `apiKey`，否则感知判断会被跳过（表现为群里不接话）。

---

[← 文档首页](README.md) · [项目主页](../README.md) · [命令速查](commands.md)
