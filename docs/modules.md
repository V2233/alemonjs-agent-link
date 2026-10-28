# 模块与业务工具

内置 `platform` 提供 OneBot 连接查询及当前发言人回戳；`group-admin` 默认对所有群、在本轮发言人为主人时提供群管理工具，执行时由适配器重新核对权限；设 `allGroups: false` 后才使用白名单。连接配置、回执和未知状态语义见 [OneBot 接入](onebot.md)。

AgentLink 在排队请求实际执行时加载模块。模块可以提供模型可调用的业务工具、每轮参考上下文、消息输入转换、完整回复转换，以及发送成功后的活动处理。模块文件由服务器管理员维护，是拥有 Node.js 权限的本机代码。

## 配置

```yaml
alemonjs-agent-link:
  modules:
    # 可省略，默认为 workspaceRoot 同级的 modules 目录。
    directory: '/absolute/path/to/agent-link/modules'
    disabled: []
    maxToolRounds: 8
    maxToolContinuations: 2
    settings:
      greeting:
        suffix: '咕噜。'
```

`maxToolRounds` 限制每段可执行工具的轮数，范围 1–16，默认 8；每轮最多 8 个调用，每段最多 32 个。首次触顶保留模型历史和回执，静默释放全局执行名额并排队续跑；同一会话继续串行，后续消息不会抢先进入原任务的上下文。`maxToolContinuations` 默认 2（最多共三段），范围 0–4；设为 0 可直接收尾。正常结束不额外续跑，排队期间不发送提示，也不重做已有回执的同编号调用。

连续用完所有续跑次数仍未结束时，最多请求一次不带工具的模型汇总，说明已有结果、未完成和不确定部分；汇总失败使用固定提示。超出单轮8项的待执行批次不执行，恢复提示要求模型分批处理。所有分段、排队和汇总共享原始总时限、取消信号及额度，续跑不会重置超时或绕过费用检查；`/取消`、会话重置同样中止等待中的续跑。每次模型请求和实际调用仍可能收费，增加续跑次数会增加潜在调用量。

内置 `memory` 模块默认启用。明确保存工具仅向私聊提供；当前会话还可检索自动整理的资料、核对来源与人物档案。停用该模块使用 `disabled: [memory]`，已有记忆及手动命令继续保留。自动整理、版本恢复和删除语义见[长期记忆](memory.md)。

内置 `stickers` 模块提供 `list_stickers`、`send_sticker`、`make_sticker`、`collect_sticker`、`add_sticker`、`import_image_folder` 和 `manage_sticker`。查询及发送支持按编号或标签查找；收藏当前附件对主人在私聊和群聊开放，修改名称/标签和移除清单（并尝试删除 QQ 收藏）仅对主人私聊开放，均须有明确请求。`add_sticker` 只接受 HTTPS 地址或素材目录内的本地图片，可用 `kind: avatar|sticker` 和 `category` 分类；`collect_sticker`、`add_sticker`、`import_image_folder` 同样可指定 `kind/category`；`make_sticker` 把本轮/最近图片或素材库表情裁成方形 PNG，可上下配字并默认同轮发送；动图只取第一帧。发送每轮最多尝试一次，与命令及自动表情共用冷却。素材目录、收藏与二创限制见[媒体能力](media.md)。`modules.disabled: [stickers]` 停用模型工具，不影响手动命令或自动表达；后台自主搭话不开放这些工具。

### 私聊主动搭话

```yaml
alemonjs-agent-link:
  modules:
    settings:
      proactive:
        activity: active # quiet / balanced / active；默认最积极
        enabled: true
        idleMinutes: 20
        minIntervalMinutes: 30
        maxIntervalMinutes: 90
        maxPerDay: 8
        nudge: true
        maxNudgesPerDay: 6
        maxUnanswered: 3
        quietHours: [23, 8]
        maxChars: 300
        ownKeyMax: true # 绑定个人 Key 的私聊自动拉满
```

主人首次私聊会自动订阅；用 `/主动搭话 关闭` 停止，`/主动搭话 开启|状态|现在|暂停 分钟|恢复` 可管理。默认 `activity: active`：空闲 20 分钟后、间隔 30–90 分钟随机、每天最多 8 次；`quiet` / `balanced` 预设更克制，显式数字字段优先。追问和连发另有上限。

