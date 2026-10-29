# 图片、语音与表情包

## 外部生图

可选配置兼容 `POST /images/generations` 的服务。配置后，模型可使用 `generate_image` 生成一张图片并交给当前会话发送；未配置时仍可使用 `draw_image` 绘制图形元素。两种工具每轮合计最多尝试一次，调用成功只表示图片准备完成，平台回执决定是否发送成功。

```yaml
alemonjs-agent-link:
  media:
    imageGen:
      baseUrl: 'https://<生图服务地址>/v1'
      apiKey: '<生图服务密钥>'
      model: '<生图模型ID>'
      size: '1024x1024'
      stylePrompt: ''
      ownerOnly: false
```

填写接口前缀；服务须接受 `model/prompt/size/n/response_format`，并返回 `data[0].b64_json` 或 `data[0].url`（也接受 `images` 数组）。返回地址遵守附件下载的 HTTPS、公网和域名限制。仅支持 PNG、JPEG、WebP；图片大小、超时、取消与 `media.maxBytes`、`media.timeoutMs` 和当前回合一致。自建本机回环 HTTP 服务可不配置密钥。`ownerOnly: true` 仅向主人开放工具；后台主动搭话不开放。

生图可能由第三方单独收费。开启预算时会检查当前会话是否允许付费调用，但现有文本额度统计**不核算图片服务的实际费用，也不预留生图费用**；请在服务商侧设置额度。不要将配置成功等同于真实服务和 QQ 发送已验证。

图片复用当前模型池的端点；使用 `modelPool` 时，视觉端点必须在 `capabilities` 中声明 `vision`，否则带图轮次没有可用端点。带图聊天使用原生多模态请求，以 base64 image_url 内容块发送图片，避免 DSH 模型目录将图片替换为文字占位。业务工具仍可使用，工作区操作仍通过沙箱工具执行。实际识别能力取决于所配置模型和服务。ASR/TTS 仍采用独立的 OpenAI-compatible HTTP 接口。

## 使用

