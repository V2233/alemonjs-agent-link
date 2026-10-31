/** Public sources checked 2026-10-31; catalogue entries never enable services. */
export type ImageResource = {
  id: string;
  name: string;
  region: string;
  registration: string;
  url: string;
  docs: string;
  note: string;
  integration: string;
  baseUrl?: string;
};
export const imageResources: ImageResource[] = [
  {
    id: 'siliconflow',
    name: '硅基流动',
    region: '国内',
    registration: '注册账号、API Key；额度以控制台为准',
    url: 'https://cloud.siliconflow.cn/',
    docs: 'https://docs.siliconflow.cn/docs/userguide/capabilities/images',
    note: '提供多个文生图模型，模型清单和参数以官方文档为准。',
    integration: '已适配硅基流动协议（image_size、images[].url）；添加配置后选择「硅基流动」请求协议。需填写有效 Key 和文生图模型，尚未真实账户合成验证。',
    baseUrl: 'https://api.siliconflow.cn/v1'
  },
  {
    id: 'volcengine',
    name: '火山方舟 · 豆包 Seedream',
    region: '国内',
    registration: '注册账号、开通模型并创建 API Key',
    url: 'https://console.volcengine.com/ark',
    docs: 'https://api.volcengine.com/api-docs/view?action=ImageGenerations&serviceCode=ark&version=2024-01-01',
    note: 'Seedream 图像生成与编辑；当前项目只发起单张文生图。',
    integration: '提供 /images/generations；可填写配置候选。需核对模型、尺寸及 b64_json 支持情况，尚未真实合成验证。',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3'
  },
  {
    id: 'bailian',
    name: '阿里云百炼 · 万相 / Qwen Image',
    region: '国内',
    registration: '阿里云账号、开通服务、API Key',
    url: 'https://bailian.console.aliyun.com/',
    docs: 'https://help.aliyun.com/en/model-studio/model-list-image-generation/',
    note: '提供图像生成、编辑等模型，地域和模型权限以控制台为准。',
    integration: '原生图像接口待适配；不能因聊天接口兼容 OpenAI 就直接作为生图配置。'
  },
  {
    id: 'minimax',
    name: 'MiniMax 图像生成',
    region: '国内',
    registration: '注册账号、API Key 和服务额度',
    url: 'https://solutions.minimaxi.com/debug/image',
    docs: 'https://solutions.minimaxi.com/debug/image',
    note: '官方调试台可查看图像生成参数及请求示例。',
    integration: '原生 /v1/image_generation 接口待适配。'
  },
  {
    id: 'bfl',
    name: 'Black Forest Labs · FLUX',
    region: '海外',
    registration: '注册账号、API Key 与额度',
    url: 'https://dashboard.bfl.ai/',
    docs: 'https://help.bfl.ai/articles/8446125349-quickstart-guide',
    note: 'FLUX 系列官方生成接口和 Playground。',
    integration: '原生任务接口及结果轮询待适配。'
  },
  {
    id: 'google',
    name: 'Google · Gemini / Imagen',
    region: '海外',
    registration: 'Google 账号、项目、API Key；区域及计费限制以平台为准',
    url: 'https://aistudio.google.com/',
    docs: 'https://ai.google.dev/gemini-api/docs/imagen',
    note: 'Imagen 文生图；Gemini 另有原生图像生成与编辑能力。',
    integration: '原生生成请求和响应格式待适配。'
  },
  {
    id: 'stability',
    name: 'Stability AI',
    region: '海外',
    registration: '注册账号、API Key 与额度',
    url: 'https://platform.stability.ai/',
    docs: 'https://platform.stability.ai/sandbox/text-to-image',
    note: 'Stable Image / Stable Diffusion 相关图像服务。',
    integration: '原生接口及图片响应待适配。'
  },
  {
    id: 'ideogram',
    name: 'Ideogram',
    region: '海外',
    registration: '注册账号、API Key；API 计费与网页套餐需分别核对',
    url: 'https://ideogram.ai/api-learn/',
    docs: 'https://developer.ideogram.ai/ideogram-api/api-overview',
    note: '提供图像生成、编辑等开发者 API。',
    integration: '原生接口、鉴权及任务结果待适配。'
  },
  {
    id: 'fal',
    name: 'fal.ai',
    region: '海外',
    registration: '注册账号、API Key 与额度',
    url: 'https://fal.ai/',
    docs: 'https://fal.ai/docs/documentation',
    note: '托管多种图像模型，可在 Playground 核对具体模型参数。',
    integration: '模型路由、鉴权及队列接口待适配。'
  },
  {
    id: 'replicate',
    name: 'Replicate',
    region: '海外',
    registration: '注册账号、API Token 与计费配置',
    url: 'https://replicate.com/',
    docs: 'https://replicate.com/docs/topics/predictions/create-a-prediction',
    note: '可调用托管图像模型，参数和输出随具体模型变化。',
    integration: 'Predictions API 和异步结果待适配。'
  }
];
