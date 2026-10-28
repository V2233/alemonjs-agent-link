import { commandBubble, sectionBubble } from '../bubble';
import { verifyGroupKeyAdmin } from '../../credentials/group-admin';
import { useEvent, useMessage, useRoute } from 'alemonjs';
import { groupKeyStatus, issueGroupKeyCode, redeemGroupKeyCode, type GroupKeyAction } from '../../credentials/group';
import { groupPolicy } from '../../social/group-settings';
import { getDSHConfig } from '../../dsh/client';
import { getConversationId } from '../dsh/util';
import { DSHError } from '../../dsh/errors';
import { groupKeyGuide } from '../../billing/help';

const actions: Record<string, GroupKeyAction> = { 绑定: 'bind', 启用: 'enable', 开启: 'enable', 停用: 'disable', 关闭: 'disable', 移除: 'remove' };
const labels = { bind: '绑定', enable: '启用', disable: '停用', remove: '移除' } as const;

export default async (): Promise<void> => {
  const [context] = useEvent({ selects: ['message.create', 'private.message.create'] });

  if (!context.match.selects) return;
  const event = context.current;
  const [message] = useMessage();
  const [route] = useRoute();
  const args = route.rawArgs.map(String);
  let text: string;

  try {
    if (!event.IsPrivate) {
      const isAdmin = await verifyGroupKeyAdmin(event);

      if (!isAdmin) throw new DSHError('budget', '平台未确认你是本群管理员，无法管理群 Key。请确认管理员身份或成员查询权限。');
      if (args.length === 0 || (args.length === 1 && args[0] === '状态')) {
        const status = await groupKeyStatus({ platform: event.Platform || '', channelId: event.ChannelId || '' });
        const elevated = status.enabled && groupPolicy(getDSHConfig(), event.ChannelId || '', event.Platform).boundKeyElevation !== false;
        const state = !status.bound ? '未绑定' : status.enabled ? '已启用' : status.reason === 'balance' ? '余额不足，已自动停用' : '已停用';
        const sections = [
          {
            title: '状态',
            text: state,
            actions: status.bound
              ? [
                  status.enabled ? { label: '停用', command: '/群密钥 停用' } : { label: '启用', command: '/群密钥 启用' },
                  { label: '移除', command: '/群密钥 移除' }
                ]
              : [{ label: '申请绑定', command: '/群密钥 绑定' }]
          },
          ...(status.bound
            ? [
                {
                  title: '权益',
                  text: elevated ? '参与更积极；网页与文件自动开放；终端仍禁止，夜间静默照常。' : '已按配置关闭 boundKeyElevation，按普通群策略运行。'
                }
              ]
            : []),
          {
            title: '下一步',
            text: !status.bound
              ? '群主或管理员申请临时码后，由申请人私聊提交 Key。'
              : status.enabled
                ? '充值后如自动停用，在群里申请新的启用码。'
                : status.reason === 'balance'
                  ? '充值后在群里申请新的启用码。'
                  : '可重新启用或移除。',
            actions: [{ label: '额度教程', command: '/帮助 额度' }]
          },
          { title: '更多', text: '', actions: [{ label: '刷新', command: '/群密钥 状态' }] }
        ];

        await message.send({ format: sectionBubble('群密钥', '本群自带 Key 状态。', sections, { platform: event.Platform, layout: 'inline' }) });

        return;
      } else {
        const action = actions[args[0]];

        if (!action || args.length !== 1) throw new DSHError('budget', groupKeyGuide);
        const proof = await issueGroupKeyCode(
          {
            platform: event.Platform || '',
            channelId: event.ChannelId || '',
            userId: event.UserId || '',
            isPrivate: false,
            isAdmin,
            messageId: event.MessageId || ''
          },
          action
        );

        text = `群 Key ${labels[action]}临时码：${proof.code}\n5 分钟有效，仅申请人本人可用，提交一次即失效。\n请本人私聊机器人发送：/群密钥 ${labels[action]} ${proof.code}${action === 'bind' ? ' sk-你的Key' : ''}\n重新申请会使本人在本群的旧码失效。`;
      }
    } else {
      const shorthand = /^[a-f0-9]{24}$/iu.test(args[0] || '');
      const action = shorthand ? 'bind' : actions[args[0]];
      const code = args[shorthand ? 0 : 1];
      const apiKey = action === 'bind' ? args[shorthand ? 1 : 2] : undefined;
      const expected = shorthand ? 2 : action === 'bind' ? 3 : 2;

      if (!action || args.length !== expected) throw new DSHError('budget', groupKeyGuide);
      const result = await redeemGroupKeyCode(
        { platform: event.Platform || '', userId: event.UserId || '', channelId: getConversationId(event) },
        code,
        action,
        apiKey
      );

      text = result.duplicate
        ? '该临时码已处理，不会重复操作。'
        : `群 ${result.channelId} 的 Key 已${labels[action]}。${action === 'bind' || action === 'enable' ? '本群聊天和主动识别优先使用，余额不足时停用并转为群额度模式。' : '后续使用群额度模式。'}`;
    }
  } catch (error) {
    // Only our fixed validation text is public. Never include arguments or provider/storage errors.
    text = error instanceof DSHError ? error.message : '群 Key 操作失败，请重新申请临时码；仍失败请联系主人。';
  }
  await message.send({
    format: commandBubble(text, '群密钥', {
      platform: event.Platform,
      actions: [
        { label: '查看状态', command: '/群密钥 状态' },
        { label: '额度教程', command: '/帮助 额度' }
      ]
    })
  });
};
