# 运维手册

## 部署前检查

- 运行宿主为 macOS，且存在 `/usr/bin/sandbox-exec`。
- Redis 可连接，QQ Bot 和主人账号已配置。
- `alemon.config.yaml` 仅对运行账户可读，且未提交。
- 已通过私聊绑定模型凭证。

首次启动时，AgentLink 会创建 `.data/agent-link/venv` 并安装 DSH SDK；这一步需要网络和数据目录写入权限。

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

| 现象 | 优先检查 |
| --- | --- |
| 服务准备中或启动失败 | Python 3、网络、`.data/agent-link/` 权限、Bridge 端口。 |
| 新请求被拒绝 | Redis 连通性和 `/agentstatus`。 |
| 请求超时 | 模型服务、网络、`requestTimeoutMs`，以及本机容量。 |
| 群内排队已满 | 当前群请求量；使用 `/cancel` 取消自己的等待请求。 |
| 无可用模型 | 主人私聊执行 `/agentmodels`，必要时重新 `/agentbind`。 |

## 数据维护

- `/new`：管理员或主人清除当前群的正式会话和近期参考。
- `/agentcontext clear`：管理员或主人仅清除近期参考。
- `/agentpurge` 后跟 `/agentpurge confirm`：仅主人可彻底删除目标群数据；确认窗口为 60 秒。
- 无活动群数据默认保留 30 天。启动时与之后每小时会执行清理。

## 升级

1. 先停止生产进程。
2. 更新代码与依赖。
3. 执行 `yarn test`。
4. 执行 `yarn build` 后重新启动。
5. 在 QQ 私聊中运行 `/agentstatus` 验证 Bridge、Redis 和 Sandbox。

不要通过删除 `.data/agent-link/` 解决常规故障；这会丢失本机 Bridge 与隔离会话数据。优先使用群级清理命令。
