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
