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

图片复用当前配置的模型 ID、接口和凭证，无需另配 vision。带图聊天使用原生多模态请求，以 base64 image_url 内容块发送图片，避免 DSH 模型目录将图片替换为文字占位。业务工具仍可使用，工作区操作仍通过沙箱工具执行。实际识别能力取决于所配置模型和服务。ASR/TTS 仍采用独立的 OpenAI-compatible HTTP 接口。

## 使用

- 私聊直接发送图片或语音；群聊通过 @、称呼或 `/chat` 携带附件触发。普通未唤醒的群附件不会调用媒体模型。
- OneBot 当前消息的图片或表情带文件标识时，没有 URL，或原 URL 下载失败、返回非图片内容时，可通过 `get_image` 获取 base64、公开 HTTPS URL 或本机缓存文件。文件路径需要在顶层 `onebot.imageDirectory` 指定网关的图片缓存绝对目录；只读取该目录内的图片，默认不读本机路径。原 URL 可用时不额外调用网关；真实网关兼容性仍需验收。
- 引用的 OneBot 图片也支持该回退，限引用消息的前 5 个媒体附件。取图前会再次读取引用消息，核对会话、附件位置和文件标识；接口不可用或核对失败时不猜测图片内容。
- `/语音 问题`：用 AI 合成语音回答。合成失败、音频发送失败或回复太长时，回退文字；取消后不再发送缓存回复。
- `/表情`：查看已配置素材；`/表情 开心`：按精确标签或编号发送。每次最多一个，默认同一会话间隔 30 秒。
- 自动语音和表情默认关闭，可通过 `modules.settings.expression` 开启；短句语音、心情影响、标签选择及回退规则见[人格、心情与自动表达](companion.md)。
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
    stickerCooldownSeconds: 30
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

最多 100 项；id 唯一，每项最多 10 个标签。支持 PNG/JPEG/WebP/GIF。文件须真实存在于该目录内，不能通过 `../` 或外部符号链接读取目录之外的文件。插件不自带第三方表情素材，默认不会自动收集群成员图片。

主人可以私聊发送或引用一张图片，并明确要求“收藏这张图片做表情”。支持图片输入和工具调用的模型可根据实际图片提供标签，结果写入 `managed/` 与现有清单；同一内容重复收藏不会新增一条。当前消息和引用合计必须恰好有一张图片，附件下载仍遵守媒体地址、大小和超时限制。

主人可使用 `/表情` 查到编号，然后在私聊明确要求修改该编号的标签或从清单移除。移除不会删除原始图片文件；收藏中断也可能留下未引用的文件。清单更新使用锁和原子替换，外部程序应避免同时编辑。异常退出后若残留 `.agentlink-sticker.lock`，确认没有其他进程正在修改素材库后再由管理员移除锁文件。素材库仍以现有 `stickerRoot` 和 `manifest.json` 为前提，不会自动创建或覆盖已有清单。

可选择自动收集平台**明确标记为表情**的附件，默认关闭。普通照片不会因为尺寸相近而自动收集。OneBot 的图片段 `sub_type=1`、带 emoji 标识的图片和 `mface` 归类为表情；缺少或无法下载 URL 时，可按原消息的文件标识使用 `get_image`，本机路径仍受 `imageDirectory` 限制。群范围必须逐群配置，主人私聊也需单独启用：

```yaml
alemonjs-agent-link:
  modules:
    settings:
      stickers:
        autoCollect: true
        autoOwnerPrivate: true
        autoGroups:
          - 'onebot:<群号>'
        autoLabel: false
        autoMaxPerHour: 20
```

使用既有 `media.stickerRoot`、`manifest.json` 和附件下载规则。后台队列串行处理，最多等待 8 个附件，每条消息最多接收 3 个；每小时尝试上限和事件去重在当前进程内生效，重启后重置，素材本身仍按内容去重。超过上限或队列满的附件跳过，不阻塞聊天。关闭 AI 或停用模块时停止收集；配置变更或卸载时取消在途任务。

设置 `autoLabel: true` 并配置 `media.vision` 后，静态图片可由视觉服务生成最多三个标签；未配置服务、GIF、识别失败或预算准入失败时使用“表情”标签。图片会发送给该视觉服务，可能产生服务商费用；目前图片识别费用不计入文本预算，需在服务商侧控制额度。实际 OneBot 附件地址、识别服务与 QQ 收发尚需部署环境验证。
发送使用 AlemonJS `useMedia.send`，验证平台回执；平台不支持时报告失败，不把“调用过发送”算成已送达。失败发送也保留冷却，避免连续刷请求。

## 限制和数据

- 原生图片支持 PNG/JPEG/WebP/GIF；不承诺 GIF 全帧理解，不做视频理解。图片请求总上限 48 MiB（含 base64），仍受单附件大小与数量限制。旧 vision 配置保留兼容，但默认聊天不调用独立识图服务。
- 转写支持检测到的 MP3/WAV/OGG/M4A/WebM/FLAC。SILK/AMR 需要适配器提供转码音频或 Transcript；不会改扩展名伪装格式。
- 附件域名默认全部允许（省略 `allowedHosts` 或设置 `[]`）；非空列表则仅允许列出的精确域名。附件仍须使用 HTTPS 默认端口和公网 DNS 地址，拒绝带用户名密码的 URL、重定向和内网地址；下载连接固定已验证地址。
- 带图聊天仅在当前轮发送图片；会话历史保存文字和图片占位，不保存 base64。后续需要再次查看图片时须重新发送附件。语音合成文本会发送给配置的 TTS 服务。
- 识图与转写属于排队请求的一部分，复用去重、限流、并发与取消。单次媒体处理默认限时 60 秒，随后进入文字模型自己的请求时限；不是全流程共用一个 60 秒时限。
- 语音回复附带“AI 合成语音”说明。平台接受发送不代表用户已读；已经提交给平台的请求无法撤回。
- 代码测试使用模拟模型响应与媒体回执；生产验收仍需实际服务、附件 CDN、素材及 QQ 账号。
