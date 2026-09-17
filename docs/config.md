# 配置指南

所有运行配置位于本机 `alemon.config.yaml`。该文件包含 QQ 和 Redis 凭证，必须保持在版本控制之外。

## 最小配置

```yaml
db:
  redis:
    host: 127.0.0.1
    port: 6379
    password: ''
    db: 0

qq-bot:
  app_id: '<QQ_APP_ID>'
  secret: '<QQ_APP_SECRET>'

master_key:
  '<OWNER_ID>': true

alemonjs-agent-link:
  model: deepseek-v4-flash
```

模型凭证也统一从此文件读取。在 `alemonjs-agent-link` 下设置 `apiKey`，可选设置 `baseUrl`；`model` 同样在此处配置。修改后必须重启服务：

```yaml
alemonjs-agent-link:
  apiKey: '<MODEL_API_KEY>'
  baseUrl: 'https://api.example.com/v1' # 可选
  model: deepseek-v4-flash
```

`alemon.config.yaml` 已被 Git 忽略。应仅允许运行账户读取，并禁止复制到日志、镜像或公开位置。`/agentbind`、`/agentmodel` 与 `/agentunbind` 不会修改该文件。

## AgentLink 参数

`runtimeMode` 默认为 `auto`，支持三个值：

- `auto`：优先沙箱；本地启动失败且已有模型凭证时降级纯聊天。
- `sandbox`：严格要求沙箱，失败时拒绝服务。
- `chat-only`：直接使用纯聊天，不安装 Python 或启动本地 Worker。

纯聊天请求使用 `baseUrl/chat/completions`，需要兼容 Chat Completions 的 HTTPS 服务；不跟随重定向。当前整段接收回答后发送，不保存多轮模型会话，但保留调用方提供的近期群聊上下文、超时取消、输入输出关键词过滤。恢复沙箱需修复环境并重启服务。纯聊天模式无法清除此前的沙箱磁盘数据；清理操作会报告失败，而不会假报成功。

未列出的参数应保留默认值。所有时长均为毫秒，除非名称以 `Seconds` 或 `Days` 结尾。

| 参数                        |                                                                                               默认值 | 说明                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------: | ------------------------------------------------------------------------------------------------- |
| `pythonExecutable`          | macOS/Linux：`.data/agent-link/venv/bin/python`；Windows：`.data/agent-link/venv/Scripts/python.exe` | DSH Python 环境；不存在时会自动创建。Windows 原生仍会被 Bridge 拒绝，应改在 WSL2 内运行完整服务。 |
| `bridgePort`                |                                                                                              `18080` | 本机 Bridge 端口，仅监听 `127.0.0.1`。                                                            |
| `workspaceRoot`             |                                                                        `.data/agent-link/workspaces` | 隔离 Worker 数据根目录。                                                                          |
| `dshHomeRoot`               |                                                                         `.data/agent-link/dsh-homes` | DSH 隔离 home 根目录。                                                                            |
| `profile`                   |                                                                                                `sdk` | DSH profile；生产环境不要绕过 chat-only patch。                                                   |
| `provider`                  |                                                                                  `deepseek-official` | 模型服务提供方标识。                                                                              |
| `model`                     |                                                                                  `deepseek-v4-flash` | 默认模型；主人可通过 `/agentmodel` 覆盖。                                                         |
| `defaultSystemPrompt`       |                                                                                       友好可靠的助手 | 每轮默认系统提示。                                                                                |
| `maxMessageLength`          |                                                                                               `1000` | 单条 QQ 回复的最大字符数。                                                                        |
| `streamFlushIntervalMs`     |                                                                                                `500` | 流式输出的刷新间隔。                                                                              |
| `requestTimeoutMs`          |                                                                                             `120000` | 单轮请求总超时。                                                                                  |
| `startupTimeoutMs`          |                                                                                              `30000` | Bridge 启动健康检查超时。                                                                         |
| `maxQueuedPerGroup`         |                                                                                                  `3` | 单群最多等待中的请求数。                                                                          |
| `maxConcurrentRequests`     |                                                                                                  `8` | 本机同时执行的 Agent 请求上限。                                                                   |
| `maxActiveWorkers`          |                                                                                                 `16` | 本机保留的隔离 Worker 上限。                                                                      |
| `maxCallsPerUserPerMinute`  |                                                                                                  `6` | 每个用户在同一群中的每分钟限额。                                                                  |
| `maxRequestBytes`           |                                                                                            `1048576` | Bridge 接受的请求体上限。                                                                         |
| `retentionDays`             |                                                                                                 `30` | 群 Agent 数据保留期；当前固定为 30。                                                              |
| `recentChatMaxMessages`     |                                                                                                 `20` | 近期普通消息条数；`0` 关闭。                                                                      |
| `recentChatWindowSeconds`   |                                                                                                `900` | 近期普通消息的保留窗口；`0` 关闭。                                                                |
| `recentChatMaxChars`        |                                                                                               `6000` | 读取近期消息时的字符上限；`0` 关闭。                                                              |
| `recentChatSummaryMaxChars` |                                                                                               `1600` | 提供给模型的压缩摘要上限；`0` 关闭。                                                              |
| `inputBlockedKeywords`      |                                                                                                 `[]` | 命中时拒绝请求的关键词列表。                                                                      |
| `outputBlockedKeywords`     |                                                                                                 `[]` | 命中时阻止发送的关键词列表；启用后回复会完成审核再发送。                                          |

## Redis

Redis 是必需依赖，负责请求去重、限流、群会话代际和近期上下文。Redis 不可用时，AgentLink 会拒绝新请求，避免会话状态不一致。

本地开发可启动仓库提供的 Redis：

```bash
docker compose up -d redis
docker compose ps
```

生产 Redis 应启用认证、持久化和备份。不要将 Redis 暴露到公网。
