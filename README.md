# AgentLink DSH

让 ALemonJS 通过 DeepSeek Harness（DSH）提供按群隔离的 Agent 对话。生产模式只开放 `chat-only`：不提供用户工作区、Shell、附件访问或任意网络访问。模型凭证只保留在本地 Bridge 进程，群 worker 只能经一次性令牌访问本地受限代理。

## 前置条件

- 首次启动会自动创建 `.data/agent-link/venv` 并安装 `deepseek-harness-sdk`。
- 生产目标仅为 macOS；启动会校验 `/usr/bin/sandbox-exec`、Python/DSH runtime、模型 HTTPS 地址和 Redis。任一前置检查失败时不接收 Agent 请求。
- `chat-only` 使用 DSH 官方 profile patch 显式禁用 Bash、文件、Web、子代理、工作流及工具目录；Bridge 启动时会 dump 并核验该 patch。不要通过 system prompt 或 `profile` 名称绕过该门槛。
- QQ 机器人适配器支持 ALemonJS 的 `mention.get` 能力。

## 配置

在 ALemonJS 配置中加入：

```yaml
alemonjs-agent-link:
  pythonExecutable: /opt/agent-link/.venv/bin/python
  bridgePort: 18080
  workspaceRoot: /srv/agent-link/workspaces
  dshHomeRoot: /srv/agent-link/dsh-homes
  profile: sdk
  provider: deepseek-official
  model: deepseek-v4-flash
  defaultSystemPrompt: 你是一个友好、可靠的助手。
  maxMessageLength: 1000
  streamFlushIntervalMs: 500
  requestTimeoutMs: 120000
  maxConcurrentRequests: 8
  maxActiveWorkers: 16
  recentChatMaxMessages: 20
  recentChatWindowSeconds: 900
  recentChatMaxChars: 6000
  recentChatSummaryMaxChars: 1600
```

所有 DSH 配置均有默认值；未配置时数据保存在 `.data/agent-link/`。模型凭证由机器人主人在 QQ 私聊中绑定，不写入配置文件、日志或群消息。

生产环境需要 Redis（执行 `docker compose up -d redis`）。连接参数使用 ALemonJS 的顶层 `db.redis` 配置，例如 `host`、`port`、`password`、`db`。Redis 保存请求去重、频控、群会话代际和短时上下文；Redis 不可用时，AgentLink 会拒绝新的 Agent 请求以避免会话不一致。

当前版本按**单个 Node 进程**部署：群内排队、取消和首次隔离迁移是进程内协调的。请勿使用多个进程或多个副本同时连接同一个 QQ 机器人和 Redis；多实例部署将在引入 Redis 分布式租约后才会支持。

为防止多群同时请求耗尽本机资源，默认最多执行 8 个 Agent 请求、保留 16 个隔离 Worker；达到请求上限时会快速拒绝新请求，Worker 达到上限时会优先回收最久未使用的空闲 Worker。配置输出关键词审查后，回复会先完整审核再发送，避免关键词跨流式分片泄漏。

日常开发使用 `yarn dev --login qq-bot`。生产常驻运行必须先构建，再使用 `yarn start --login qq-bot`；不要以带热重载的 `yarn dev` 作为生产进程。热重载可能在旧 QQ Gateway 会话尚未释放时创建第二个连接，从而触发服务端的 `4902: reset by resume`。

若 Node 进程意外退出而本机 Bridge 仍在运行，下一次生产启动会通过仅当前 macOS 用户可读的本地认证记录复用同一 Bridge。端口被未知进程占用时仍会拒绝连接，不会仅凭端口号信任该进程。

## 使用方式

在群聊中 @机器人并附上问题即可，例如：`@机器人 帮我整理今天的待办`。也可使用 `/chat 帮我整理今天的待办`。只有这两种方式会触发 Agent；普通群聊不会创建 DSH 对话回合。

会话按群共享并按 Redis 代际隔离：同一群成员共享上下文，不同群运行在不同 sandbox worker 中。升级到隔离运行时后，群第一次聊天会自动创建隔离会话；旧会话不会迁移。

普通群消息会在 Redis 中短时保留为近期上下文（默认最近 20 条、15 分钟、最多 6000 字符），供下一次 @机器人或 `/chat` 时参考；到期自动删除。发送前会做本地抽取压缩：去重、优先保留近期消息和问题/结论/待办/链接等高信息内容，默认最多向 DSH 提供 1600 字符，并明确标记为不可信引用文本。`/new` 会同时清除当前群的 DSH 会话和该短时上下文。该操作仅允许机器人主人；若适配器提供 `IsAdmin`，也允许群管理员。

直接发送 `/agenthelp` 可查看上述基本用法。机器人不会发送“收到”或进度播报；首条正式回复会 @ 并引用提问者，方便多人同时聊天时辨认归属。`/cancel` 会优先取消自己正在生成的回复；若没有正在生成的回复，则取消自己最后一条排队请求。

群聊中可用 `/agentcontext` 预览下一次会提供给 DSH 的压缩上下文；机器人主人或群管理员可使用 `/agentcontext clear` 单独清理该上下文，而不清除 DSH 正式会话。`/agentprivacy` 可查看数据处理和清理规则。

直接发送 `/agentstatus` 可查看 DSH 的自动安装与就绪状态。无需手动执行安装指令：首次启动会自动创建插件专用 Python 环境并安装 SDK；若状态显示失败，按提示检查 Python 3、网络连接和数据目录权限。

机器人主人可在私聊中发送 `/agentbind <API_KEY> [BASE_URL]` 绑定一套全群共用的模型凭证；例如 `/agentbind sk-xxx https://api.deepseek.com`。凭证存入 macOS Keychain，任何群成员均无法查看或覆盖。由于 API Key 会作为私聊文本经过 QQ，请在绑定成功后手动删除该条私聊消息。主人私聊发送 `/agentunbind` 可移除绑定。

主人私聊发送 `/agentmodels` 可从已绑定模型服务读取可用模型；`/agentmodel` 查看当前模型，`/agentmodel <模型ID>` 校验后切换全局模型并重启 Bridge 生效。

机器人主人可在群内使用 `/agentpolicy status` 查看当前策略、`/agentpolicy chat-only` 恢复默认仅对话策略。发送 `/agentpurge` 会展示影响范围；同一主人须在 60 秒内发送 `/agentpurge confirm` 才会彻底删除该群的 Agent 数据。没有 `workspace-files` 路由或策略；在 DSH 提供可验证的工具白名单机制前不会开放。群数据默认 30 天无活动后自动物理删除；启动时与之后每小时都会执行清理。

近期上下文在 Redis 到期后不再被业务读取；若 Redis 启用 AOF，底层持久化文件的压缩回收由 Redis 自身完成。Bridge 启动时还会清理超过保留期的孤儿群目录。

发布前请确认运行配置及 Keychain 凭证没有被提交，并轮换机器人应用密钥与模型 API Key。不要为此版本在 DSH 中启用工具。
