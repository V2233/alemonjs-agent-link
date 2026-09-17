# 运维手册

## 平台支持与部署前检查

以下沙箱依赖仅针对工具执行。默认 `auto` 模式缺少依赖时可降级为纯聊天；Windows 原生也可以使用纯聊天。`/agentstatus` 显示降级状态，网页、文件、终端关闭。模型地址与 API Key、Redis 仍为必需；降级状态本身不表示模型连接已验证。

| 宿主环境 | 状态           | 运行方式                                                                                                               |
| -------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| macOS    | 支持原生运行   | 需要系统 `/usr/bin/sandbox-exec`。                                                                                     |
| Linux    | 支持原生运行   | 安装 Bubblewrap（`bwrap`），并允许 Worker 创建所需命名空间。                                                           |
| Windows  | 通过 WSL2 支持 | 在 WSL2 Linux 发行版中安装并运行**完整** Node、Python 与 AgentLink 服务；不要从 Windows Node 进程混合调用 WSL Python。 |

Windows Sandbox 不适合作为 Worker 后端：它是临时桌面 VM，关闭即丢失状态，并且不允许多实例，无法满足多个群常驻隔离 Worker 的模型。

- 运行宿主为 macOS 或 Linux：macOS 需存在 `/usr/bin/sandbox-exec`；Linux 需安装 Bubblewrap（`bwrap`）。如 `bwrap` 不在 `PATH` 中，可设置 `DSH_BWRAP_EXECUTABLE` 为其绝对路径。
- Linux 容器还必须允许 Bubblewrap 创建用户和挂载命名空间；受限容器通常需要在镜像中安装 `bubblewrap`，并允许非特权用户命名空间或提供可用的 setuid `bwrap`。
- Redis 可连接，QQ Bot 和主人账号已配置。
- `alemon.config.yaml` 仅对运行账户可读，且未提交。
- 已在 `alemon.config.yaml` 的 `alemonjs-agent-link` 下配置 `apiKey`。

首次启动时，AgentLink 会创建 `.data/agent-link/venv` 并按仓库内锁定版本安装 DSH SDK；这一步需要网络和数据目录写入权限。升级 DSH 时必须同步更新 `python/requirements.txt`，并完成 sandbox 集成验证。

## 启动与停止

开发环境：

```bash
yarn dev --login qq-bot
```

生产环境：

```bash
yarn build
yarn start --login qq-bot
```

生产中只运行一个 Node 进程。热重载可能在旧 QQ Gateway 连接尚未释放时建立第二个连接，从而导致网关重置。

## 健康检查

在 QQ 中发送 `/agentstatus`：

- 所有用户可看到服务是否就绪。
- 机器人主人在私聊中可看到 Bridge、Redis、Sandbox、并发容量和模型凭证状态。

常见状态与动作：

| 现象                 | 优先检查                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------- |
| 服务准备中或启动失败 | Python 3、网络、`.data/agent-link/` 权限、Bridge 端口。                                      |
| 新请求被拒绝         | Redis 连通性和 `/agentstatus`。                                                              |
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
5. 在 QQ 私聊中运行 `/agentstatus` 验证 Bridge、Redis 和 Sandbox。

不要通过删除 `.data/agent-link/` 解决常规故障；这会丢失本机 Bridge 与隔离会话数据。优先使用群级清理命令。
