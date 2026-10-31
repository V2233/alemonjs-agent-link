# 国内外语音合成资源库

核查日期：2026-10-31。管理面板「音色库」的「服务资源」页签可查看资源库，搜索服务和接入方式、打开注册/文档地址。收录 15 项，含需注册的服务。公开资料核查不代表真实账号合成测试；免费额度、区域、实名和套餐限制以平台当前要求为准。

## 大肥鱼音色线索

[大肥鱼虚拟主播项目](https://github.com/zbsdsb/dafeiyu-ai-vtuber) 的 README 声明使用 Fish Audio「蓝色大肥鱼」。其[配置源码](https://github.com/zbsdsb/dafeiyu-ai-vtuber/blob/dafeiyu/config.json) 设置 `reference_id=fe50cdf3040449298470d58ff0991e1d`。

- [Fish Audio 注册 / 官网](https://fish.audio/)
- [音色候选直达地址](https://fish.audio/m/fe50cdf3040449298470d58ff0991e1d/)：本次无法公开读取确认，登录后核对名称、预览、可见性和使用权限；不能视作已经验证的可用音色。
- [Fish API 文档](https://docs.fish.audio/)

这条证据来自使用该声音的项目，不是声音作者的授权声明，也不能证明它是所有“大肥鱼”视频的同款。当前项目已适配 Fish 原生 API，音色库选择 `fish`，填写服务根地址、Key、模型及 reference_id，详见 [接入指南](media-setup.md)。不能把 reference_id 填入共享 OpenAI 接口便宣称接通。未下载、上传、克隆声音或产生付费合成请求。

## 服务地址与接入边界

| 服务             | 注册 / 官网                                                        | 文档 / 证据                                                                               | 当前接入情况                                                       |
| ---------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Fish Audio       | [官网](https://fish.audio/)                                        | [文档](https://docs.fish.audio/)                                                          | 需注册和 Key；已适配 fish 引擎，待真实账户验证                     |
| 硅基流动         | [控制台](https://cloud.siliconflow.cn/)                            | [语音合成](https://docs.siliconflow.cn/docs/userguide/capabilities/text-to-speech)        | 需注册和 Key；现有 OpenAI 兼容引擎可配置；自定义音色要求实名       |
| MiniMax          | [语音官网](https://www.minimaxi.com/audio)                         | [调试台](https://solutions.minimaxi.com/)                                                 | 需账号和 Key；待适配                                               |
| 阿里云百炼       | [控制台](https://bailian.console.aliyun.com/)                      | [合成文档](https://help.aliyun.cn/zh/model-studio/tts-model)                              | 需账号和开通服务；待适配，与自部署 cosyvoice 不同                  |
| 火山引擎豆包语音 | [官网](https://www.volcengine.com/)                                | [语音 SDK](https://docs.volcengine.com/docs/doubao-voice/sdk-overview?lang=zh)            | 需账号和服务鉴权；待适配                                           |
| 腾讯云           | [语音合成](https://cloud.tencent.com/product/tts)                  | [API 概览](https://cloud.tencent.com/document/api/1073/127845)                            | 需账号和服务密钥；待适配                                           |
| 讯飞             | [在线合成](https://www.xfyun.cn/services/online_tts)               | [文档中心](https://static.xfyun.cn/doc/)                                                  | 需注册应用；待适配                                                 |
| 百度             | [语音服务](https://ai.baidu.com/tech/speech/chatbot)               | [官方产品说明](https://ai.baidu.com/tech/speech/chatbot)                                  | 需账号和开通服务；待适配                                           |
| ElevenLabs       | [官网](https://elevenlabs.io/)                                     | [TTS API](https://elevenlabs.io/text-to-speech-api)                                       | 需注册和 Key；breeze 请求形状相似，尚未验证官方接口合成            |
| Cartesia         | [Sonic](https://www.cartesia.ai/product/speech-synthesis)          | [产品与 API 入口](https://www.cartesia.ai/product/speech-synthesis)                       | 需注册和 Key；待适配                                               |
| Azure Speech     | [官网](https://azure.microsoft.com/products/ai-services/ai-speech) | [文档](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech) | 需账号和 Speech 资源；待适配，与 Edge TTS 不同                     |
| Google Cloud     | [TTS](https://cloud.google.com/text-to-speech)                     | [产品与文档入口](https://cloud.google.com/text-to-speech)                                 | 需项目、API 和鉴权/计费配置；待适配                                |
| Amazon Polly     | [官网](https://aws.amazon.com/polly/)                              | [产品与开发入口](https://aws.amazon.com/polly/)                                           | 需 AWS 账号和 IAM 权限；待适配                                     |
| GPT-SoVITS       | [源码 / 部署](https://github.com/RVC-Boss/GPT-SoVITS)              | [官方仓库](https://github.com/RVC-Boss/GPT-SoVITS)                                        | 本地推理无需云账号；已有 /tts 引擎，需自备模型和参考音频           |
| CosyVoice        | [源码 / 部署](https://github.com/QwenAudio/CosyVoice)              | [官方仓库](https://github.com/QwenAudio/CosyVoice)                                        | 本地推理无需云账号；已有 /inference_sft 引擎，未支持零样本克隆接口 |

## 可配置的陪伴女声候选

硅基流动官方文档列出了 claire（温柔）、diana（欢快）、anna（沉稳）。这是按描述筛选的候选，未进行听感比较，也没有证据证明是大肥鱼同款。

1. 在现有配置中设置 `media.tts`：`baseUrl` 为 `https://api.siliconflow.cn/v1`，`model` 为 `FunAudioLLM/CosyVoice2-0.5B`，`apiKey` 填本人密钥。先确认控制台仍提供该模型及调用权限。
2. 在资源库点击对应「添加」按钮，补充唯一音色 ID 后保存。模板默认禁止失败降级，便于发现配置问题。
3. 试听成功后再选择默认音色。试听会使用供应商额度。

共享 `media.tts` 决定所有 OpenAI 兼容音色使用的供应商和模型；模板只填写 `ttsVoice`，不会切换共享服务。修改共享服务会影响其他 OpenAI 兼容音色，需一并核对。
