import { commandBubble, sectionBubble } from '../bubble';
import { useEvent, useMessage, useRoute } from 'alemonjs';
import { bindPersonalKey, claimPersonalKeyCommand, personalKeyStatus, updatePersonalKey } from '../../credentials/personal';
import { getConversationId } from '../dsh/util';
import { personalKeyGuide } from '../../billing/help';

export default async (): Promise<void> => {
  const [context] = useEvent({ selects: ['message.create', 'private.message.create'] });

  if (!context.match.selects) return;
  const event = context.current;
  const [message] = useMessage();
  const [route] = useRoute();
  let text: string;

  if (!event.IsPrivate || !event.Platform || !event.UserId) {
    text = '请在本人私聊管理 Key。若误发到群，请撤回并在服务商后台更换。';
  } else {
    const scope = { platform: event.Platform, userId: event.UserId, channelId: getConversationId(event) };
    const args = route.rawArgs.map(String);

    try {
      if (['绑定', '启用', '停用', '移除'].includes(args[0]) && !(await claimPersonalKeyCommand(scope, event.MessageId || ''))) {
        await message.send({
          format: commandBubble('这条指令已处理，请勿重复提交。', '个人密钥', {
            platform: event.Platform,
            actions: [{ label: '密钥状态', command: '/个人密钥 状态' }]
          })
        });

        return;
      }
      if (args[0] === '绑定' && args.length === 2) {
        await bindPersonalKey(scope, args[1]);
        text = '个人 Key 已绑定并启用，仅用于本人私聊。余额不足会停用并改用额度；充值后需手动启用。';
      } else if (args.length === 1 && ['启用', '停用', '移除'].includes(args[0])) {
        const action = { 启用: 'enable', 停用: 'disable', 移除: 'remove' } as const;
        const changed = await updatePersonalKey(scope, action[args[0]]);

        text = changed ? `个人 Key 已${args[0]}。${args[0] === '启用' ? '下一次请求会检查余额并优先使用。' : '后续请求使用额度模式。'}` : '尚未绑定个人 Key。';
      } else if (!args.length || (args.length === 1 && args[0] === '状态')) {
        const status = await personalKeyStatus(scope);
        const state = !status.bound ? '未绑定' : status.enabled ? '已启用，私聊优先使用' : status.reason === 'balance' ? '余额不足，已自动停用' : '已停用';
        const sections = [
          {
            title: '状态',
            text: state,
            actions: status.bound
              ? [
                  status.enabled ? { label: '停用', command: '/个人密钥 停用' } : { label: '启用', command: '/个人密钥 启用' },
                  { label: '移除', command: '/个人密钥 移除' }
                ]
              : [{ label: '绑定说明', command: '/个人密钥 绑定' }]
          },
          { title: '用途', text: '仅本人私聊；启用后优先使用 Key，不扣内部额度。' },
          {
            title: '下一步',
            text: !status.bound
              ? '私聊发送 /个人密钥 绑定 sk-你的Key。'
              : status.enabled
                ? '充值后如欠费停用，再发送 /个人密钥 启用。'
                : status.reason === 'balance'
                  ? '充值后发送 /个人密钥 启用。'
                  : '可重新启用或移除。',
            actions: [{ label: '额度', command: '/额度' }]
          },
          { title: '更多', text: '', actions: [{ label: '刷新', command: '/个人密钥 状态' }] }
        ];

        await message.send({ format: sectionBubble('个人密钥', '仅本人私聊。', sections, { platform: event.Platform, layout: 'inline' }) });

        return;
      } else text = personalKeyGuide;
    } catch {
      // Never echo raw arguments, provider errors, or storage exceptions.
      text = '个人 Key 操作失败，请检查格式；仍失败请联系主人。';
    }
  }
  await message.send({
    format: commandBubble(text, '个人密钥', {
      platform: event.Platform,
      actions: [
        { label: '密钥状态', command: '/个人密钥 状态' },
        { label: '额度', command: '/额度' },
        { label: '额度教程', command: '/帮助 额度' }
      ]
    })
  });
};