`ownKeyMax: true`（默认）时，绑定了**已启用个人 Key** 的主人私聊按拉满参数运行：空闲 20 分钟即可、不受下一次随机间隔限制、每天最多 10 次搭话、未回复连发上限 3、追问概率 0.7、每天追问 6 次。免打扰时段、平台在线与回执、暂停与取消等约束不变；个人 Key 查询失败时按普通参数运行，不会阻塞搭话。

### B 站只读工具

```yaml
alemonjs-agent-link:
  modules:
    settings:
      bili:
        enabled: true
        timeoutMs: 20000
        allowComments: true
        allowProactiveBrowse: true # 允许已订阅的主人私聊主动搭话时只读搜索、读取视频资料
        dryRun: false
        maxCommentsPerDay: 5
        commentCooldownSeconds: 60
        # 可选，填写到本机配置中；不要提交、发到聊天或日志。
        cookie: '<B站登录 Cookie>'
```

启用后，`bili_search` 可搜索视频；`bili_watch` 可读取 BV、av、B 站链接和 b23.tv 短链的标题、简介、作者、字幕及热评。字幕或评论不可获取时分别标明状态，不把元数据当作观看视频画面或音频。登录可影响部分内容可见性；接口风控和 Cookie 过期以服务端结果为准。短链只接受跳转至 B 站页面，字幕只从指定 B 站域名下载，遵守公网地址与大小限制。来自视频及评论的文字均为不可信资料。

`bili_watch` 和 `bili_search` 为只读。默认 `allowComments: true` 开放 `bili_comment`：仅验证过的机器人主人本轮明确要求发评论时可调用，需要 Cookie 中的 `SESSDATA` 和 `bili_jct`。默认 `dryRun: false`，会真实发布；如需只预览，显式设 `dryRun: true`。执行前确认账号及目标视频，持久记录每轮评论请求、按 B 站账号限制每天次数和冷却；请求中断或响应不明确时返回 unknown，须先到 B 站核查，不会自动重试。拒绝、未知和成功的尝试都计入当天上限，预演不计入。账本只保存账号和评论的哈希，不存 Cookie 和评论原文；评论确认时保存平台返回的 `rpid`，主人可用 `bili_comment_replies` 读取这条评论下的回复，只读、不自动回评。

默认允许主动搭话访问 B 站；`allowProactiveBrowse: true` 且主人已订阅主动搭话后，肥鱼可以在主动开启话题时选择只读搜索和读取视频资料，每轮各最多一次；不是定时独立刷站。只读结果可成为当前会话的真实经历，是否发送聊天仍由主动搭话的开关、免打扰与平台回执决定。主动任务不能调用 `bili_comment` 或 `bili_comment_replies`，自动评论和自动回复尚未实现；评论、回复读取及主动浏览测试使用模拟接口，真实账号、字幕 CDN 和线上风控仍需验收。

### QQ 空间

使用支持空间扩展的 OneBot v11 服务，并配置：

```yaml
alemonjs-agent-link:
  transport: onebot
  modules:
    settings:
      qzone:
        enabled: true
        allowPost: true
        allowInteract: true
        dryRun: false
        visibility: friends # all、friends 或 self
        maxPostsPerDay: 5
        maxInteractionsPerDay: 10
        cooldownSeconds: 60
        diary:
          enabled: false
          botId: '<机器人QQ号>' # 字符串，与 OneBot 登录账号一致
          ownerId: '<主人QQ号>' # 字符串，须是 OneBot 已配置主人
          hour: 20
          timezone: 'Asia/Shanghai'
```

主人在 OneBot 私聊中可使用模型工具 `qzone_read` 查看机器人自己的说说或可访问的好友动态。空间扩展不是 OneBot v11 的通用保证：服务须分别支持 `get_qzone_msg_list` 和 `get_qzone_feeds`，返回值以平台为准。

