# 运维手册

## 平台支持与部署前检查

以下沙箱依赖仅针对工具执行。默认 `auto` 模式缺少依赖时可降级为纯聊天；Windows 原生也可以使用纯聊天。`/agentstatus` 显示降级状态，网页工具不可用，受限文件工具仍按模块及会话权限开放，终端始终禁止。模型地址与 API Key 仍为必需，Redis 可选；降级状态本身不表示模型连接已验证。

| 宿主环境 | 状态           | 运行方式                                                                                                               |
| -------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| macOS    | 支持原生运行   | 需要系统 `/usr/bin/sandbox-exec`。                                                                                     |
| Linux    | 支持原生运行   | 安装 Bubblewrap（`bwrap`），并允许 Worker 创建所需命名空间。                                                           |
| Windows  | 通过 WSL2 支持 | 在 WSL2 Linux 发行版中安装并运行**完整** Node、Python 与 AgentLink 服务；不要从 Windows Node 进程混合调用 WSL Python。 |

Windows Sandbox 不适合作为 Worker 后端：它是临时桌面 VM，关闭即丢失状态，并且不允许多实例，无法满足多个群常驻隔离 Worker 的模型。

- 运行宿主为 macOS 或 Linux：macOS 需存在 `/usr/bin/sandbox-exec`；Linux 需安装 Bubblewrap（`bwrap`）。如 `bwrap` 不在 `PATH` 中，可设置 `DSH_BWRAP_EXECUTABLE` 为其绝对路径。
- Linux 容器还必须允许 Bubblewrap 创建用户和挂载命名空间；受限容器通常需要在镜像中安装 `bubblewrap`，并允许非特权用户命名空间或提供可用的 setuid `bwrap`。
- 本地状态目录可写，或所选 Redis 可连接；QQ Bot 和主人账号已配置。
- `alemon.config.yaml` 仅对运行账户可读，且未提交。
- 已在 `alemon.config.yaml` 的 `alemonjs-agent-link` 下配置 `apiKey`。

后台增强准备时，AgentLink 会在所选数据目录创建 `venv` 并按仓库内锁定版本安装 DSH SDK；这一步需要网络和数据目录写入权限。升级 DSH 时必须同步更新 `python/requirements.txt`，并完成 sandbox 集成验证。

## 启动与停止

### 插件安装

在 AlemonJS 宿主项目目录安装：

```bash
npm install alemonjs-agent-link
```

由宿主加载 `alemonjs-agent-link` 包主入口，并在宿主配置中填写 `alemonjs-agent-link.apiKey`。平台连接、启动、停止与重启均由宿主管理。包不提供 `bin` 命令，不使用 `npx alemonjs-agent-link` 启动。

### 仓库独立运行

以下命令仅在本仓库根目录执行：

```bash
npm install
npm run build
npm start
```

开发调试使用 `npm run dev -- --login qq-bot`。独立启动后按 Ctrl+C 停止；交给进程管理器运行时，由进程管理器发送 SIGTERM 停止。

生产中只运行一个 Node 进程。热重载可能在旧 QQ Gateway 连接尚未释放时建立第二个连接，从而导致网关重置。

## 健康检查

仓库独立运行前可执行 `npm run doctor` 离线检查配置，指定配置使用 `npm run doctor -- --config /absolute/path/alemon.config.yaml`。检查不会验证外部服务连通性；插件安装应使用宿主的日志和运行状态排查。

在 QQ 中发送 `/agentstatus`：

- 所有用户可看到服务是否就绪。
- 机器人主人在私聊中可看到 Bridge、状态库、Sandbox、并发容量和模型凭证状态。

常见状态与动作：

| 现象                 | 优先检查                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------- |
| 服务准备中或启动失败 | Python 3、网络、`.data/agent-link/` 权限、Bridge 端口。                                      |
| 新请求被拒绝         | 状态库目录权限或 Redis 连通性，以及 `/agentstatus`。                                         |
| 请求超时             | 模型服务、网络、`requestTimeoutMs`，以及本机容量。                                           |
| 群内排队已满         | 当前群请求量；使用 `/cancel` 取消自己的等待请求。                                            |
| 无可用模型           | 主人私聊执行 `/agentmodels`，并检查 `alemon.config.yaml` 的 `apiKey`、`baseUrl` 与 `model`。 |

## 发布验证

默认测试不连接真实 Redis、模型或 OS sandbox。完成凭证配置后，在受控环境执行下列命令，验证 Redis 过渡状态恢复和真实 sandbox 前置检查：

```bash
AGENT_LINK_INTEGRATION=1 yarn test
```

这项验证会创建并删除一个随机的测试群状态；不会发送模型对话请求。

## 数据维护

- `/new`：管理员或主人清除当前群的正式会话和近期参考。
- `/agentcontext clear`：管理员或主人仅清除近期参考。
- `/agentpurge` 后跟 `/agentpurge confirm`：仅主人可彻底删除目标群数据；确认窗口为 60 秒。
- 无活动群数据默认保留 30 天。启动时与之后每小时会执行清理。
- 请求只有在至少一条 Agent 回复成功投递后才会确认去重；模型执行或投递失败会释放去重占位，以便平台重投或用户重试。占位时长会覆盖单群最大排队、执行和投递余量。

