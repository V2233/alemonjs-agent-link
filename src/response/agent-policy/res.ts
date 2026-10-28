import { Format, useEvent, useMessage, useRoute } from 'alemonjs';
import { getDSHConfig } from '@src/dsh/client';
import { SessionRegistry } from '@src/state/registry';
import { resetGroupSession } from '@src/dsh/orchestrator';

export default async (): Promise<void> => {
  const [eventContext] = useEvent({ selects: ['message.create', 'private.message.create'] });
  const [route] = useRoute();
  const [message] = useMessage();

  if (!eventContext.match.selects || !route.matched) {
    return;
  }
  const event = eventContext.current;

  if (event.IsPrivate) {
    await message.send({ format: Format.create().addText('请到需要管理的目标群里使用 /工具策略。') });

    return;
  }

  if (!event.ChannelId || !event.IsMaster) {
    await message.send({ format: Format.create().addText('只有机器人主人可在群内管理 Agent 策略。') });

    return;
  }
  try {
    const registry = new SessionRegistry(getDSHConfig());
    const capabilityNames: Record<string, string> = { chat: '聊天', web: '网页', files: '文件', terminal: '终端' };
    const aliases: Record<string, string> = { 状态: 'status', 聊天: 'chat', 网页: 'web', 文件: 'files', 终端: 'terminal' };
    const rawRequested = String(route.rawArgs[0] || 'status').toLowerCase();
    const requested = aliases[rawRequested] || rawRequested;

    if (requested === 'status') {
      const policy = await registry.policy(event.ChannelId);

      await message.send({
        format: Format.create().addText(
          `本群权限：聊天${policy.chat ? '开' : '关'} · 网页${policy.web ? '开' : '关'} · 文件${policy.files ? '开' : '关'}\n终端禁止；/工具策略 能力 开启或关闭`
        )
      });

      return;
    }
    const rawEnabled = String(route.rawArgs[1] || '').toLowerCase();
    const enabled = rawEnabled === '开启' ? 'on' : rawEnabled === '关闭' ? 'off' : rawEnabled;

    if (!['chat', 'web', 'files', 'terminal'].includes(requested) || !['on', 'off'].includes(enabled)) {
      await message.send({ format: Format.create().addText('用法：/工具策略 状态，或 /工具策略 聊天|网页|文件 开启|关闭') });

      return;
    }
    if (requested === 'terminal') {
      await message.send({ format: Format.create().addText('终端禁止。文件操作仅限本群隔离目录。') });

      return;
    }
    const policy = await registry.policy(event.ChannelId);

    await registry.setPolicy(event.ChannelId, { ...policy, [requested]: enabled === 'on' });
    await resetGroupSession(event.ChannelId, getDSHConfig());
    await message.send({
      format: Format.create().addText(`本群${capabilityNames[requested]}已${enabled === 'on' ? '开启' : '关闭'}，已开始新话题。`)
    });
  } catch {
    await message.send({ format: Format.create().addText('策略暂时无法读取，请稍后再试。') });
  }
};