- 私聊直接发送图片或语音；群聊通过 @、称呼或 `/chat` 携带附件触发。普通未唤醒的群附件不会调用媒体模型。
- OneBot 当前消息的图片或表情带文件标识时，没有 URL，或原 URL 下载失败、返回非图片内容时，可通过 `get_image` 获取 base64、公开 HTTPS URL 或本机缓存文件。文件路径需要在顶层 `onebot.imageDirectory` 指定网关的图片缓存绝对目录；只读取该目录内的图片，默认不读本机路径。原 URL 可用时不额外调用网关；真实网关兼容性仍需验收。
- 引用的 OneBot 图片也支持该回退，限引用消息的前 5 个媒体附件。取图前会再次读取引用消息，核对会话、附件位置和文件标识；接口不可用或核对失败时不猜测图片内容。
- `/语音 问题`：用 AI 合成语音回答。合成失败、音频发送失败或回复太长时，回退文字；取消后不再发送缓存回复。
- `/表情`：查看已配置素材；`/表情 开心`：按精确编号、名称或完整标签发送。每次最多一个，默认同一会话间隔 30 秒；发送成功后会累计使用次数，供自动淘汰参考。
- 主人发送 `/表情 导入`（或 `/表情 导入收藏`）可读取机器人号 QQ 收藏里的表情。需要 OneBot 网关支持 `fetch_custom_face`；只读取 URL 并导入本地素材库，不写回 QQ 收藏，每次最多处理 30 张并按内容去重；配置 `media.vision` 时会尝试为导入图片生成名称/标签（可能产生视觉费用，预算不可用则退回“导入”标签）。网关不支持或读取失败时会直接说明，不会假装导入成功。
- 本会话最近 30 分钟内的图片可用于“存一下刚才那张”和 `source: "recent"`；只保留每会话最多 6 条的 URL/文件标识等元数据，不保存图片字节，进程退出或配置变更多半清空，超时后需要重新发送。
- 主人发送 `/表情 同步` 可把本地表情写入机器人号 QQ 收藏（需要 `add_custom_face`），已有 `emojiId` 的条目改为同步名称；`/表情 同步 编号` 只处理一张，单次最多处理 20 张。`/表情 删除 编号或名称` 会尝试删除对应 QQ 收藏并移除本地清单，QQ 删除未确认时会明确提示。写入 QQ 收藏是平台侧不可逆操作，只在主人明确命令或开启 `autoQQSync` 时执行。
- 主人可把本轮图片或素材库里的表情做成新表情包：方形裁切、上下配字、可只收藏或同轮发送。制作在本机完成，不调用第三方服务；详见[表情工坊](#表情工坊配字二创)。
- 自动语音和表情默认开启，可通过 `modules.settings.expression` 关闭；短句语音、心情影响、标签选择及回退规则见[人格、心情与自动表达](companion.md)。
- 语音缺少 Transcript 且未配置 ASR，或输入类型不支持时，直接回复：**看不懂，就当是夸我了**。不启动模型或 Worker，也不会向普通用户发送配置指导。平台已提供 Transcript 的语音无需另外调用 ASR。
- OneBot 收到单条语音时，会在实际处理聊天时按原消息 ID 尝试 `fetch_ptt_text`。失败且配置 ASR 时，可用该消息自带的语音文件标识请求 `get_record` 转为 WAV，再交给 ASR；支持有界 base64、公网 HTTPS URL，以及可选配置的本机缓存目录内的文件。转换不可用时继续尝试原附件。群聊分段中的语音各自使用来源消息 ID，含多段语音的单条消息不会猜测转写对应关系。扩展的真实服务兼容性需单独验收。

如果 OneBot 返回的是服务器文件路径，且网关与 AgentLink 运行在同一台机器或共享挂载目录，可在顶层 `onebot` 配置中设置 `recordDirectory` 为网关的语音缓存绝对目录。只有该目录内的 WAV 文件可读取，默认不读取路径；目录应仅包含可交给 ASR 处理的缓存文件。例如：

```yaml
onebot:
  recordDirectory: '/absolute/path/to/onebot/record-cache'
```

- 主人私聊 `/agentstatus` 查看哪些媒体能力已配置。显示“已配置”不是在线服务或 QQ 收发验证结果。

## 配置模板

合并到现有 `alemon.config.yaml`，保留已有 QQ、Redis 和文字模型配置。未启用的 provider 请删去整个配置段，不要保留占位密钥。

```yaml
alemonjs-agent-link:
  media:
    # 默认允许任意公网 HTTPS 附件域名，无需逐个配置 CDN。
    # 如需限制，填写精确域名列表；不写协议、路径或通配符。
    allowedHosts: []
    timeoutMs: 60000
    maxBytes: 10485760
    maxAttachments: 3
    ttsMaxChars: 800
    asr:
      baseUrl: 'https://<转写服务地址>/v1'
      apiKey: '<转写服务密钥>'
      model: '<支持文件转写的模型ID>'
    tts:
      baseUrl: 'https://<合成服务地址>/v1'
      apiKey: '<合成服务密钥>'
      model: '<语音合成模型ID>'
      voice: '<该服务支持的音色ID>'
    stickerRoot: '/absolute/path/to/stickers'
    stickerMaxItems: 300
```

只填写接口前缀，ASR/TTS 分别追加 `audio/transcriptions`、`audio/speech`。远程服务需使用 HTTPS 和独立密钥；本机 `localhost`、`127.0.0.1` 或 `[::1]` 的 ASR/TTS 可以使用 HTTP，密钥可省略。服务还需兼容以下请求/响应格式：

| 能力 | 请求                                                                  | 响应                              |
| ---- | --------------------------------------------------------------------- | --------------------------------- |
| 识图 | JSON `model/messages`，用户 content 包含 `text` 与 base64 `image_url` | `choices[0].message.content` 文本 |
| 转写 | multipart `file/model/response_format=json`                           | `text` 文本                       |
| 合成 | JSON `model/voice/input/response_format=mp3`                          | MP3 二进制                        |

兼容格式参考官方文档：[图片输入](https://developers.openai.com/api/docs/guides/images-vision)、[语音转写](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)、[语音合成](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)。不兼容这些协议的服务需要另加 provider 适配，不能仅改 URL 就保证可用。

本机部署了兼容接口时，可将上面的 `asr` 段替换为：

```yaml
asr:
  baseUrl: 'http://127.0.0.1:8000/v1'
  model: '<本机 ASR 模型ID>'
```

地址和模型 ID 以实际启动的服务为准。机器人进程必须能访问该回环地址；容器内的 `127.0.0.1` 指容器自身。SILK/AMR 需要 OneBot 网关提供可用的 WAV 转换结果，或由其他适配器提供支持的音频格式。

## 素材目录

主人自行放入有权使用的图片，并创建 `manifest.json`：

```json
[
  { "id": "happy", "file": "happy.png", "tags": ["开心", "高兴"] },
  { "id": "comfort", "file": "comfort.gif", "tags": ["安慰", "抱抱"] }
]
```

默认最多 300 项（`media.stickerMaxItems`，1–500）；id 唯一，每项最多 10 个标签。支持 PNG/JPEG/WebP/GIF。文件须真实存在于该目录内，不能通过 `../` 或外部符号链接读取目录之外的文件。清单上限 256 KiB。插件不自带第三方表情素材；自动收集默认对主人私聊和所有群开启，`autoAllGroups: false` 后才只收 `autoGroups` 中列出的群。

插件收藏的条目会附带 `kind`（`sticker` 表情 / `avatar` 形象头像，旧条目没有时按表情处理）、`category`（头像类型或表情主分类，如 `头像`、`开心`、`无语`）、`context`（适用/不适用场景，便于模型选图）、`from`（`auto`/`manual`/`forge`/`import`/`site`/`file`/`legacy`）、`addedAt`、`uses`、`lastUsed`、`width`、`height`、`bytes`、`confidence`、`sourceUrl`、`license` 和 `emojiId`（已写入 QQ 收藏时的平台标识）等可选元数据；外部清单可以省略。超过数量上限时，只会淘汰 `from: auto` 中“使用次数最少、最久未使用”的条目；主人手动加入、表情工坊生成和旧清单条目不自动删除，因此库满且没有可淘汰项时会拒绝新收藏。`kind: avatar` 只出现在素材/头像视图，`list_stickers` 和发送表情默认只取 `kind: sticker`。

本会话最近 30 分钟内的图片/表情会在内存中保留少量元数据（每会话最多 6 张，不落盘，按需下载），因此主人可以直接说“把刚才那张做成表情”或“存一下刚才那张”，不必每次引用；配置变更或进程退出会清空。

主人可以在私聊或群聊发送（或引用）一张图片，并明确要求“收藏这张图片做表情”；也可以让模型用 `add_sticker` 从 HTTPS 图片地址或素材目录内的本地文件加入（本地路径不越出素材目录，URL 仍受媒体地址和大小限制）。支持图片输入和工具调用的模型可根据实际图片提供标签，结果写入 `managed/` 与现有清单；同一内容重复收藏不会新增一条。当前消息和引用合计必须恰好有一张图片；没有当前图片时会尝试本会话最近一张。附件下载仍遵守媒体地址、大小和超时限制。群聊中只有主人能触发收藏，普通成员不能把别人的图片写进素材库。

主人可使用 `/表情` 查到编号，然后在私聊明确要求修改该编号的名称、标签或从清单移除。移除会尝试删除对应 QQ 收藏，但不会删除原始图片文件；收藏中断也可能留下未引用的文件。清单更新使用锁和原子替换，外部程序应避免同时编辑。异常退出后若残留 `.agentlink-sticker.lock`，确认没有其他进程正在修改素材库后再由管理员移除锁文件。首次使用会自动创建 `stickerRoot` 和空 `manifest.json`，但不会覆盖已有清单。

默认自动收集附件：主人私聊开启，群聊默认全部开启（`autoAllGroups: false` 时只收集 `autoGroups` 列出的群）。平台明确标记的表情会直接进入候选；普通图片只有在 `autoDetect` 和视觉服务都可用时才会被静默判断，不是所有图片都收。OneBot 的图片段 `sub_type=1`、带 emoji 标识的图片和 `mface` 归类为表情；缺少或无法下载 URL 时，可按原消息的文件标识使用 `get_image`，本机路径仍受 `imageDirectory` 限制。如需限制群范围，把 `autoAllGroups` 设为 false 并填写 `autoGroups`：

```yaml
alemonjs-agent-link:
  modules:
    settings:
      stickers:
        autoCollect: true
        autoOwnerPrivate: true
        autoGroups: [] # 为空且 autoAllGroups 为 true 时收集所有群
        autoAllGroups: true
        autoLabel: true
        autoMaxPerHour: 20
        autoDetect: true
        autoMinConfidence: 0.6
        autoMaxBytes: 2097152
        autoMaxSide: 1024
        autoQQSync: true
```

使用既有 `media.stickerRoot`、`manifest.json` 和附件下载规则。后台队列串行处理，最多等待 8 个附件，每条消息最多接收 3 个；每小时尝试上限和事件去重在当前进程内生效，重启后重置，素材本身仍按内容去重。超过上限或队列满的附件跳过，不阻塞聊天。关闭 AI 或停用模块时停止收集；配置变更或卸载时取消在途任务。

开启 `autoDetect`（默认开启）且配置 `media.vision` 时，启用范围内的普通图片会先按 `autoMaxBytes`（默认 2 MiB）、`autoMaxSide`（默认 1024）和宽高比（约 0.75–1.33）预筛，再由视觉模型静默判断 `kind`（头像/表情/其它）、是否适合普通群聊和主分类；头像与表情分别以 `kind` 入库，其它图片跳过，置信度需达到 `autoMinConfidence`。平台标记的表情也走边长/宽高比预筛，体积仍受 `media.maxBytes` 限制；视觉审核失败或未配置视觉时，平台标记表情按 `kind: sticker` 入库并退回“表情/未分类”，普通图片不自动收。`autoQQSync: true` 时，新入库的自动收藏会额外调用 `add_custom_face` 写入机器人号 QQ 收藏，并把返回的 `emojiId` 记入清单；默认开启，可在配置中设为 false 关闭（QQ 收藏有数量上限）。整个过程不回复聊天，不把“识别过”当成已收藏；未配置视觉服务时普通图片不自动收集。

配置 `media.vision` 后，`autoDetect` 开启时平台标记的表情也会先经视觉审核并生成名称/分类/标签，即使 `autoLabel` 关闭；`autoLabel` 主要用于只审核平台标记表情、不检测普通图片的场景。GIF、未配置服务、识别失败或预算准入失败时退回“表情”标签；普通图片检测必须依赖视觉，未配置时跳过。图片会发送给该视觉服务，可能产生服务商费用；目前图片识别费用不计入文本预算，需在服务商侧控制额度。实际 OneBot 附件地址、识别服务与 QQ 收发尚需部署环境验证。
发送优先使用 OneBot 专用 `agentLink.sendSticker`，发送 `sub_type=1` 的表情段；动作不可用或非 OneBot 平台回退 AlemonJS `useMedia.send`。两种情况都验证平台回执；平台不支持时报告失败，不把“调用过发送”算成已送达。插件不设置表情发送冷却，发送频率由框架控制。旧配置 stickerCooldownSeconds 已不再生效。

### 表情工坊（配字二创）

主人明确要求“把这张图做成表情包”“给这个表情加字/改字”时，模型可以调用 `make_sticker`。它把原图（或素材库里的已有表情）重新渲染成方形 PNG：

- `text` 最多 40 个字符，自动分 1–3 行，白字黑描边；`position` 可选 `top`、`bottom`。
- `size` 默认 300，可设 128–512 像素；`fit: cover` 居中裁切成正方形，`fit: contain` 保留完整画面并留透明边。
- 成品按内容哈希写入 `managed/` 并加入清单，重复制作同样参数不会新增；`send` 默认 `true`，平台回执成功后才返回已发送，设为 `false` 则只收藏。
- 来源默认是本轮唯一图片；也可以传 `source: "recent"` 使用本会话最近一张图片，或传 `source: "library"` 和素材库编号对已有表情二创。
- 动图只保留第一帧。原图上限 6 MiB、单边 8192 像素、总计 1600 万像素，超过时直接拒绝，不交给渲染器。
- 渲染使用系统字体与本地 `@resvg/resvg-js`，不访问网络、不产生第三方费用；部署机器缺少中文字体时可能出现方框，需要实际验收。
- 只有主人可用；普通成员仍只能按清单发送已有表情。

### 图片分类（形象头像 / 表情）

素材库用 `kind` 区分图片用途：

- `kind: sticker`：表情包/梗图/反应图，`list_stickers`、`/表情`、`send_sticker` 和自动表情只使用这一类。
- `kind: avatar`：角色形象、头像、半身/全身立绘，只出现在素材/头像视图，不会当作表情发送。
- `category`：主分类。头像常用 `头像`/`角色`/`半身`/`全身`/`场景`；表情常用一个主要情绪或用途，如 `开心`/`无语`/`疑问`/`晚安`/`搞怪`/`可爱`。
- `tags`：多标签补充检索；`sourceUrl`/`license` 记录来源与许可；`context` 记录适用/不适用场景，`list_stickers` 会返回截断后的用途说明。

配置 `media.vision` 时，自动收集和导入会调用视觉审核同时产出 `kind`、`category`、`name`、`tags`；不配置或审核失败时，平台标记表情按 `kind: sticker` + `未分类` 入库，普通图片不自动判断。偷来的表情同样走这条审核，因此也会带上分类。

批量导入本地图片：把有权使用的图片放进素材目录下的 `incoming/`（已被 `.gitignore` 忽略，不会进仓库），然后让模型调用 `import_image_folder`，例如“把 incoming 目录里的图片批量导入”。它会逐张判断头像/表情并分类，最多 30 张，不读取目录外文件；没有视觉服务时按调用参数或默认 `sticker` 入库。

```text
<stickerRoot>/
├── manifest.json       # kind/category/name/tags/来源/尺寸/使用次数…
├── managed/            # 插件统一管理的图片，头像与表情共用，按 kind 区分
└── incoming/           # 可选：手工下载/暂存目录，批量导入用
```

### 本地表情面板

可视化整理使用回环面板（默认开启）。它只监听 `127.0.0.1` 或 `::1`，所有请求（包括图片）都必须携带长度至少 16 位的 token；不上传素材路径，不提供跨域访问。

```yaml
alemonjs-agent-link:
  modules:
    settings:
      stickers:
        panel:
          enabled: true
          host: '127.0.0.1'
          port: 8787
          # token 留空时首次启动自动生成，写入数据目录的 sticker-panel-token.txt
          token: ''
```

也可以自行设置 `token`（至少 16 位、无空白）；留空时使用自动生成的文件。启动后访问 `http://127.0.0.1:8787/?token=<token>`：可查看列表、按头像/表情分类查看和上传、改名称/标签、从清单移除。面板删除只移除清单、保留原文件，并尝试删除对应 QQ 收藏；“从 QQ 导入”“同步到 QQ”按钮需要 OneBot 已连接，读取失败会直接提示。token 会出现在浏览器地址栏和图片 URL 中，只应在可信的本机浏览器使用；端口冲突或配置无效时只在日志提示，不影响聊天。面板不提供 TLS，不要绑定公网地址。

## 限制和数据

- 原生图片支持 PNG/JPEG/WebP/GIF；QQ 的 animation/GIF 会在本机按间隔抽取最多 3 帧（最长边 768px、单帧 512 KiB）后交给主模型，不是全帧理解，也不做视频理解。解码失败、超大或静态 GIF 回退为原始图片。图片请求总上限 48 MiB（含 base64），仍受单附件大小与数量限制。旧 vision 配置保留兼容，但默认聊天不调用独立识图服务；独立识图路径仍只支持静态图。
- 转写支持检测到的 MP3/WAV/OGG/M4A/WebM/FLAC。SILK/AMR 需要适配器提供转码音频或 Transcript；不会改扩展名伪装格式。
- 附件域名默认全部允许（省略 `allowedHosts` 或设置 `[]`）；非空列表则仅允许列出的精确域名。附件仍须使用 HTTPS 默认端口和公网 DNS 地址，拒绝带用户名密码的 URL、重定向和内网地址；下载连接固定已验证地址。
- 带图聊天仅在当前轮发送图片；会话历史保存文字和图片占位，不保存 base64。后续需要再次查看图片时须重新发送附件。语音合成文本会发送给配置的 TTS 服务。
- 识图与转写属于排队请求的一部分，复用去重、限流、并发与取消。单次媒体处理默认限时 60 秒，随后进入文字模型自己的请求时限；不是全流程共用一个 60 秒时限。
- 语音回复附带“AI 合成语音”说明。平台接受发送不代表用户已读；已经提交给平台的请求无法撤回。
- 代码测试使用模拟模型响应与媒体回执；生产验收仍需实际服务、附件 CDN、素材及 QQ 账号。

---

[← 文档首页](README.md) · [项目主页](../README.md) · [命令速查](commands.md)

## 音色库与额度降级

`media.voices` 保存命名音色，`media.activeVoice` 选择默认音色；未设置时保持原来的 `speech`/`tts` 行为。音色 ID 唯一，最多100项。每个音色的 `speech` 是完整的引擎配置；Breeze、自建引擎等沿用既有必填字段和地址校验。OpenAI 兼容音色用 `ttsVoice` 覆盖已有 `media.tts.voice`，保留供应商地址、模型和凭证。音色ID必须来自所用服务，程序不声称支持任意音色。

```yaml
media:
  activeVoice: local
  voices:
    - id: local
      name: 本机默认音色
      speech:
        engine: system
        fallback: true
    - id: custom
      name: 已配置服务的音色
      ttsVoice: '<服务实际支持的音色ID>'
      speech:
        engine: openai
        fallback: true
```

配置保存后按既有配置重载流程生效；使用主人私聊 `/语音引擎 试听 你好` 试听当前音色。也可以在后台「音色库」管理，操作说明见下节。

开启 `fallback` 时，内部预算明确不足会直接使用本机系统语音；供应商返回 HTTP 402 后，本次回退本机语音，并在当前进程内跳过该服务5分钟。更换同服务音色不会避开冷却；重启清除冷却。不通过付费聊天探测额度，也不切换至另一个付费账号。401、429和网络失败仍按原有失败回退，不伪装成余额不足。关闭 `fallback` 时不擅自换引擎。本机引擎不可用时返回失败，由调用方使用文字回复；不会自动安装组件。此策略只影响已经进入语音合成的请求，不绕过聊天本身的预算准入。

### 音色管理页与供应商诊断

后台「音色库」提供新增、编辑、删除、默认音色选择、持久启停、单项/全部查额度与测活，并可筛选启停和额度不足。配置保存复用版本冲突检查、密钥占位符、备份与框架重载；刷新不会恢复已停用音色。停用当前音色后，允许回退时使用本机引擎，否则拒绝合成。

每项可配置 `balanceUrl: 'https://供应商/余额接口?key={key}'`，沿用额度轮转的余额格式解析（`data.balance`、`total_available` 或 `vouchers[].available`），支持返回的三位币种代码，无币种时沿用 CNY。这不是通用 TTS 标准，需确认供应商实际提供对应接口。仅已用金额、未知值或查询失败不作为余额为零。缓存60秒，手动查询强制刷新；同服务同密钥同查询地址共享余额结果，不汇总音色间重复账号余额。最近60秒明确查到额度耗尽会触发合成降级，不查询也保留原402回退。

`probeUrl` 为供应商明确提供的免费 HTTPS GET 健康地址，不允许凭证、查询参数或重定向，不附加 API Key。没有该地址显示“未配置”，不调用合成接口测活。连通成功不会清除额度不足状态。停用音色仍允许查额度、测活。诊断仅手动触发，未伪造供应商余额支持、自动发现音色或实际合成成功。
