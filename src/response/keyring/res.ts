import { useEvent, useMessage } from 'alemonjs';
import { commandBubble, sectionBubble } from '../bubble';
import { getConversationId } from '../dsh/util';
import { verifyGroupKeyAdmin } from '../../credentials/group-admin';
import { readKeyring, changeKeyring } from '../../credentials/keyring';
import { bindPersonalKey, personalKeyStatus, updatePersonalKey } from '../../credentials/personal';
import { DSHError } from '../../dsh/errors';

export default async (): Promise<void> => {
  const [context] = useEvent({ selects: ['message.create', 'private.message.create'] });

  if (!context.match.selects) return;
  const event = context.current;
  const [message] = useMessage();

  await handleKeyringCommand(event, message);
};

export const handleKeyringCommand = async (event: ReturnType<typeof useEvent>[0]['current'], message: ReturnType<typeof useMessage>[0]): Promise<void> => {
  const [command, ...args] = (event.MessageText || '').trim().split(/\s+/u);
  const scope = { platform: event.Platform || '', userId: event.UserId || '', channelId: getConversationId(event) };
  let text = '';
  let actions: { label: string; command: string }[] = [{ label: '我的钥匙', command: '/我的钥匙' }];

  try {
    if (['/个人密钥', '/apikey', '/群密钥', '/groupapikey'].includes(command)) {
      await message.send({
        format: commandBubble('旧密钥入口已停用，请使用 /我的钥匙；群授权通过 /授权钥匙 编号，私聊 /授权记录 可撤销。', '我的钥匙', {
          platform: event.Platform,
          actions: [{ label: '我的钥匙', command: '/我的钥匙' }]
        })
      });

      return;
    }
    if (!event.IsPrivate && !(await verifyGroupKeyAdmin(event))) throw new DSHError('budget', '仅本群管理员可查看和授权群聊钥匙。');
    if (command === '/授权记录') {
      if (!event.IsPrivate) throw new DSHError('budget', '请私聊查看授权记录。');
      if (args.length === 2 && args[0] === '移除') {
        await changeKeyring(scope, 'revoke', args[1]);
        text = '授权已移除，对应群副本已撤销；已发出的请求可能继续完成。';
      } else if (!args.length) {
        const { ring } = await readKeyring(scope);

        const sections = ring.grants.length
          ? ring.grants.map(item => ({
              title: `记录 ${item.id}`,
              text: `群 ${item.channelId} · 钥匙 ${item.keyId}`,
              actions: [{ label: '移除授权', command: `/授权记录 移除 ${item.id}` }]
            }))
          : [
              {
                title: '还没有授权',
                text: '在目标群发 /授权钥匙 编号 后，这里会出现记录。',
                actions: [{ label: '我的钥匙', command: '/我的钥匙' }]
              }
            ];

        await message.send({ format: sectionBubble('授权记录', '仅本人可查。', sections, { platform: event.Platform }) });

        return;
      } else throw new DSHError('budget', '用法：/授权记录 或 /授权记录 移除 编号');
    } else if (command === '/授权钥匙') {
      if (event.IsPrivate || args.length !== 1) throw new DSHError('budget', '请管理员在目标群发送 /授权钥匙 编号。');
      await changeKeyring(scope, 'grant', args[0]);
      text = '本群钥匙已授权。';
    } else if (event.IsPrivate && args[0] === '私聊') {
      if (args[1] === '添加' && args.length === 3) {
        await bindPersonalKey(scope, args[2]);
        text = '私聊钥匙 1 已保存，仅用于本人私聊。';
      } else if (args.length === 2 && ['启用', '停用', '移除'].includes(args[1])) {
        const changed = await updatePersonalKey(scope, ({ 启用: 'enable', 停用: 'disable', 移除: 'remove' } as const)[args[1]]);

        text = changed ? '私聊钥匙状态已更新。' : '暂无私聊钥匙。';
      } else {
        const status = await personalKeyStatus(scope);

        text = `${status.bound ? `私聊钥匙 1：${status.enabled ? '启用' : '停用'}` : '暂无私聊钥匙'}\n/我的钥匙 私聊 添加 sk-你的Key\n/我的钥匙 私聊 启用（或停用、移除）`;
        actions = status.bound
          ? [
              { label: status.enabled ? '停用' : '启用', command: `/我的钥匙 私聊 ${status.enabled ? '停用' : '启用'}` },
              { label: '移除', command: '/我的钥匙 私聊 移除' },
              { label: '额度', command: '/额度' }
            ]
          : [
              { label: '添加钥匙', command: '/我的钥匙 私聊 添加 sk-你的Key' },
              { label: '个人登录', command: '/个人登录' }
            ];
      }
    } else if (event.IsPrivate && args[0] === '群聊' && args[1] === '添加' && args.length === 3) {
      await changeKeyring(scope, 'add', args[2]);
      text = '群聊钥匙已保存，请到目标群查看 /我的钥匙 并授权。';
      actions = [{ label: '我的钥匙', command: '/我的钥匙' }];
    } else if (!args.length || (event.IsPrivate && args.length === 1 && args[0] === '群聊')) {
      const { ring } = await readKeyring(scope);
      const sections = ring.keys.length
        ? ring.keys.map(item => ({
            title: `钥匙 ${item.id}`,
            text: item.value.auth === 'account' ? '群聊专用 · 扫码账户' : '群聊专用',
            actions: event.IsPrivate ? [] : [{ label: '授权钥匙', command: `/授权钥匙 ${item.id}` }]
          }))
        : [
            {
              title: event.IsPrivate ? '还没有钥匙' : '还没有可用钥匙',
              text: event.IsPrivate ? '可以先扫码准备，或手动添加群聊钥匙。' : '请先私聊机器人添加群聊钥匙，再回本群授权。',
              actions: []
            }
          ];

      if (event.IsPrivate) {
        sections.push({
          title: '添加或登录',
          text: '扫码可同时准备私聊和群聊钥匙。',
          actions: [
            { label: '个人登录', command: '/个人登录' },
            { label: '添加群聊钥匙', command: '/我的钥匙 群聊 添加 sk-你的Key' },
            { label: '授权记录', command: '/授权记录' }
          ]
        });
      }

      await message.send({
        format: sectionBubble('我的钥匙', event.IsPrivate ? '仅本人可查。' : '仅显示你的群聊钥匙编号。', sections, { platform: event.Platform })
      });

      return;
    } else text = '请使用 /我的钥匙；密钥只在私聊添加。';
  } catch (error) {
    text = error instanceof DSHError ? error.message : '钥匙操作失败，请稍后重试。';
  }
  await message.send({ format: commandBubble(text, '我的钥匙', { platform: event.Platform, actions }) });
};
