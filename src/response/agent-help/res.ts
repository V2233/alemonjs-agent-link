import { Format, useEvent, useMessage, useRoute } from 'alemonjs';
import { quotaHelp } from '../../billing/help';

const topics: Record<string, string[]> = {
  聊天: [
    '聊天',
    '群里可以@我，或说“肥鱼，帮我……”。私聊直接说即可。',
    '也可以发送：/提问 你的问题',
    '/取消：取消自己的生成或最后一条排队请求。',
    '/新会话：开始新话题，保留长期记忆和聊天记录；群内需管理员或主人。',
    '/聊天参考：查看本群近期参考；/聊天参考 清除 需管理员或主人。'
  ],
  记忆: [
    '记忆',
    '/记忆（私聊）、/群记忆：查看记忆。',
    '/记忆检索 关键词；/记忆来源 编号：搜索、核对原文。',
    '/记住 内容；/忘记 编号；/忘记全部：管理自己的私聊偏好。',
    '/过时记忆：查看旧版本。',
    '/恢复记忆 编号；/整理记忆；/忘记群记忆 编号或全部：群内需管理员或主人。',
    '修改记忆会开始新话题。聊天记录须另外删除。'
  ],
  人格: [
    '人格与心情',
    '/人格：查看可用人格。',
    '/人格 使用 编号：切换人格，群内需管理员或主人，会开始新话题。',
    '/人格 使用 默认：恢复默认人格。',
    '/心情：查看当前心情。',
    '主人可发送 /人格 程度 工作，切换交流方式；可选个性、工作、专业。',
    '主人私聊可发送 /人格 全局程度 工作，设置全局默认。',
    '主人私聊：/人格 追加 编号 内容；/人格 查看追加 编号；/人格 清空追加 编号。',
    '/人格 查看 编号；/人格 保存 编号 名称|提示词；/人格 删除 编号。'
  ],
  媒体: [
    '图片、语音与表情',
    '可直接发图片、语音，或提出绘图要求；以实际可用能力为准。',
    '/语音 问题：语音回答，不可用时回退文字。',
    '/表情：查看素材；/表情 标签：发送。',
    '主人私聊发送 /语音引擎 状态 查看；需要安装时发送 /语音引擎 安装。',
    '试听示例：/语音引擎 试听 你好'
  ],
  数据: [
    '记录与隐私',
    '/隐私说明：查看数据用途与删除方式。',
    '/新会话：清空短期对话，保留聊天记录与长期记忆。',
    '/清除聊天记录：永久删除当前会话归档，需确认；私聊本人或群内机器人主人可用。',
    '/忘记 编号、/忘记群记忆 编号或全部：分别删除私聊或群记忆。',
    '/清除群数据：主人在目标群彻底清理，需确认。'
  ],
  管理: [
    '主人管理',
    '/关闭 原因；/开启：全局暂停、恢复 AI 请求。',
    '/状态；/模块状态；/额度 帮助：服务、功能与额度。',
    '/模型列表；/当前模型；/当前模型 模型ID：模型及修改指引。',
    '/密钥配置；/移除密钥：公共凭证配置指引，不要在聊天中发送公共密钥。',
    '/工具策略 状态：查看目标群权限。',
    '/工具策略 网页 开启：开启本群网页能力；把网页换成聊天或文件也可设置，用关闭停用。设置后开始新会话。',
    '/主动搭话 开启：订阅自己的私聊主动消息；/主动搭话 关闭：退订。',
    '/主动搭话 状态：查看；/主动搭话 现在：立即尝试。',
    '/主动搭话 暂停 分钟：暂时停用；/主动搭话 恢复：恢复。',
    'OneBot 群管理需白名单及平台权限；请明确指定操作。',
    '首次验证：私聊 /我是主人，到服务端日志取验证码，再发 /我的主人 验证码（5分钟有效，最多5次）。'
  ]
};

export const helpText = (isPrivate: boolean, owner: boolean, topic = ''): string => {
  if (topic === '额度' || topic === '密钥') return quotaHelp(isPrivate);
  if (topic === '管理' && !(isPrivate && owner)) return '管理说明请主人私聊发送 /帮助 管理。';
  if (topic && topic !== '全部') return topics[topic]?.join('\n') || '发送 /帮助 聊天、/帮助 记忆、/帮助 人格、/帮助 媒体、/帮助 数据 或 /帮助 额度。';
  if (topic === '全部')
    return (
      Object.entries(topics)
        .filter(([key]) => key !== '管理' || (isPrivate && owner))
        .map(([, lines]) => lines.join('\n'))
        .join('\n\n') + `\n\n${quotaHelp(isPrivate)}`
    );

  return [
    '大肥鱼使用说明',
    isPrivate ? '直接发消息给我就能聊天，私聊需主人已开放。' : '在群里@我，或说“肥鱼，帮我……”。',
    '发图片、语音，或直接说想画什么。',
    '/新会话：换个话题，保留长期记忆。',
    '/取消：停止自己的请求。',
    isPrivate ? '/记忆：查看记住的内容。' : '/群记忆：查看本群记忆。',
    '/额度：查看剩余。',
    '/帮助 额度：添加密钥、继续使用的教程。',
    '/帮助 人格：切换性格和交流方式。',
    '其他说明：/帮助 聊天、/帮助 记忆、/帮助 媒体、/帮助 数据。',
    isPrivate && owner ? '主人设置：/帮助 管理。' : ''
  ]
    .filter(Boolean)
    .join('\n');
};

export default async (): Promise<void> => {
  const [context, next] = useEvent({ selects: ['message.create', 'private.message.create'] });
  const [route] = useRoute();

  // Shared help commands must remain available to other installed plugins.
  next();
  if (!context.match.selects) return;
  const event = context.current;
  const [message] = useMessage();

  await message.send({
    format: Format.create().addText(helpText(Boolean(event.IsPrivate), Boolean(event.IsMaster), route.rawArgs.join(' ').trim()))
  });
};