## 升级

1. 先停止生产进程。
2. 更新代码与依赖。
3. 执行 `yarn test`。
4. 执行 `yarn build` 后重新启动。
5. 在 QQ 私聊中运行 `/agentstatus` 验证 Bridge、状态库和 Sandbox。

不要通过删除 `.data/agent-link/` 解决常规故障；这会丢失本机 Bridge 与隔离会话数据。优先使用群级清理命令。

## 持久化聊天归档与查询

默认启用内置 `chat-history` 模块。归档位于 `dshHomeRoot` 同级目录的 `chat-history.sqlite`（默认 `.data/agent-link/chat-history.sqlite`），独立于本地状态库或 Redis，使用 Node.js 22 的内置 SQLite。备份时停止机器人并复制该文件。

从启用时开始记录平台实际投递的群聊、允许访问的私聊及成功发送的 Agent 回复；不补采旧消息，不导入日志。平台重复投递按会话和消息 ID 去重。主人验证码命令不归档；附件仅保留类型占位，不保存下载地址或原始媒体。消息时间是服务器接收时间。单条最多保存 8000 字符，截断会标记。

大肥鱼可使用 `search_chat_history` 按连续关键词、发言人 ID、时间范围查询，并用 `get_chat_context` 展开命中记录前后各最多 3 条消息。默认每页 10 条，最多 20 条；结果明确标记截断。时间参数使用包含时区的 ISO 格式。每次查询限定当前平台和当前会话，工具不接受目标群/用户参数。历史资料作为引用，不作为指令。

可以直接问：“昨天我们讨论了什么配置？”“查一下小明之前提到的部署问题”。按姓名搜索正文不一定命中，需要模型先查询记录找到发言人 ID 后再筛选。图片占位不能用于再次识图。

归档按每条消息时间保留 30 天，启动时及每小时清理，读取时也过滤过期记录；不以最近活动刷新旧消息的期限。`/new` 保留归档。`/清除聊天记录` 后在 60 秒内发送 `/清除聊天记录 confirm`，可删除当前会话归档；私聊本人可操作，群聊仅机器人主人可操作。该命令不清除模型上下文或长期记忆。群 `/agentpurge` 同时清理归档。

若不需要此功能，在现有配置中合并：

```yaml
alemonjs-agent-link:
  modules:
    disabled:
      - chat-history
```

关闭后停止采集和查询，已有记录仍按期限清理；需要立即删除可使用清理命令。`/agentstatus` 的主人私聊视图显示归档可用状态，写入失败记录固定错误日志，不输出聊天内容。归档查询工具启用后，聊天使用业务工具调用链，工作区操作通过 `agent_workspace` 委托沙箱。

---

[← 文档首页](README.md) · [项目主页](../README.md) · [命令速查](commands.md)

## 静默准备 Agent 环境

默认 auto 模式先检查本机沙箱。Linux 缺少 Bubblewrap 时尝试识别已有的 apt-get 或 dnf 后无交互安装；非 root 使用 sudo -n，不弹出密码提示，不修改内核隔离策略。管理员权限不可用或容器限制仍需部署者处理。Windows 原生仍需 WSL2。