启用 `allowPost` 后，`qzone_post` 可以处理主人本轮明确要求发布的文字说说；默认 `dryRun: false` 会真实发布，设为 `true` 可只预览。设为 false 后适配器再次核对主人身份、开关和参数，再调用 `send_qzone_msg`。可见范围来自主人的明确要求，否则使用配置默认值。每轮一次，持久限制账号的每日次数和冷却；平台未返回可核验的说说 ID 或发送中断时标记为 unknown，先到空间核查，不会自动重试。尝试结果的账本只保存哈希，不保存正文。

`qzone_detail` 可读取最近通过 `qzone_read` 获得的动态详情和评论。`qzone_activity` 汇总自己或好友最近 3 条动态下的新评论，按主人私聊记忆已读，避免重复汇报；只读，不自动回复。启用 `allowInteract` 后，主人本轮明确要求时可用 `qzone_interact` 评论或点赞；需要 OneBot 服务支持 `get_qzone_msg_detail`、`comment_qzone` 和 `like_qzone`。只能操作同一主人私聊中最近 15 分钟读到、且平台提供了作者账号的说说；好友动态须由平台标为说说类型（appid 311），点赞还要求发布时间。目标缓存只在进程内保存，重启或模块重载后需重新读取。互动遵守同一试运行设置，按机器人账号单独限制每日次数和冷却；结果不明时应核查，不能自动重试。空间评论是对说说发表评论，尚未支持按评论 ID 精确回复。

主人明确要求配图时，可使用本轮消息或引用中已读取的图片，最多 4 张，每张不超过 8 MiB，编码后合计不超过 28 MiB；图片获取或校验失败时不会退化为只发布文字。图片仍受媒体输入的下载限制。

可选开启 `diary.enabled`：每天到达配置时区的整点后，从机器人与指定主人私聊的当日归档中取最近最多 20 条文字，交给已配置的聊天模型生成日记；没有内容或模型决定沉默则跳过。目前不读取群聊，也不自动配图。默认 `dryRun: false`；如果只想预览，设 `dryRun: true`，并保持 `allowPost: true`。可在主人私聊中询问自动日记状态，模型可调用 `qzone_diary_status` 查看最近结果与预览。每天按机器人账号持久领取一次，生成失败、预览、重启或发布结果不明都不会当天自动重试；`claimed` 可能代表仍在处理，也可能是中断后的未确认状态。自动与手动发布共享账号日限额和冷却。日记正文与状态保存在本机 SQLite，按配置的保留天数清理。

日记会根据私聊记录生成对外内容；模型不能保证完全去除私人细节，启用真实发布前应先通过预演检查内容和可见范围。

后台浏览与自动互动尚未实现。模拟测试不能证明特定 OneBot 实现、模型生成质量或真实 QQ 账号的空间扩展可用。

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

