# 模块与业务工具

内置 `platform` 提供 OneBot 连接查询及当前发言人回戳；`group-admin` 在配置白名单且本轮发言人为主人时提供群管理工具，执行时由适配器重新核对权限。连接配置、回执和未知状态语义见 [OneBot 接入](onebot.md)。

AgentLink 在排队请求实际执行时加载模块。模块可以提供模型可调用的业务工具、每轮参考上下文、消息输入转换、完整回复转换，以及发送成功后的活动处理。模块文件由服务器管理员维护，是拥有 Node.js 权限的本机代码。

## 配置

```yaml
alemonjs-agent-link:
  modules:
    # 可省略，默认为 workspaceRoot 同级的 modules 目录。
    directory: '/absolute/path/to/agent-link/modules'
    disabled: []
    maxToolRounds: 8
    settings:
      greeting:
        suffix: '咕噜。'
```

`maxToolRounds` 限制一次回答可执行工具的轮数，范围 1–16，默认 8；每轮最多 8 个调用，整次最多 32 个。整轮工具、模型及回复共享请求时限、队列与取消信号。出现错误不会自动重跑有副作用的操作。

内置 `memory` 模块默认启用。明确保存工具仅向私聊提供；当前会话还可检索自动整理的资料、核对来源与人物档案。停用该模块使用 `disabled: [memory]`，已有记忆及手动命令继续保留。自动整理、版本恢复和删除语义见[长期记忆](memory.md)。

主人私聊发送 `/agentmodules` 查看模块加载结果，同时检查最新文件。正常聊天也会自动检查更新。坏模块会显示加载失败，其他模块继续加载；本地替换模块加载失败时不会偷偷启用同名内置模块。

## 本地模块

创建 `modules/greeting/index.mjs`：

```javascript
export default {
  id: 'greeting',
  name: '问候表达',
  version: '1.0.0',
  apiVersion: 1,
  setup(api) {
    api.on('reply', text => {
      const suffix = String(api.settings.suffix || '咕噜。');
      return `${text} ${suffix}`;
    });
    api.tool({
      name: 'current_time',
      description: '查询当前时间。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      execute: async (_args, context) => {
        context.signal.throwIfAborted();
        return { ok: true, iso: new Date().toISOString() };
      }
    });
  }
};
```

目录名和 `id` 必须一致，使用小写字母、数字和短横线。同名本地模块替换内置模块。不同模块不能注册同名工具；`agent_workspace` 为保留工具名。

模块目录的普通文件会一起生成版本快照，相对导入的依赖文件变动也会触发更新。每个模块最多 200 个文件、合计 5 MiB，最多嵌套 8 层，不接受符号链接。`.开头文件` 与 `node_modules` 不进入快照；第三方包需要安装到服务进程可解析的位置。

更新时，新请求使用新版本，正在运行的请求继续使用原版本。旧版最后一个请求结束后执行清理。删除目录会卸载模块；升级安装包不会覆盖用户模块目录。快照位于 `workspaceRoot` 同级的 `module-cache`，模块持久目录位于同级的 `module-data/<id>`。

## API

| 接口                                                     | 作用                                             |
| -------------------------------------------------------- | ------------------------------------------------ |
| `api.id`                                                 | 当前模块 ID                                      |
| `api.settings`                                           | 本模块设置的独立副本，不含其他模块配置或模型凭证 |
| `api.dataDirectory`                                      | 本模块持久数据目录                               |
| `api.tool(tool)`                                         | 注册业务工具，参数在执行前重新校验               |
| `api.on('system', (prompt, context) => string)`          | 转换本轮系统提示词；非空且最多32000字符          |
| `api.on('context', context => string)`                   | 追加本轮参考资料                                 |
| `api.on('prompt', (input, context) => input)`            | 转换文字或原生图片输入块                         |
| `api.on('reply', (text, context) => string)`             | 完整回答生成后、发送前转换回复                   |
| `api.on('activity', ({input, output}, context) => void)` | 回复完整发送后的活动处理                         |
| `api.onDispose(cleanup)`                                 | 模块卸载或替换后的资源清理                       |

`context` 包含 `channelId`、`userId`、`platform`、`private`、`owner`、当前原始 `userText`、本轮 `capabilities` 和 `signal`，以及可选的 `requestId`、原始输入 `inputId`、是否直接呼唤的 `addressed`。`owner` 来自事件的主人身份，不能根据昵称或模型参数判断。工具使用 `available(context)` 决定是否在当前回合开放，执行时还会复核。`activity` 只在完整送达后执行，主动沉默不触发。

工具参数支持 object、array、string、boolean、number、integer，以及必填、枚举、长度和数值范围。object 默认拒绝未声明的参数，除非显式设置 `additionalProperties: true`。工具返回可 JSON 序列化的业务结果；推荐 `{ok, message, ...data}`，不要返回凭证。异常给模型的结果统一为失败，不包含异常堆栈。

## 模型与历史

存在可用业务工具、回复转换模块或本轮系统提示词变化时，主模型通过兼容 Chat Completions 的 function tools 完成调用循环。存在工具时配置的模型服务必须支持工具调用；服务不支持时本轮报错，不假装执行成功。内置人格和心情见[人格、心情与自动表达](companion.md)。

网页、文件和终端任务仍在已有隔离 DSH 会话中执行，主模型通过 `agent_workspace` 获取真实执行结果。该工具仅在沙箱已就绪且当前策略允许相应能力时提供。Node 降级模式只开放已注册的业务工具，不会通过模块工具获得宿主机终端权限。

