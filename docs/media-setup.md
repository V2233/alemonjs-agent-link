# 语音、看图与生图接入

核查日期：2026-10-31。复用外部推理服务，机器人负责协议适配和平台发送；无需安装另一套 QQ 接入插件。

## 大肥鱼声音的证据与 Fish 配置

公开的 [dafeiyu-ai-vtuber](https://github.com/zbsdsb/dafeiyu-ai-vtuber) 声明采用 Fish Audio 的「蓝色大肥鱼」。这只证明该作者的方案，不能代表所有热门视频。增强桌宠 [better-dsh-pet](https://github.com/ysppwn721/better-dsh-pet) 则使用 SenseVoice 识别语音。音色和识别模型是两件事。

本项目已支持 Fish 原生 [POST /v1/tts](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)，可在音色库选择 `fish`，填写服务根地址、本人 API Key、模型、音色 reference_id 后保存和试听。模型名通过 `model` 请求头传递，音色通过 `reference_id` 传递。选择默认音色后，现有语音回复和主动语音策略继续适用。尚未选择音色时不要设置为默认。

以下均为配置片段，合并至已有 `alemonjs-agent-link.media`，不要覆盖整个配置；占位符需替换为控制台实际值：

```yaml
speech:
  engine: fish
  url: https://api.fish.audio
  apiKey: YOUR_FISH_API_KEY
  model: YOUR_FISH_MODEL
  voiceId: YOUR_REFERENCE_ID
  fallback: false
```

若已经有 `activeVoice`，它会优先使用音色库对应项的 `speech`，直接修改上述全局字段不会覆盖所选音色。请通过音色库维护。首次试听关闭降级，避免失败后播放系统声而误认为 Fish 成功。

## 语音识别

复用 [硅基流动 SenseVoice API](https://docs.siliconflow.cn/docs/api/audio-transcriptions-post)，上传真实音频，返回 `text`。本项目 `siliconflow` 协议只发送文档要求的 `file`、`model`，不附加 OpenAI 的 `response_format`。

```yaml
asr:
  protocol: siliconflow
  baseUrl: https://api.siliconflow.cn/v1
  apiKey: YOUR_SILICONFLOW_API_KEY
  model: FunAudioLLM/SenseVoiceSmall
```

平台已有 Transcript 时直接复用。否则需要有效音频地址或 OneBot 适配器转换后的 WAV；SILK/AMR 不能直接当 MP3 上传。现有 `scripts/local_asr_server.py` 是可选 faster-whisper 服务，只接收最长 60 秒、单声道 16 kHz PCM16 WAV，主要用于视频音频片段；它不等同于通用 QQ 音频解码服务。

## 生图

硅基流动的 [图像 API](https://docs.siliconflow.cn/docs/api/images-generations-post) 使用 `image_size`，返回 `images[].url`；不能把 OpenAI 的 `size/n/response_format` 原样发送。选择生图库中的「硅基流动」请求协议：

```yaml
imageGen:
  protocol: siliconflow
  baseUrl: https://api.siliconflow.cn/v1
  apiKey: YOUR_SILICONFLOW_API_KEY
  model: Kwai-Kolors/Kolors
  size: 1024x1024
  stylePrompt: ''
  ownerOnly: true
```

先确认该模型在本人账户中仍可用。已有 `activeImage` 时同样应在生图库维护所选配置。OpenAI 兼容服务保留 `protocol: openai`，`responseFormat` 可选 `b64_json`（默认）、`url` 或 `auto`（省略参数，适用于不接受该字段的服务）。只支持当前单张文生图流程，不把图像编辑模型当文生图模型使用。

## 视觉理解

优先复用已启用且标记 `vision` 的模型池端点，也可独立设置：

```yaml
vision:
  baseUrl: https://YOUR_VISION_HOST/v1
  apiKey: YOUR_VISION_API_KEY
  model: YOUR_VISION_MODEL
```

独立视觉端点支持本机回环 `http://127.0.0.1:PORT/v1` 且可省略 Key，便于复用本地 OpenAI 兼容多模态服务；远程仍须 HTTPS 和 Key。附件以实际图片输入，不把网页标题或文件名视为识别结果。配置存在不代表模型真正支持看图，需用可预先确定答案的图片测试。

## 验证边界

`test/media-provider-contracts.test.mjs` 验证 Fish 请求、二进制音频、失败不冒充成功，SenseVoice multipart、生图协议与本机视觉输入。模拟 HTTP 测试不代表真实账户额度、模型权限或 QQ 平台投递已通过。真实 Fish、生图及云 ASR 验收还需配置本人有效凭证。

## 音色排序与轮转

音色库打开「按列表顺序轮转」后，`media.voiceRotation: true`，按 `media.voices` 的数组顺序调用；上下移动即时保存。此时 `activeVoice` 不参与首选选择。停用音色跳过；系统语音总开关关闭时也跳过库内系统音色。

每项「失败后继续下一项」控制失败或额度不足后是否继续。关闭时即停止轮转，后续项及本机兜底不会执行，页面标记为不可达。全部允许的候选均失败后，仅在本机语音和本机降级均开启时尝试系统语音兜底；仍失败交回文字回复。不会暗中插入额外 Edge 候选；需要 Edge 时将它作为库内候选排序。

整条链共用 `media.timeoutMs`，按候选数为单项分配超时，取消会终止整条链。单项试听禁止轮转与自动降级，以免试听其他声音却误以为所选音色已成功。关闭轮转时恢复原有默认音色及引擎降级行为。

## 普通视频附件、网页与 URL

普通聊天现在可接收平台标记的 `video`，以及标记为 `video/mp4` 或文件名为 `.mp4` 的文件附件；实际内容仍须通过 MP4 字节与解码校验。下载沿用公网地址校验、大小限制和取消信号，不把远程 URL 直接交给 FFmpeg。

依赖本机 FFmpeg 与 ffprobe，视频最长 10 分钟，大小同时受 `media.maxBytes`（默认 10 MiB）与 25 MiB 上限约束。在时长的约 15%、50%、85% 处抽取至多三张画面，再交给现有图片输入链路。它是静帧采样理解，不是完整逐帧观看，也不含音轨转写；B 站仍使用既有字幕、音频片段和画面工具。缺组件或解码失败会明确说明，不能将视频标题当作视频内容。ffprobe 元数据查询采用 [官方 show_entries 接口](https://ffmpeg.org/ffprobe.html)。

新增 `inspect_links` 只识别 URL 类型，不主动打开；`read_public_url` 在网页权限开启、用户发起的任务中读取公开 HTTPS 正文，每轮最多三次。它复用现有公网下载、重定向检查和 HTML 解析，不读取本机、内网或登录态。后缀分类不代表媒体内容已经识别；需要登录、验证或动态渲染的页面会返回不可用状态。

网站评论继续使用现有站点专用模块。B 站评论需要主人本轮明确要求、有效登录态，并沿用预览、频率限制及重复提交防护；没有为任意网站增加通用自动评论，也没有在本次验证中发布评论。

## 能力状态与生视频预留

`media_capabilities` 返回语音转写、合成、视觉、生图、视频采样及生视频的状态，不返回供应商地址、密钥、Cookie 或本机路径。配置存在只代表可尝试调用，不代表账号额度、网络或平台投递成功。

按本轮选择，生视频入口保留为 `videoGeneration: { status: 'reserved', enabled: false }`，没有生成工具、没有自动付费提交。选定供应商后再接入提交、任务查询、失败／取消及平台交付流程。当前没有独立 ASR 时只能复用平台转写；未配置生图服务时不会把普通绘图或 HTML 当成 AI 生图成功。

## 普通聊天的视觉路由

普通图片和视频采样帧同样遵守独立 `media.vision` 优先：先仅发送当前输入给该视觉服务，再将观察结果作为引用资料交给聊天模型。私聊历史及模块上下文在此之后加入，不随该次视觉请求发送。视觉服务失败或输出截断时中止，不悄悄把图片交给文字模型。

没有独立视觉配置时，原有图片字节输入与模型池 `vision` 用途选择保持不变。能力查询会区分独立视觉、模型池视觉和主模型视觉未确认；仅安装 FFmpeg／ffprobe 不再直接标记视频理解就绪。

### DSH 插件生图兜底

`media.dshImageFallback: true` 启用“生图库服务 → dsh-image-gen → 简单绘制”链路。
插件固定为 `dsh-image-gen@0.10.0`，使用所选生图库配置；智谱地址走插件原生智谱接入，其他地址走插件的 OpenAI Compatible 接入。
相同供应商故障时，插件也可能失败；这不是独立供应商容灾。

插件在专用媒体 SDK 中调用，不加入群聊工作区插件列表，不要求聊天用户获得文件或终端权限。
启动及配置重载时异步准备项目的 Python SDK 及专用插件缓存；安装禁用生命周期脚本，执行前校验固定入口哈希。相同运行配置只启动一个准备任务，失败后有重试冷却；停用或卸载时取消后台任务。
聊天请求只校验已有安装，不等待下载。插件未就绪时启动后台准备并允许本轮简单绘制兜底。`media_capabilities` 的 `dshImagePlugin` 返回 idle、preparing、ready 或 failed，ready 只表示插件安装就绪，不代表供应商调用或平台投递成功。
每次生成使用独立临时目录，macOS 使用 sandbox-exec，Linux 需要 bwrap；不支持沙箱的环境不启动插件。
插件收到的只有本次图片提示词和当前生图配置，不提供机器人框架配置文件或聊天历史。
生成附件校验哈希、体积及格式后进入原有回复队列，临时目录随后清理；取消会终止整个调用进程组。
外部服务和插件均失败后，模型可按原需求调用一次 draw_image，并明确说明降级为简单绘制。发送失败不会触发重新生成。

### 工作区白名单插件的后台准备

Bridge 启动后，后台预取白名单中审核过的精确版本。整个列表都在审核目录内时，再调用 DSH 原生安装命令检查兼容性；禁用安装脚本，不向安装进程传递模型密钥。原生安装通过后，在当前 Bridge 进程内保留已校验的包字节。

准备就绪后，新 Worker 会重新核验包并创建独立插件副本，不重复联网或运行安装命令。审核包不得包含额外运行依赖、链接或路径穿越，且限制解压体积；各会话不共享可写插件目录。运行时文件、版本列表或审核摘要变化后，不复用旧的准备结果。权限不足或清空白名单时，先清理旧插件配置。

此快捷路径仅覆盖整个列表均已审核且后台原生安装成功的情况。后台尚未完成、失败或含管理员自行选择的其他包时，仍走原有原生安装流程，因此首次请求仍可能等待。Bridge 重启后重新进行后台原生检查；安装就绪不代表插件功能或平台交付已验证。

同一运行时和审核列表的后台、前台准备共用安装锁，等待中的请求会复用先完成的结果。原生安装失败后冷却 30 秒，到期由后续请求重试；前台重试成功也会发布可复用结果。安装期间运行时或审核摘要变化时拒绝发布并清理本次配置，避免新会话使用过期检查结果。
