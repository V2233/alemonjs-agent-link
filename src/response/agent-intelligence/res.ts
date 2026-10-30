import { useEvent, useMessage, useRoute } from 'alemonjs';
import { getDSHConfig } from '../../dsh/runtime-config';
import { verifyGroupKeyAdmin } from '../../credentials/group-admin';
import { getConversationId } from '../dsh/util';
import { commandBubble } from '../bubble';
import { intelligenceLevels, resolveIntelligenceAccess, readIntelligenceLevel, saveIntelligenceLevel } from '../../agent/intelligence';

export default async (): Promise<void> => {
  const [context] = useEvent({ selects: ['message.create', 'private.message.create'] });
  const [route] = useRoute();
  const [message] = useMessage();

  if (!context.match.selects || !route.matched) return;
  const event = context.current;
  const identity = {
    platform: event.Platform || '',
    channelId: getConversationId(event),
    userId: event.UserId || '',
    owner: Boolean(event.IsMaster),
    private: Boolean(event.IsPrivate),
    admin: !event.IsPrivate && (await verifyGroupKeyAdmin(event))
  };
  const config = getDSHConfig();
  let text: string;

  try {
    const value = route.rawArgs.map(String).join(' ').trim();

    if (route.key !== '我的权限' && value && value !== '状态') await saveIntelligenceLevel(config, identity, value);
    const access = await resolveIntelligenceAccess(identity, config);
    const level = readIntelligenceLevel(config, identity, access.entitled) || access.defaultLevel;

    text = `身份：${identity.owner ? '机器人主人' : identity.admin ? '群管理员' : access.bound && identity.private ? '密钥主人' : '普通用户'}\n当前智能程度：${level} · ${identity.private ? '本人私聊' : '本群'}\n${access.bound ? '费用使用当前会话授权 Key。' : '使用默认服务额度。'}\n智能程度调节多步工具执行预算，仍受服务上限约束。\n机器人主人：全局管理，私聊可用终端。\n密钥主人：管理自己的 Key、授权及私聊人设。\n群管理员：管理本群；本群启用 Key 权益后可调智能程度和人设。\n普通用户：使用默认服务；私聊绑定 Key 可解锁专属设置。`;
    await message.send({
      format: commandBubble(text, '智能程度与权益', {
        platform: event.Platform,
        actions: access.canEdit
          ? [...intelligenceLevels.map(label => ({ label, command: `/智能程度 ${label}` })), { label: '恢复默认', command: '/智能程度 默认' }]
          : [{ label: '我的钥匙', command: '/我的钥匙' }]
      })
    });
  } catch (error) {
    await message.send({ format: commandBubble(error instanceof Error ? error.message : '设置失败', '智能程度', { platform: event.Platform }) });
  }
};