模块工具回合的问答在全部回复成功送达后保存到会话历史，群聊和私聊按会话隔离。沿用 `privateHistoryMaxTurns`、`privateHistoryTtlSeconds`、`privateHistoryMaxChars` 的历史预算；`/new` 和数据清理同样覆盖这份历史。回复转换后的最终文本写入历史，图片仅保存文字占位。模块未提供工具或回复转换时沿用原有聊天链路。

本地模块运行在宿主 Node 进程中，不属于 DSH 沙箱。仅加载管理员维护的代码，不能把用户上传文件或模型生成的文件放入模块目录执行。`activity` 表示平台发送成功，并不表示用户已读。

### 查询当前群资料

`platform` 模块向当前群聊的回复模型提供只读工具 `get_current_group_info`，支持 `qq-bot` 和 `onebot`。它通过 AlemonJS `useGuild().info()` 调用框架，返回群名、成员总数和查询时间；OneBot 映射到 `get_group_info`。无需主人权限，不允许模型指定其他群，机器人账号和群标识来自当前请求。

用户问“这个群叫什么”“群里多少人”时，工具描述要求先查询，不凭聊天记录猜测。字段缺失返回 `null`，不能当成零；接口失败只能说明本次查询失败，不能推断平台永远不支持。群名称是外部数据，不授予指令权限。本工具不返回完整成员名单。

此能力既用于 Node 回复模型的工具循环，也通过本轮 MCP 桥供 AgentLink 发起的 DSH 工作区请求发现和调用。独立启动、未连接 AgentLink 的 DSH 不会自动获得机器人权限。模拟测试覆盖模型请求工具、框架回执回填、当前群范围和失败处理；真实 QQ 权限与接口可用性仍需实际环境验收。

### 框架能力登记表

`src/platform/catalog.ts` 集中声明能力名称、说明、参数 schema、支持平台、群聊范围及执行函数。`createFrameworkTools()` 自动生成模型工具，并在执行时再次检查参数、平台、范围和取消信号；新增能力无需重复编写工具注册和校验代码。当前提供：

- `get_current_group_info`：群名与人数，复用 `useGuild().info()`。
- `get_current_group_member`：指定成员或当前发言人的昵称、角色，复用 `useMember().info()`。
- `list_current_group_members`：当前群成员的一页，复用 `useMember().list()`，最多返回 100 条。

三项均支持 qq-bot 和 OneBot；平台权限是否允许仍以真实回执为准。机器人和群 ID 从可信会话注入，模型不能传入其他群号。成员数据仅返回 ID、昵称和角色，不透传 UnionId 等原始字段。分页的未知值使用 null，不把单页长度作为总人数。QQ 平台若忽略页大小且单页超过 100 条，返回 truncated=true，不能声称名单完整；OneBot 原生接口返回全量名单，适配器按偏移量分页输出，但每页仍需要调用原生全量接口，动态名单可能发生变化。

这不是自动开放框架的全部方法。平台尚未实现的动作仍需适配；新增接口需在登记表中明确 schema 和范围。群管理等写操作继续使用原有主人权限、白名单与执行账本，不经过只读查询入口。由 AgentLink 发起的 DSH 工作区请求也可以通过 MCP 发现和调用本轮开放的工具。

### DSH 能力发现与统一调用

AgentLink 发起 `agent_workspace` 请求时，为本轮创建仅监听 127.0.0.1 的临时 MCP 入口，并通过已有 Python Bridge 的受控端口转发。DSH 使用内置 `@deepseek-ai/dsh-mcp-client`，获得两个稳定入口：

- `mcp__framework__discover({})`：返回当前平台、会话范围及精简能力目录。
- `mcp__framework__discover({name})`：按需读取一个能力的完整参数 schema。
- `mcp__framework__call({name, argumentsJson})`：使用该 schema 编码参数，调用后获得真实结果。

目录来自本轮模块租约中实际注册并通过 `available(context)` 的工具，包含平台查询及其他已开放业务能力，自动排除 `agent_workspace` 防止递归。新增模块工具无需另外编写 DSH 工具适配；未登记的框架底层方法不会被任意反射暴露。目录只表示本轮允许尝试，不表示平台账号权限已核验，也不是 AlemonJS 全部 API 的清单。

DSH 的每次模型请求只增加两个工具定义，完整能力 schema 按需读取。Node 在原有异步运行上下文中执行，复用 `executeTool` 的参数校验、可用性检查和主动消息限制；群管理继续使用主人校验、白名单与账本。模型不能传入或覆盖可信会话身份。单轮最多执行 16 次业务调用，不允许并行重入；结束或取消后撤销入口。Python 中转仅接受当前 Worker token，转发地址必须是经过主服务鉴权提交的固定格式回环地址，不跟随重定向。

验证：`node --test --test-force-exit test/framework-mcp.test.mjs test/group-info.test.mjs test/onebot.test.mjs`；Python 桥测试使用 `python3 -m unittest scripts/test_dsh_bridge.py scripts/test_dsh_worker.py`。安装本地 DSH 虚拟环境并完成构建后，可运行 `node scripts/test_framework_runtime.mjs`，使用真实 DSH Runtime、OS 沙箱、Python 中转与本地模型测试桩验证发现→schema→调用→回执→回答，不消耗在线模型额度或发送 QQ 消息。真实 QQ 账号的接口权限仍需部署环境验证。
