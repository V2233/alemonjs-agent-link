# 图片、语音与表情包

图片默认直接交给 DSH 当前配置的模型，复用其模型 ID、接口和凭证，无需另配 vision。SDK 模式发送 ACP text/image 内容块，纯聊天模式发送 image_url 内容块；图片字节真正进入模型输入。实际识别能力取决于所配置模型和服务。ASR/TTS 仍采用独立的 OpenAI-compatible HTTP 接口。

## 使用

- 私聊直接发送图片或语音；群聊通过 @、称呼或 `/chat` 携带附件触发。普通未唤醒的群附件不会调用媒体模型。
- `/语音 问题`：用 AI 合成语音回答。合成失败、音频发送失败或回复太长时，回退文字；取消后不再发送缓存回复。
- `/表情`：查看已配置素材；`/表情 开心`：按精确标签或编号发送。每次最多一个，默认同一会话间隔 30 秒。
- 语音缺少 Transcript 且未配置 ASR，或输入类型不支持时，直接回复：**看不懂，就当是夸我了**。不启动模型或 Worker，也不会向普通用户发送配置指导。平台已提供 Transcript 的语音无需另外调用 ASR。
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

只填写接口前缀，ASR/TTS 分别追加 `audio/transcriptions`、`audio/speech`。服务需使用 HTTPS 且兼容以下请求/响应格式：

| 能力 | 请求                                                                  | 响应                              |
| ---- | --------------------------------------------------------------------- | --------------------------------- |
| 识图 | JSON `model/messages`，用户 content 包含 `text` 与 base64 `image_url` | `choices[0].message.content` 文本 |
| 转写 | multipart `file/model/response_format=json`                           | `text` 文本                       |
| 合成 | JSON `model/voice/input/response_format=mp3`                          | MP3 二进制                        |

兼容格式参考官方文档：[图片输入](https://developers.openai.com/api/docs/guides/images-vision)、[语音转写](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)、[语音合成](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)。不兼容这些协议的服务需要另加 provider 适配，不能仅改 URL 就保证可用。

## 素材目录

主人自行放入有权使用的图片，并创建 `manifest.json`：

```json
[
  { "id": "happy", "file": "happy.png", "tags": ["开心", "高兴"] },
  { "id": "comfort", "file": "comfort.gif", "tags": ["安慰", "抱抱"] }
]
```

最多 100 项；id 唯一，每项最多 10 个标签。支持 PNG/JPEG/WebP/GIF。文件须真实存在于该目录内，不能通过 `../` 或外部符号链接读取目录之外的文件。插件不自带第三方表情素材，不会自动收集群成员图片。
发送使用 AlemonJS `useMedia.send`，验证平台回执；平台不支持时报告失败，不把“调用过发送”算成已送达。失败发送也保留冷却，避免连续刷请求。

## 限制和数据

- 原生图片支持 PNG/JPEG/WebP/GIF；不承诺 GIF 全帧理解，不做视频理解。图片请求总上限 48 MiB（含 base64），仍受单附件大小与数量限制。旧 vision 配置保留兼容，但默认聊天不调用独立识图服务。
- 转写支持检测到的 MP3/WAV/OGG/M4A/WebM/FLAC。SILK/AMR 需要适配器提供转码音频或 Transcript；不会改扩展名伪装格式。
- 附件域名默认全部允许（省略 `allowedHosts` 或设置 `[]`）；非空列表则仅允许列出的精确域名。附件仍须使用 HTTPS 默认端口和公网 DNS 地址，拒绝带用户名密码的 URL、重定向和内网地址；下载连接固定已验证地址。
- SDK 模式由 DSH 保存图片附件及会话引用；遵循 DSH 的附件保留机制。纯聊天模式仅在当前轮发送图片，Redis 历史保存文字和图片占位，不保存 base64。语音合成文本会发送给配置的 TTS 服务。
- 识图与转写属于排队请求的一部分，复用去重、限流、并发与取消。单次媒体处理默认限时 60 秒，随后进入文字模型自己的请求时限；不是全流程共用一个 60 秒时限。
- 语音回复附带“AI 合成语音”说明。平台接受发送不代表用户已读；已经提交给平台的请求无法撤回。
- 代码测试使用模拟模型响应与媒体回执；生产验收仍需实际服务、附件 CDN、素材及 QQ 账号。
