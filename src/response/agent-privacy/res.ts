import { Format, useEvent, useMessage } from 'alemonjs';

const privacyText = [
  '# 数据与隐私',
  '',
  '## 什么会发给 Agent',
  '- 群聊通过 `@机器人 问题` 或 `/chat 问题` 创建对话；开放的私聊默认也会响应普通文字。',
  '- 普通群消息会在 Redis 中短时保留为参考，默认 15 分钟；它们不会单独创建 Agent 回合。',
  '- `/agentcontext` 可预览下一次会参考的压缩摘要。',
  '',
  '- 纯聊天私聊默认在 Redis 保存最近 10 轮问答，最多 24 小时，按平台和用户隔离。',
  '## 如何清理',
  '- 私聊 `/new`：清空自己的会话与短期记忆。',
  '- `/agentcontext clear`：管理员或主人清除短时参考，正式会话仍保留。',
  '- `/new`：管理员或主人开始新的群会话，并清除短时参考。',
  '- `/agentpurge`：仅主人可在群内发起彻底删除；需要再次发送确认命令。',
  '- 无活动群数据默认在 30 天后清理。',
  '',
  '## 凭证',
  '- 模型凭证仅由机器人主人在私聊中管理，机器人不会回显密钥。'
].join('\n');

export default async (): Promise<void> => {
  const [eventContext] = useEvent({ selects: ['message.create', 'private.message.create'] });

  if (!eventContext.match.selects) {
    return;
  }

  const [message] = useMessage();

  await message.send({ format: Format.create().addMarkdownOriginal(privacyText) });
};