网页任务通过隔离 DSH 会话的 `agent_workspace` 执行，需要沙箱就绪和网页权限。文件由内置 `files` 模块的 `workspace_list/read/write/mkdir/move/delete` 工具执行，Node 模式也可用；路径固定在当前群或个人目录内，具体边界见 [安全说明](security.md#工具权限与隔离)。DSH 可通过 framework MCP 调用同一组受限文件工具，原生文件和终端工具始终禁用。

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

这不是自动开放框架的全部方法。平台尚未实现的动作仍需适配；新增接口需在登记表中明确 schema 和范围。群管理等写操作继续使用原有主人权限、全群/白名单与执行账本，不经过只读查询入口。由 AgentLink 发起的 DSH 工作区请求也可以通过 MCP 发现和调用本轮开放的工具。

### DSH 能力发现与统一调用

AgentLink 发起 `agent_workspace` 请求时，为本轮创建仅监听 127.0.0.1 的临时 MCP 入口，并通过已有 Python Bridge 的受控端口转发。DSH 使用内置 `@deepseek-ai/dsh-mcp-client`，获得两个稳定入口：

- `mcp__framework__discover({})`：返回当前平台、会话范围及精简能力目录。
- `mcp__framework__discover({name})`：按需读取一个能力的完整参数 schema。
- `mcp__framework__call({name, argumentsJson})`：使用该 schema 编码参数，调用后获得真实结果。

目录来自本轮模块租约中实际注册并通过 `available(context)` 的工具，包含平台查询及其他已开放业务能力，自动排除 `agent_workspace` 防止递归。新增模块工具无需另外编写 DSH 工具适配；未登记的框架底层方法不会被任意反射暴露。目录只表示本轮允许尝试，不表示平台账号权限已核验，也不是 AlemonJS 全部 API 的清单。

DSH 的每次模型请求只增加两个工具定义，完整能力 schema 按需读取。Node 在原有异步运行上下文中执行，复用 `executeTool` 的参数校验、可用性检查和主动消息限制；群管理继续使用主人校验、全群/白名单与账本。模型不能传入或覆盖可信会话身份。单轮最多执行 16 次业务调用，不允许并行重入；结束或取消后撤销入口。Python 中转仅接受当前回合的独立框架凭证，转发地址必须是经过主服务鉴权提交的固定格式回环地址，不跟随重定向。

验证：`node --test --test-force-exit test/framework-mcp.test.mjs test/group-info.test.mjs test/onebot.test.mjs`；Python 桥测试使用 `python3 -m unittest scripts/test_dsh_bridge.py scripts/test_dsh_worker.py`。安装本地 DSH 虚拟环境并完成构建后，可运行 `node scripts/test_framework_runtime.mjs`，使用真实 DSH Runtime、OS 沙箱、Python 中转与本地模型测试桩验证发现→schema→调用→回执→回答，不消耗在线模型额度或发送 QQ 消息。真实 QQ 账号的接口权限仍需部署环境验证。

### 自动发现其他插件的 Expose 能力

内置 `expose` 模块默认启用，要求宿主 AlemonJS 2.1.118 或更新兼容版本。其他插件与 AgentLink 由同一 AlemonJS 运行实例加载并注册 Expose 后，模型可以使用：

- `expose_discover({})`：分页读取精简目录，每页 30 个动作，可用 `protocol`、`provider` 筛选，`offset` 翻页。优先用 `query` 按动作名或描述搜索（例如 `{query: "资料"}`、`{query: "get_profile"}`），避免为查一项资料遍历整个目录。
- `expose_discover({protocol, provider, action})`：读取该动作原始输入、输出 schema 和读写类型，`callable` 表示桥是否允许尝试。
- `expose_read({protocol, provider, action, argumentsJson})`：执行只读动作。
- `expose_write({protocol, provider, action, argumentsJson})`：执行提供插件公开且声明为 write 的动作，无需 Link 逐动作配置。
- `expose_call({protocol, provider, action, argumentsJson})`：统一调用完整契约接口，包含声明为 unknown 或未标效果的查询。未知效果按可能改变状态的操作处理，保留防重与提供方授权。

目录每次从 `Expose.list()` 读取，后加载的插件和后续新增动作无需逐项修改 AgentLink。执行走 `Expose.call()`，保留框架对输入、输出、授权、超时和取消的检查，默认单次接口时限 15 秒。`argumentsJson` 为按接口 schema 编码的 JSON 值；原始 schema 直接呈现，不转换成 AgentLink 的较小 schema 子集，避免丢失 null、minItems 等约束。缺少完整输入/输出契约的动作可以查看但无法执行。`effect=unknown` 只代表提供方未明确标定效果，不代表权限拒绝；目录和动作详情返回 `executionTool` 与 `mayMutate`，模型应按推荐入口调用。目录声明不代表账号已绑定或已获授权。

工具同步进入既有 DSH MCP 目录，DSH 可先发现 `expose_discover`，再通过 `mcp__framework__call` 查询插件能力与调用。Node 回复模型也可直接使用同一组工具。模型无需接触游戏服务端凭据。

默认接入提供插件公开的完整读写契约。可选配置仅用于限制提供方：

```yaml
alemonjs-agent-link:
  modules:
    settings:
      expose:
        providers: [xiuxian-game] # 可省略；空数组拒绝全部提供方
```

Link 不再要求 `writeActions`；历史同名配置不再参与动作准入。提供方须在 Expose 授权和业务接口中落实玩家身份、操作权限、确认及持久幂等，模型或机器人主人不能替玩家授权。提供方筛选只是允许尝试。桥要求可信框架消息上下文与本轮平台、机器人、发言人及会话匹配，不接受模型传入 callerApp 或替换消息身份。后台自主搭话不开放 Expose 工具；每条待合并消息保存其原始异步上下文，回复所选发言人时恢复对应上下文。身份不匹配仍拒绝调用。主人的机器人管理身份不能代替其他玩家授权。可通过 `modules.disabled: [expose]` 停用整座桥。

同一请求对同一写动作或未知效果动作复用首次回执，主模型与 DSH 的上下文副本也共享该记录；若首次明确返回 INVALID_INPUT 且 outcome=not_started，允许本轮纠正参数；其余已尝试的操作更换参数会拒绝再次执行。记录在模块内保留 30 分钟，最多 1000 条，满时拒绝新的写入。该保护不提供跨进程重启、模块重载或跨请求的持久幂等；这些保证必须由提供插件及游戏服务实现。失败回执保留 `callId`、错误代码与 `outcome`；unknown 表示可能已执行，不自动重试，也不能当作已成功。

修仙插件当前的只读属性接口可按它实际注册的协议和 provider 调用，后续玩法是否开放以 Expose 目录为准。本桥不新增游戏玩法、不代替提供方实现确认流程或离线委托。

验证：`node --test --test-force-exit test/expose-tools.test.mjs`；本地安装 DSH 后可执行 `node scripts/test_framework_runtime.mjs --expose`，通过真实 DSH 沙箱、Python 中转与本地模型测试桩验证 Expose 的发现、schema、调用和回执，并检查提供方接收到原始玩家身份与真实调用插件名。

框架权限按回合隔离：每个带 MCP 的 DSH 工作区回合使用新的运行进程、独立 home 和一次性凭证，结束时撤销框架与模型代理凭证；成功回合先正常关闭 DSH，让原生日志刷盘，再结束进程组并保存快照。后续回合不复用旧 home 的 profile、插件或凭证，只从受保护快照恢复原生 sessions/attachments 数据，并通过 SDK `resume_session` 恢复历史；快照复制忽略符号链接，限制目录深度、文件数量和体积。用户文件位于独立的受限目录，通过 framework MCP 操作，不能直接访问。既有脱离进程组的后台进程也无法凭旧凭证调用后续回合。

此路径锁定 DSH SDK/Runtime 0.2.1rc2，使用其原生恢复能力；管理虚拟环境启动探针会识别旧 SDK 并按锁定依赖更新。真实两回合恢复验证可用 `node scripts/test_framework_runtime.mjs --expose --two-turns`，测试 Python 可通过 `AGENT_LINK_TEST_PYTHON` 指定。轮换运行进程会增加工作区请求的初始化成本，普通 Node 聊天和直接 Expose 查询不受影响。

该版本 DSH 的 DeepSeek 适配器使用 Messages 协议，桥支持其 x-api-key 鉴权并将官方默认地址映射至 `/anthropic/v1/messages`。第三方工作区模型网关需兼容 Messages；Node 普通聊天仍使用 Chat Completions。仅支持 Chat Completions 的网关可继续使用普通聊天，但不能据此声称新版 DSH 工作区兼容。

桥自身的入口类型错误返回 `EFFECT_MISMATCH`（origin=link），并给出正确 `executionTool`；未发现能力返回 `CAPABILITY_NOT_FOUND`，缺少结构化契约返回 `CONTRACT_REQUIRED`。这些错误不冒用提供方的 `FORBIDDEN`。真正的 Expose 拒绝保留 callId、原错误代码及 outcome，并标记 origin=expose；一次拒绝不能被解释为所有查询未开放。用户要求查资料不授权顺便签到、领奖或使用其他无关动作测试权限。注意：`effect=unknown` 是接口效果声明，`error.outcome=unknown` 是某次执行结果不明，两者含义不同。

回归验证可用 `node scripts/test_framework_runtime.mjs --expose --unknown-effect --two-turns`，检查真实 DSH 对未明确效果的查询经推荐入口调用，提供方收到可信身份并返回数据。

工具诊断日志仅记录 requestId、轮次、调用序号、工具名、结果分类、耗时和触顶原因，不记录参数、工具结果正文或思考内容。`tool-limit` 的 reason 区分 round-limit、call-limit、batch-limit；returned 仅表示获得回执，不等于业务成功。

---

[← 文档首页](README.md) · [项目主页](../README.md) · [命令速查](commands.md)
