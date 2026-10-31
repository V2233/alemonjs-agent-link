/** Public discovery catalogue, checked 2026-10-31. Entries do not enable a provider. */
export type VoiceResource = {
  id: string;
  name: string;
  region: '国内' | '海外' | '自部署';
  registration: string;
  url: string;
  docs: string;
  note: string;
  integration: string;
  voices?: { name: string; id: string }[];
};

export const voiceResources: VoiceResource[] = [
  {
    id: 'fish-dafeiyu',
    name: 'Fish Audio · 蓝色大肥鱼线索',
    region: '海外',
    registration: '需要注册、API Key；额度以账户为准',
    url: 'https://fish.audio/',
    docs: 'https://github.com/zbsdsb/dafeiyu-ai-vtuber/blob/dafeiyu/config.json',
    note: '项目 README 声明使用「蓝色大肥鱼」，配置中的 reference_id 为 fe50cdf3040449298470d58ff0991e1d。音色页当前无法公开核验，名称、权限及可用性需登录确认；不是官方授权声库的证明。',
    integration: '已接入 fish 引擎：服务地址 https://api.fish.audio，填写本人 API Key、模型和 reference_id；保存后试听。尚未完成真实账户合成验证。'
  },
  {
    id: 'siliconflow',
    name: '硅基流动 · CosyVoice / 自定义音色',
    region: '国内',
    registration: '需要注册、API Key；自定义音色需要实名',
    url: 'https://cloud.siliconflow.cn/',
    docs: 'https://docs.siliconflow.cn/docs/userguide/capabilities/text-to-speech',
    note: '内置 claire（温柔女声）、diana（欢快女声）、anna（沉稳女声）可作陪伴声音候选，并非已证实的大肥鱼同款。支持上传参考音频取得自定义 voice URI。',
    integration:
      '可用现有 openai 引擎；先设置共享 media.tts：baseUrl=https://api.siliconflow.cn/v1，model=FunAudioLLM/CosyVoice2-0.5B，并填本人 Key。模型权限以控制台为准。',
    voices: [
      { name: 'CosyVoice 温柔女声 claire', id: 'FunAudioLLM/CosyVoice2-0.5B:claire' },
      { name: 'CosyVoice 欢快女声 diana', id: 'FunAudioLLM/CosyVoice2-0.5B:diana' },
      { name: 'CosyVoice 沉稳女声 anna', id: 'FunAudioLLM/CosyVoice2-0.5B:anna' }
    ]
  },
  {
    id: 'minimax',
    name: 'MiniMax 语音',
    region: '国内',
    registration: '需要注册、API Key、开通额度',
    url: 'https://www.minimaxi.com/audio',
    docs: 'https://solutions.minimaxi.com/',
    note: '语音生成、音色管理与复刻；可在平台选择中文声音或创建自定义声音。未确认大肥鱼专属音色。',
    integration: '待适配 MiniMax 原生 API。'
  },
  {
    id: 'bailian',
    name: '阿里云百炼 · Qwen TTS / CosyVoice',
    region: '国内',
    registration: '需要阿里云账号、开通服务与 API Key',
    url: 'https://bailian.console.aliyun.com/',
    docs: 'https://help.aliyun.cn/zh/model-studio/tts-model',
    note: '提供语音合成、音色复刻/设计；模型、地域和音色支持以文档为准。',
    integration: '待适配百炼 API；现有 cosyvoice 引擎是自部署 inference_sft，不能直接用于百炼。'
  },
  {
    id: 'volcengine',
    name: '火山引擎 · 豆包语音',
    region: '国内',
    registration: '需要注册、开通服务与鉴权配置',
    url: 'https://www.volcengine.com/',
    docs: 'https://docs.volcengine.com/docs/doubao-voice/sdk-overview?lang=zh',
    note: 'TTS、声音复刻及流式合成；未确认大肥鱼专属音色。',
    integration: '待适配火山语音 API/鉴权。'
  },
  {
    id: 'tencent',
    name: '腾讯云语音合成',
    region: '国内',
    registration: '需要腾讯云账号、开通服务与密钥',
    url: 'https://cloud.tencent.com/product/tts',
    docs: 'https://cloud.tencent.com/document/api/1073/127845',
    note: '短文本、长文本等合成接口；按官方音色表选择。',
    integration: '待适配腾讯云签名和响应格式。'
  },
  {
    id: 'xfyun',
    name: '讯飞在线语音合成',
    region: '国内',
    registration: '需要注册、创建应用并获取鉴权信息',
    url: 'https://www.xfyun.cn/services/online_tts',
    docs: 'https://static.xfyun.cn/doc/',
    note: '中文、多语种及方言发音人；部分声音需要单独开通。',
    integration: '待适配讯飞鉴权及 WebSocket 协议。'
  },
  {
    id: 'baidu',
    name: '百度语音合成',
    region: '国内',
    registration: '需要百度智能云账号、开通服务与鉴权',
    url: 'https://ai.baidu.com/tech/speech/chatbot',
    docs: 'https://ai.baidu.com/tech/speech/chatbot',
    note: '大模型语音合成与多场景声音服务。',
    integration: '待适配百度原生 API。'
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    region: '海外',
    registration: '需要注册、API Key；克隆权限依套餐',
    url: 'https://elevenlabs.io/',
    docs: 'https://elevenlabs.io/text-to-speech-api',
    note: '多语言语音合成、音色库及声音克隆；未确认大肥鱼同款。',
    integration: '现有 breeze 使用相似请求结构，但尚未对官方接口完成合成验证；暂作待验证服务收录。'
  },
  {
    id: 'cartesia',
    name: 'Cartesia Sonic',
    region: '海外',
    registration: '需要注册、API Key',
    url: 'https://www.cartesia.ai/product/speech-synthesis',
    docs: 'https://www.cartesia.ai/product/speech-synthesis',
    note: '面向实时语音应用的合成，可在 Playground 试听。',
    integration: '待适配 Cartesia 原生 API。'
  },
  {
    id: 'azure',
    name: 'Microsoft Azure Speech',
    region: '海外',
    registration: '需要 Azure 账号、Speech 资源与密钥',
    url: 'https://azure.microsoft.com/products/ai-services/ai-speech',
    docs: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech',
    note: '神经网络声音与自定义声音；Azure 服务与当前 Edge TTS 是不同接入方式。',
    integration: '待适配 Azure API；不要把 Azure Key 填到 Edge 音色中。'
  },
  {
    id: 'google',
    name: 'Google Cloud Text-to-Speech',
    region: '海外',
    registration: '需要 Google Cloud 项目、启用 API 与鉴权/计费配置',
    url: 'https://cloud.google.com/text-to-speech',
    docs: 'https://cloud.google.com/text-to-speech',
    note: '多语言、多种声音系列，官网有试听入口。',
    integration: '待适配 Google Cloud API。'
  },
  {
    id: 'polly',
    name: 'Amazon Polly',
    region: '海外',
    registration: '需要 AWS 账号及 IAM 权限',
    url: 'https://aws.amazon.com/polly/',
    docs: 'https://aws.amazon.com/polly/',
    note: '多语言语音合成，声音、引擎及区域需配套选择。',
    integration: '待适配 AWS 签名与 Polly API。'
  },
  {
    id: 'gptsovits',
    name: 'GPT-SoVITS',
    region: '自部署',
    registration: '本地推理无需云服务账号；模型下载站可能要求账号',
    url: 'https://github.com/RVC-Boss/GPT-SoVITS',
    docs: 'https://github.com/RVC-Boss/GPT-SoVITS',
    note: '可用参考音频和模型构建专属声音；需自行准备获授权素材，未核验可直接下载的大肥鱼官方模型。',
    integration: '已有 gptsovits 引擎；需部署兼容 /tts 的服务并填写服务端参考音频路径。'
  },
  {
    id: 'cosyvoice',
    name: 'CosyVoice 自部署',
    region: '自部署',
    registration: '本地推理无需云服务账号；模型下载站可能要求账号',
    url: 'https://github.com/QwenAudio/CosyVoice',
    docs: 'https://github.com/QwenAudio/CosyVoice',
    note: '多语言合成、声音复刻及部署工具；不同版本支持能力需核对。',
    integration: '已有 cosyvoice 引擎仅调用 /inference_sft；零样本克隆需要额外适配，不能直接填参考音频冒充已支持。'
  }
];