沙箱前置检查通过后优先复用本机 Python；没有可用解释器时下载固定 uv 0.13.6 并校验 SHA-256，通过 uv 在数据目录准备 Python 3.12 和虚拟环境，再安装锁定的 DSH 依赖。下载需要网络；工具、Python 与缓存放在数据目录，不修改全局 PATH。自定义 pythonExecutable 不会被覆盖。机制参考 [uv Python 管理文档](https://docs.astral.sh/uv/guides/install-python/)。

安装过程不输出进度到聊天。最终以 Bridge 健康检查与沙箱检查确认就绪，不能把安装成功当作 Agent 已就绪。失败时 auto 保留普通聊天并后台重试；sandbox 模式报告失败。可用 /agentstatus 查看状态。

### 首次安装遇到问题

启动时会先检查系统版本与架构，不支持的平台不会反复下载依赖。当前完整 Agent 运行包支持 macOS 14+，以及 glibc 2.28+ 的 Linux，CPU 为 x64 或 arm64；Alpine/musl 暂不支持。

Windows 原生可以运行普通聊天，但完整 Agent 需进入 WSL2：以管理员身份运行 `wsl --install`，按提示重启并完成发行版初始化，再在 WSL2 内安装 Node.js、下载项目和启动。首次管理员授权、重启不能静默跳过；不要在 Windows Node 进程中混用 WSL Python。

网络较慢时可在已有 `alemonjs-agent-link` 配置段设置 `preparationTimeoutMs: 600000`，给一次环境准备最多十分钟。SDK 下载使用安装预算，并为备用源保留时间；该设置不代表保证下载成功。缓存的 uv 工具无法执行时会重新下载并校验。已准备的托管 Python 也供语音虚拟环境使用，不再强制依赖系统 python3。

查看 `/agentstatus` 确认增强环境是否就绪；普通聊天可用不代表沙箱、网页和媒体能力全部可用。

离线检查 `npm run doctor` 会显示系统与架构是否满足 Agent 要求；严格 sandbox 模式遇到不支持的平台会直接报告错误，auto 模式保留普通聊天并提示限制。检查不会下载安装。依赖下载失败后，重试会复用已有可用 Python 虚拟环境，仅补装缺失的 SDK；系统 Python 低于 3.10 时会跳过，尝试其他解释器或托管安装。

Python 环境准备使用数据目录内的安装锁，其他实例不会同时改写环境；停止或超时时，macOS/Linux 会终止安装进程组，避免残留下载子进程。`startup.log` 记录环境复用、托管 Python 下载、SDK 下载源序号和探测结果；SDK 探测通过仍不等于完整 Agent 验收通过。

Linux 离线检查还会说明是否已找到 Bubblewrap、可用包管理器与 sudo。安装只使用 PATH 中绝对目录下的可执行文件；apt-get 首次安装失败后尝试刷新包索引并重试，所有步骤共享一次安装预算。未安装 sudo 或没有免密权限时会给出管理员可执行的安装命令，不弹出密码输入。

### 音色库的本地语音设置

音色库页面可单独启停本机系统 TTS、允许本地兜底，并设置已安装的系统音色名称。对应 `media.localSpeech`：`enabled`、`fallback` 默认均为 `true`，`voice` 可留空沿用当前引擎配置或系统默认。Edge TTS 需要联网，不属于此处的本地系统音色。

关闭 `enabled` 后，直接选用 system 和失败降级都不能调用系统 TTS；仅关闭 `fallback` 时，仍可直接选择 system。远程音色降级到本机需要当前音色 `speech.fallback`、本地 `enabled` 与 `fallback` 同时开启。音色名称由运行机器决定，保存配置不会安装音色。设置保留版本冲突保护和密钥占位符。

仓库独立启动器会根据配置为 Linux 软件包准备、Python 准备和 Bridge 启动预留等待时间，不再固定两分钟结束首次启动。扫码等待不会缩短已有安装预算；应用就绪后不会因迟到的二维码事件重新启动超时计时器。

音色库支持按名称、ID、引擎搜索，逐项调整降级开关，并通过结构化表单配置 system、Edge、OpenAI 兼容、Breeze、CosyVoice、GPT-SoVITS 与 HTTP 引擎。未展示的既有字段会保留；OpenAI 兼容音色仍使用共享的 media.tts 服务配置。未保存的编辑在关闭或离开页面前会提示。

「试听」使用已保存配置，只在管理员点击后实际合成，远程服务可能消耗额度；输入最多 200 字，同时只允许一次试听，最长 60 秒。音频仅返回管理页播放，不发送群聊，页面标明实际引擎及降级来源。供应商测活仍只是连通性检查，不等于合成验收。默认音色停用或 system 被全局关闭时页面提示切换。

管理页试听在已认证的管理员执行范围中运行，不要求聊天会话身份，也不扣减聊天钱包。全局 AI 关闭仍会阻止试听；供应商自身额度、402 冷却与本地兜底规则保持生效。普通聊天不进入此范围，继续校验会话身份和预算。

托管安装工具下载对网络中断、HTTP 408/429/5xx 最多尝试三次，并遵守同一安装时间预算。文件超限、404 或哈希校验失败不会继续重试执行。新工具通过哈希与可执行性检查后才原子替换缓存；安装超时不会提前删除原有工具。下载目前不支持断点续传。

### 统一管理页的表情管理

侧栏「表情管理」与聊天共用 media.stickerRoot 的素材清单，支持预览、名称／ID／标签搜索、表情与头像筛选、上传、编辑名称标签及移除。图片支持 PNG、JPEG、WebP、GIF，单张最多5MB；后端再次校验图片内容。编辑和移除在素材库锁内校验版本，页面数据过期时需刷新后重试。移除只从清单移除，原文件保留，本页不操作 QQ 收藏。重复上传复用现有素材。上传达到容量时沿用现有自动素材清理策略。

### 生图库

侧栏「生图库」管理 `media.imageLibrary`，通过 `media.activeImage` 选择默认项。每项包含 ID、名称、启停及 provider：baseUrl、apiKey、model、size、stylePrompt、ownerOnly。兼容现有 OpenAI Images `/images/generations` 调用协议，不代表支持所有供应商的私有接口。地址可使用 HTTPS 或本机 HTTP 回环服务。

未选择库中配置时沿用 `media.imageGen`；选择已停用项后聊天生图不可用。旧版单配置可从页面迁入并设为默认，保留参数、密钥和原配置。编辑沿用密钥占位符和配置版本检查。

「试生成」仅使用已保存配置，管理员主动点击后生成一张并展示，不发送群聊；可能消耗供应商额度。不使用聊天钱包身份，但遵守 AI 全局开关；一次只允许一个试生成请求。没有供应商统一余额接口，因此页面不将连通状态当作可用额度。当前本地未配置生图服务时，需要先填写真实供应商信息。
